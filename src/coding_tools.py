# src/coding_tools.py
"""
Workspace-scoped tool executor for the Coding tool.
Wraps execute_tool_block with path sandboxing + adds todo_read/todo_write/repo_map.
"""
from __future__ import annotations
import ast, json, re
from pathlib import Path
from typing import Optional

from src.agent_tools import ToolBlock, execute_tool_block

# Self-register the coding tool tags so the host's fence parser recognizes them WITHOUT
# the installer editing agent_tools.py — keeps Odysseus_Code a clean drop-in add-on.
try:
    from src.agent_tools import TOOL_TAGS as _TT
    _TT |= {"repo_map", "code_graph", "recall", "todo_read", "todo_write",
            "git_status", "git_diff", "git_commit", "git_create_pr"}
except Exception:
    pass


def _validate_path(path_str: str, workspace: str) -> Optional[str]:
    """Return error string if path escapes workspace, None if OK."""
    if not workspace:
        return None
    try:
        base   = Path(workspace).resolve()
        target = (base / path_str).resolve()
        target.relative_to(base)
        return None
    except ValueError:
        return f"Path {path_str!r} is outside workspace {workspace!r}"


def load_claude_skills(root_path: str) -> str:
    """Claude-compat skills v1: read `<workspace>/.claude/skills/*/SKILL.md`
    (the Claude Code format — YAML frontmatter w/ name+description) and return
    a prompt section so workspace skills work in the coding tab too."""
    if not root_path:
        return ""
    out = []
    try:
        for p in sorted(Path(root_path).glob(".claude/skills/*/SKILL.md"))[:10]:
            text = p.read_text(encoding="utf-8", errors="replace")
            name = p.parent.name
            m = re.search(r"^name:\s*(.+)$", text, re.MULTILINE)
            if m:
                name = m.group(1).strip()
            body = re.sub(r"^---[\s\S]*?---\s*", "", text)[:1500]
            out.append(f"### Skill: {name}\n{body}")
    except OSError:
        return ""
    return "\n\n".join(out)


def load_claude_commands(root_path: str) -> list:
    """Claude-compat slash commands: read `<workspace>/.claude/commands/**/*.md`
    (the Claude Code format — optional YAML frontmatter w/ description, body is a
    prompt template with $ARGUMENTS / $1 $2 placeholders). Returns a list of
    {name, description, body} for the `/` menu. Nested dirs namespace with ':'
    (e.g. .claude/commands/frontend/comp.md → 'frontend:comp')."""
    if not root_path:
        return []
    base = Path(root_path) / ".claude" / "commands"
    if not base.is_dir():
        return []
    out = []
    try:
        for p in sorted(base.rglob("*.md"))[:50]:
            rel = p.relative_to(base).with_suffix("")
            name = ":".join(rel.parts)
            text = p.read_text(encoding="utf-8", errors="replace")
            desc = name
            m = re.search(r"^description:\s*(.+)$", text, re.MULTILINE)
            if m:
                desc = m.group(1).strip().strip('"\'')
            body = re.sub(r"^---[\s\S]*?---\s*", "", text).strip()
            out.append({"name": name, "description": desc[:80], "body": body})
    except OSError:
        return []
    return out


def expand_claude_command(root_path: str, message: str) -> Optional[str]:
    """If `message` is `/<command> [args]` and a workspace `.claude/commands/<command>.md`
    exists, return its body with $ARGUMENTS / $1.. substituted. Else None (not a command)."""
    if not root_path or not message.startswith("/"):
        return None
    parts = message[1:].split(maxsplit=1)
    if not parts:
        return None
    name = parts[0]
    args = parts[1] if len(parts) > 1 else ""
    rel = name.replace(":", "/")
    p = Path(root_path) / ".claude" / "commands" / f"{rel}.md"
    if not p.is_file():
        return None
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    body = re.sub(r"^---[\s\S]*?---\s*", "", text).strip()
    body = body.replace("$ARGUMENTS", args)
    argv = args.split()
    for i, a in enumerate(argv, start=1):
        body = body.replace(f"${i}", a)
    return body


def _load_hooks(root_path: str) -> list:
    """Claude-compat hooks v1: `<workspace>/.claude/settings.json` →
    hooks.PreToolUse / hooks.PostToolUse, each [{matcher, hooks:[{command}]}].
    Returns [(event, matcher_regex, command)]."""
    cfg = Path(root_path or "") / ".claude" / "settings.json"
    if not cfg.exists():
        return []
    try:
        data = json.loads(cfg.read_text(encoding="utf-8"))
        out = []
        for event in ("PreToolUse", "PostToolUse"):
            for entry in (data.get("hooks", {}).get(event) or []):
                matcher = entry.get("matcher", "") or ".*"
                for h in entry.get("hooks", []):
                    if h.get("type") == "command" and h.get("command"):
                        out.append((event, matcher, h["command"]))
        return out
    except (ValueError, OSError):
        return []


async def _run_hooks(event: str, tool: str, workspace: str, payload: str) -> Optional[str]:
    """Run matching hook commands. PreToolUse exit code 2 blocks the tool
    (Claude Code convention) — its stderr becomes the error message."""
    import asyncio as _aio
    import os as _os
    for ev, matcher, command in _load_hooks(workspace):
        if ev != event:
            continue
        try:
            if not re.fullmatch(matcher, tool):
                continue
        except re.error:
            continue
        try:
            proc = await _aio.create_subprocess_shell(
                command, cwd=workspace,
                stdout=_aio.subprocess.PIPE, stderr=_aio.subprocess.PIPE,
                env={**_os.environ, "TOOL_NAME": tool,
                     "TOOL_INPUT": payload[:2000], "HOOK_EVENT": event})
            out, err = await _aio.wait_for(proc.communicate(), timeout=15)
            if event == "PreToolUse" and proc.returncode == 2:
                return (err or out).decode("utf-8", "replace")[:400] or \
                       f"blocked by {event} hook"
        except Exception:
            continue
    return None


def load_claude_md(root_path: str) -> str:
    """Return contents of CLAUDE.md at workspace root, capped at 6000 chars."""
    if not root_path:
        return ""
    p = Path(root_path) / "CLAUDE.md"
    if not p.exists():
        return ""
    try:
        return p.read_text(encoding="utf-8")[:6000]
    except Exception:
        return ""


def _map_python_file(path: Path, workspace: str) -> list[str]:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    except SyntaxError:
        return []
    rel = str(path.relative_to(workspace))
    lines = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            prefix = "class " if isinstance(node, ast.ClassDef) else "def "
            lines.append(f"{rel}:{node.lineno}: {prefix}{node.name}")
    return lines


def _map_js_file(path: Path, workspace: str) -> list[str]:
    try:
        src = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return []
    rel = str(path.relative_to(workspace))
    lines = []
    for i, line in enumerate(src.splitlines(), 1):
        if re.match(r'\s*(export\s+)?(async\s+)?function\s+\w+', line) or \
           re.match(r'\s*(export\s+)?class\s+\w+', line) or \
           re.match(r'\s*(export\s+)?(const|let)\s+\w+\s*=\s*(async\s+)?\(', line):
            lines.append(f"{rel}:{i}: {line.strip()[:80]}")
    return lines


def repo_map(workspace: str, max_lines: int = 200) -> str:
    """Return a condensed map of the workspace: every class/function with file:line."""
    if not workspace or not Path(workspace).is_dir():
        return "No workspace set."

    SKIP_DIRS = {"node_modules", "venv", ".venv", "__pycache__", ".git",
                 "dist", "build", ".mypy_cache", ".pytest_cache"}
    entries: list[str] = []

    root = Path(workspace)
    for path in sorted(root.rglob("*")):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if not path.is_file():
            continue
        if path.suffix == ".py":
            entries.extend(_map_python_file(path, workspace))
        elif path.suffix in {".js", ".ts", ".jsx", ".tsx"}:
            entries.extend(_map_js_file(path, workspace))

    if not entries:
        return "No Python/JS files found in workspace."

    result = entries[:max_lines]
    suffix = f"\n... ({len(entries) - max_lines} more entries truncated)" \
             if len(entries) > max_lines else ""
    return "\n".join(result) + suffix


def _todo_read(todo: list) -> str:
    if not todo:
        return "No todos."
    lines = []
    for t in todo:
        status = t.get("status", "pending")
        icon   = "✓" if status == "done" else ("▶" if status == "in_progress" else "○")
        lines.append(f"{icon} [{t.get('id','?')}] {t.get('text','')}")
    return "\n".join(lines)


def _todo_write(todo_list: list, content: str) -> tuple[list, str]:
    try:
        data  = json.loads(content)
        todos = data.get("todos", data) if isinstance(data, dict) else data
        if not isinstance(todos, list):
            return todo_list, "Error: expected {\"todos\": [...]}"
        return todos, f"Updated {len(todos)} todo(s)."
    except json.JSONDecodeError as exc:
        return todo_list, f"Error parsing todos: {exc}"


# Tools that mutate files / state. Blocked in read-only modes (ask, plan).
_WRITE_TOOLS = {"write_file", "edit_file", "bash", "python",
                "git_commit", "git_create_pr"}
_READONLY_MODES = {"ask", "plan"}


async def execute_coding_tool(
    block: ToolBlock,
    workspace: str,
    todo: list,
    owner: str = "default",
    session_id: Optional[str] = None,
    progress_cb=None,
    mode: str = "auto",
) -> tuple[str, dict, list]:
    """Execute a tool block in a coding session.

    Returns (description, result_dict, updated_todo). result_dict is the
    dispatcher's structured result — it may carry "output"/"error"/"diff"
    keys that the agent loop turns into SSE events.
    """
    tool = block.tool_type

    # Claude-compat PreToolUse hooks (workspace .claude/settings.json):
    # exit code 2 from a matching hook blocks the tool.
    if workspace:
        block_reason = await _run_hooks("PreToolUse", tool, workspace, block.content)
        if block_reason:
            return (f"{tool}: blocked by hook",
                    {"error": f"PreToolUse hook blocked this call: {block_reason}",
                     "exit_code": 1}, todo)

    # Mode gate: Ask/Plan are read-only. Reads, searches, repo_map, todos and
    # git_status/git_diff stay allowed; anything that mutates is rejected with
    # an instructive error so the model re-plans instead of retrying blindly.
    if mode in _READONLY_MODES and tool in _WRITE_TOOLS:
        return (f"{tool}: blocked",
                {"error": f"Tool '{tool}' is not allowed in {mode.capitalize()} "
                          f"mode (read-only). Present the plan/answer instead; "
                          f"the user can switch to Auto/Accept mode to execute.",
                 "exit_code": 1}, todo)

    if tool == "todo_read":
        return "todo_read", {"output": _todo_read(todo), "exit_code": 0}, todo

    if tool == "todo_write":
        updated, msg = _todo_write(todo, block.content)
        ok = not msg.startswith("Error")
        return "todo_write", {"output" if ok else "error": msg,
                              "exit_code": 0 if ok else 1}, updated

    if tool == "repo_map":
        try:
            args = json.loads(block.content) if block.content.strip().startswith("{") else {}
        except Exception:
            args = {}
        out = repo_map(workspace, max_lines=args.get("max_lines", 200))
        return "repo_map", {"output": out, "exit_code": 0}, todo

    if tool == "recall":
        # Session-recall store (src/coding_recall.py): search this session's own
        # past work (decisions, tool results, files read, errors, thinking) after
        # it has been pruned/compacted out of the live window. The other half of
        # the "effective 100K context" — recall of the model's work, not the code.
        try:
            args = json.loads(block.content) if block.content.strip().startswith("{") else \
                ({"query": block.content.strip()} if block.content.strip() else {})
        except Exception:
            args = {"query": block.content.strip()}
        q = str(args.get("query") or args.get("q") or "").strip()
        if not q:
            return "recall", {"error": "recall needs a query: {\"query\": \"...\"}",
                              "exit_code": 1}, todo
        try:
            from src import coding_recall as _rc
            out = _rc.recall(session_id or "default", q, limit=int(args.get("limit", 6)))
            return "recall", {"output": out, "exit_code": 0}, todo
        except Exception as e:
            return "recall", {"error": f"recall failed: {e}", "exit_code": 1}, todo

    if tool == "code_graph":
        # Deterministic symbol graph (the "effective 100K context" engine): query a
        # huge codebase precisely instead of reading whole files into the window.
        try:
            args = json.loads(block.content) if block.content.strip().startswith("{") else \
                ({"symbol": block.content.strip()} if block.content.strip() else {})
        except Exception:
            args = {"symbol": block.content.strip()}
        if not workspace:
            return "code_graph", {"error": "No workspace connected — connect a folder first.",
                                  "exit_code": 1}, todo
        try:
            from src import code_graph as _cg
            out = _cg.query(
                workspace,
                symbol=str(args.get("symbol", "")),
                file=str(args.get("file", "")),
                search_term=str(args.get("search", "")),
                want_status=bool(args.get("status", False)),
            )
            return "code_graph", {"output": out, "exit_code": 0}, todo
        except Exception as e:
            return "code_graph", {"error": f"code_graph failed: {e}", "exit_code": 1}, todo

    if tool in ("git_status", "git_diff", "git_commit", "git_create_pr"):
        # Route git tools to our bundled, self-contained coding_git module rather than
        # relying on the host dispatcher having a git branch (a vanilla Odysseus doesn't).
        if not workspace:
            return tool, {"error": "No workspace connected — connect a folder first.",
                          "exit_code": 1}, todo
        try:
            from src.coding_git import git_tool
            result = await git_tool(tool, block.content, workspace)
            return tool, result, todo
        except Exception as e:
            return tool, {"error": f"{tool} failed: {e}", "exit_code": 1}, todo

    PATH_TOOLS = {"read_file", "write_file", "edit_file", "glob", "grep", "ls"}
    if tool in PATH_TOOLS and workspace:
        try:
            args = json.loads(block.content) if block.content.strip().startswith("{") else {}
            path_key = "path" if "path" in args else ("pattern" if "pattern" in args else None)
            if path_key and args.get(path_key):
                err = _validate_path(str(args[path_key]), workspace)
                if err:
                    return f"{tool}: blocked", {"error": err, "exit_code": 1}, todo
        except Exception:
            pass

    # Full dispatcher: unlocks bash, web_search, web_fetch, MCP (mcp__*),
    # diffs, progress callbacks — everything Odysseus chat agents already have.
    desc, result = await execute_tool_block(
        block,
        session_id=session_id,
        owner=owner,
        progress_cb=progress_cb,
        workspace=workspace,
    )
    if workspace:
        await _run_hooks("PostToolUse", tool, workspace, block.content)
    return desc, result, todo
