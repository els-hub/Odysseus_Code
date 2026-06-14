# src/coding_git.py
"""Structured git tools for the coding agent: git_status, git_diff,
git_commit, git_create_pr. All run inside the session workspace and return
dispatcher-shaped result dicts ({"output"/"error", "exit_code", "diff"?}).

Safety rails (enforced here, not just in the prompt):
- git_commit on main/master is HARD-BLOCKED.
- git_commit never runs a blind `git add .` — caller passes {"add": [paths]}
  or {"all": true} explicitly.
- git_create_pr uses the gh CLI; auth errors are surfaced, not retried.
"""
from __future__ import annotations
import asyncio
import json
import logging

logger = logging.getLogger(__name__)

_PROTECTED_BRANCHES = {"main", "master"}
_GIT_TIMEOUT = 30
_PR_TIMEOUT = 60


async def _run(argv: list[str], cwd: str, timeout: int = _GIT_TIMEOUT) -> tuple[str, str, int]:
    """Run a command without shell, capture output."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, cwd=cwd,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return (out.decode("utf-8", "replace"), err.decode("utf-8", "replace"),
                proc.returncode or 0)
    except asyncio.TimeoutError:
        return "", f"timed out after {timeout}s", 124
    except (FileNotFoundError, NotADirectoryError, OSError) as exc:
        return "", str(exc), 127


def _parse_args(content: str) -> dict:
    try:
        data = json.loads(content) if content.strip().startswith("{") else {}
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, ValueError):
        return {}


async def _current_branch(workspace: str) -> str:
    out, _, code = await _run(["git", "rev-parse", "--abbrev-ref", "HEAD"], workspace)
    return out.strip() if code == 0 else ""


async def git_tool(tool: str, content: str, workspace: str) -> dict:
    """Dispatch one structured git tool. Returns a result dict."""
    if not workspace:
        return {"error": "No workspace set for this session.", "exit_code": 1}
    args = _parse_args(content)

    if tool == "git_status":
        branch = await _current_branch(workspace)
        out, err, code = await _run(["git", "status", "--short"], workspace)
        if code != 0:
            return {"error": err or "git status failed", "exit_code": code}
        header = f"branch: {branch or 'unknown'}"
        if branch in _PROTECTED_BRANCHES:
            header += "  ⚠ protected — create a feature branch before committing"
        return {"output": f"{header}\n{out.strip() or '(clean working tree)'}",
                "exit_code": 0}

    if tool == "git_diff":
        argv = ["git", "diff"]
        if args.get("staged"):
            argv.append("--cached")
        else:
            # intent-to-add so newly-written (untracked) files appear in the diff
            await _run(["git", "add", "-N", "-A"], workspace)
        if args.get("path"):
            argv += ["--", str(args["path"])]
        out, err, code = await _run(argv, workspace)
        if code != 0:
            return {"error": err or "git diff failed", "exit_code": code}
        text = out[:60_000]
        if not text.strip():
            return {"output": "(no changes)", "exit_code": 0}
        added   = sum(1 for l in text.splitlines() if l.startswith("+") and not l.startswith("+++"))
        removed = sum(1 for l in text.splitlines() if l.startswith("-") and not l.startswith("---"))
        return {"output": f"+{added} −{removed}", "exit_code": 0,
                "diff": {"text": text, "added": added, "removed": removed,
                         "file": str(args.get("path") or "")}}

    if tool == "git_commit":
        message = str(args.get("message") or "").strip()
        if not message:
            return {"error": "git_commit requires {\"message\": \"...\"}", "exit_code": 1}
        branch = await _current_branch(workspace)
        if branch in _PROTECTED_BRANCHES:
            return {"error": f"BLOCKED: refusing to commit on protected branch "
                             f"'{branch}'. Create a feature branch first "
                             f"(bash: git checkout -b <name>).", "exit_code": 1}
        if args.get("add"):
            paths = [str(p) for p in args["add"] if str(p).strip()]
            if paths:
                _, err, code = await _run(["git", "add", "--", *paths], workspace)
                if code != 0:
                    return {"error": f"git add failed: {err}", "exit_code": code}
        elif args.get("all"):
            _, err, code = await _run(["git", "add", "-A"], workspace)
            if code != 0:
                return {"error": f"git add -A failed: {err}", "exit_code": code}
        out, err, code = await _run(["git", "commit", "-m", message], workspace)
        if code != 0:
            return {"error": err or out or "git commit failed", "exit_code": code}
        return {"output": out.strip(), "exit_code": 0}

    if tool == "git_create_pr":
        title = str(args.get("title") or "").strip()
        body  = str(args.get("body") or "").strip()
        if not title:
            return {"error": "git_create_pr requires {\"title\": \"...\", \"body\": \"...\"}",
                    "exit_code": 1}
        branch = await _current_branch(workspace)
        if branch in _PROTECTED_BRANCHES:
            return {"error": f"BLOCKED: cannot open a PR from '{branch}'. "
                             f"Create a feature branch with your changes first.",
                    "exit_code": 1}
        # Push the branch first so gh has a remote ref to target.
        _, perr, pcode = await _run(["git", "push", "-u", "origin", branch],
                                    workspace, timeout=_PR_TIMEOUT)
        if pcode != 0:
            return {"error": f"git push failed: {perr}", "exit_code": pcode}
        out, err, code = await _run(
            ["gh", "pr", "create", "--title", title, "--body", body],
            workspace, timeout=_PR_TIMEOUT)
        if code != 0:
            return {"error": err or out or "gh pr create failed (is gh authenticated?)",
                    "exit_code": code}
        return {"output": out.strip(), "exit_code": 0}

    return {"error": f"Unknown git tool: {tool}", "exit_code": 1}
