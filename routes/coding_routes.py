# routes/coding_routes.py
"""Coding tool API — sessions CRUD + SSE chat + compact + memory extraction."""
from __future__ import annotations
import os, re, subprocess
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from src.auth_helpers import get_current_user
from src.coding_session import CodingSession, VALID_MODES
from src.ai_interaction import _resolve_model


class SessionCreate(BaseModel):
    name: str = "New Session"
    root_path: str = ""
    mode: str = "auto"

class SessionUpdate(BaseModel):
    name: Optional[str] = None
    root_path: Optional[str] = None
    mode: Optional[str] = None
    effort_level: Optional[int] = None
    model: Optional[str] = None
    num_ctx: Optional[int] = None

class ChatRequest(BaseModel):
    message: str
    model: str = ""
    file_attachments: list = []


def setup_coding_routes(
    memory_manager=None,
    skills_manager=None,
) -> APIRouter:
    """
    Pass memory_manager and skills_manager from app.py so the coding agent
    can load Brain memories and relevant skills for every session.
    """
    router = APIRouter(prefix="/api/coding")

    @router.get("/sessions")
    async def list_sessions(request: Request):
        get_current_user(request)
        return [s.to_summary() for s in CodingSession.list_all()]

    @router.post("/sessions")
    async def create_session(body: SessionCreate, request: Request):
        get_current_user(request)
        # Default workspace = the Odysseus repo the server runs from, so git
        # info and file tools work out of the box (Claude Desktop behavior).
        root = body.root_path or os.getcwd()
        s = CodingSession.create(name=body.name, root_path=root,
                                 mode=body.mode)
        s.save()
        return s.to_dict()

    @router.get("/sessions/{session_id}")
    async def get_session(session_id: str, request: Request):
        get_current_user(request)
        s = CodingSession.load(session_id)
        if not s:
            raise HTTPException(404, "Session not found")
        return s.to_dict()

    @router.put("/sessions/{session_id}")
    async def update_session(session_id: str, body: SessionUpdate, request: Request):
        get_current_user(request)
        s = CodingSession.load(session_id)
        if not s:
            raise HTTPException(404, "Session not found")
        if body.name is not None:
            s.name = body.name
        if body.root_path is not None:
            s.root_path = body.root_path
        if body.mode is not None:
            if body.mode not in VALID_MODES:
                raise HTTPException(400, f"Invalid mode: {body.mode}")
            s.mode = body.mode
        if body.effort_level is not None:
            if not (0 <= body.effort_level <= 4):
                raise HTTPException(400, "effort_level must be 0-4")
            s.effort_level = body.effort_level
        if body.model is not None:
            s.model = body.model
        if body.num_ctx is not None:
            if body.num_ctx and not (2048 <= body.num_ctx <= 131072):
                raise HTTPException(400, "num_ctx must be 2048-131072 (or 0 for default)")
            s.num_ctx = body.num_ctx
        s.save()
        return s.to_dict()

    @router.delete("/sessions/{session_id}")
    async def delete_session(session_id: str, request: Request):
        get_current_user(request)
        s = CodingSession.load(session_id)
        if not s:
            raise HTTPException(404, "Session not found")
        s.delete()
        return {"ok": True}

    @router.post("/sessions/{session_id}/chat")
    async def chat(session_id: str, body: ChatRequest, request: Request):
        owner = get_current_user(request)
        s = CodingSession.load(session_id)
        if not s:
            raise HTTPException(404, "Session not found")

        # Priority: explicit request model → session's saved model → default.
        model_spec = body.model or s.model or ""
        try:
            endpoint_url, model_id, headers = _resolve_model(model_spec, owner)
        except Exception:
            endpoint_url, model_id, headers = _resolve_model("", owner)

        from src.coding_agent import stream_coding_agent

        async def generate():
            async for chunk in stream_coding_agent(
                session=s,
                new_message=body.message,
                model=model_id,
                endpoint_url=endpoint_url,
                headers=headers,
                file_attachments=body.file_attachments,
                owner=owner,
                memory_manager=memory_manager,
                skills_manager=skills_manager,
            ):
                yield chunk

        return StreamingResponse(generate(), media_type="text/event-stream")

    @router.post("/sessions/{session_id}/compact")
    async def compact_session(session_id: str, request: Request):
        """
        Manually trigger context compaction for a session.
        Called by the /compact slash command from the frontend.
        """
        owner = get_current_user(request)
        s = CodingSession.load(session_id)
        if not s:
            raise HTTPException(404, "Session not found")
        if not s.messages:
            return {"ok": True, "compacted": 0}

        model_spec = ""
        try:
            endpoint_url, model_id, headers = _resolve_model(model_spec, owner)
        except Exception:
            return {"ok": False, "error": "Could not resolve model"}

        from src.coding_agent import compact_history
        original_count = len(s.messages)
        s.messages = await compact_history(
            s.messages, s, endpoint_url, model_id, headers
        )
        s.save()
        return {"ok": True, "compacted": original_count - len(s.messages)}

    @router.post("/sessions/{session_id}/extract-memory")
    async def extract_memory(session_id: str, request: Request):
        """
        Extract learnings from a completed coding session and save to Brain.
        Called automatically when a session ends, or manually.
        """
        owner = get_current_user(request)
        if not memory_manager:
            return {"ok": False, "error": "Memory not available"}
        s = CodingSession.load(session_id)
        if not s:
            raise HTTPException(404, "Session not found")

        model_spec = ""
        try:
            endpoint_url, model_id, headers = _resolve_model(model_spec, owner)
        except Exception:
            return {"ok": False, "error": "Could not resolve model"}

        from src.coding_agent import extract_coding_memory
        await extract_coding_memory(s, owner, endpoint_url, model_id, headers, memory_manager)
        return {"ok": True}

    @router.get("/sessions/{session_id}/git")
    async def git_info(session_id: str, request: Request):
        get_current_user(request)
        s = CodingSession.load(session_id)
        if not s or not s.root_path:
            return {"branch": "", "additions": 0, "deletions": 0, "repo": ""}
        info = _git_info(s.root_path)
        info["repo"] = Path(s.root_path).name
        return info

    @router.get("/sessions/{session_id}/git/diff")
    async def git_diff_text(session_id: str, request: Request):
        """Raw unified diff of the workspace (for the Views → Diff panel)."""
        get_current_user(request)
        s = CodingSession.load(session_id)
        if not s or not s.root_path:
            return {"diff": ""}
        try:
            # Intent-to-add so NEW (untracked) files the agent wrote show up — plain
            # `git diff` ignores untracked files, which made the panel look empty after
            # a write_file. `-N` is non-destructive (records the path, not the content).
            subprocess.run(["git", "add", "-N", "-A"], cwd=s.root_path, timeout=10,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            out = subprocess.check_output(
                ["git", "diff", "HEAD"],
                cwd=s.root_path, timeout=10, text=True,
                stderr=subprocess.DEVNULL, encoding="utf-8", errors="replace",
            )
            return {"diff": out[:200_000]}
        except Exception:
            return {"diff": ""}

    @router.get("/sessions/{session_id}/files")
    async def files_tree(session_id: str, request: Request):
        """Workspace file tree (for the Views → Files panel). Depth-limited."""
        get_current_user(request)
        s = CodingSession.load(session_id)
        if not s or not s.root_path or not Path(s.root_path).is_dir():
            return {"tree": []}
        SKIP = {".git", "node_modules", "__pycache__", ".venv", "venv",
                ".obsidian", "dist", "build", ".pytest_cache"}
        root = Path(s.root_path)

        def walk(d: Path, depth: int) -> list:
            if depth > 3:
                return []
            out = []
            try:
                entries = sorted(d.iterdir(),
                                 key=lambda p: (p.is_file(), p.name.lower()))
            except OSError:
                return []
            for p in entries[:200]:
                if p.name in SKIP or p.name.startswith("."):
                    continue
                if p.is_dir():
                    out.append({"name": p.name, "type": "dir",
                                "children": walk(p, depth + 1)})
                else:
                    out.append({"name": p.name, "type": "file"})
            return out

        return {"tree": walk(root, 0), "root": root.name}

    @router.post("/sessions/{session_id}/connect-repo")
    async def connect_repo(session_id: str, body: dict, request: Request):
        """Bind the session to a repo: {"path": "C:/..."} for a local folder,
        or {"github_url": "...", "branch": "..."} to clone via gh credentials."""
        get_current_user(request)
        s = CodingSession.load(session_id)
        if not s:
            raise HTTPException(404, "Session not found")

        path = (body.get("path") or "").strip()
        url  = (body.get("github_url") or "").strip()

        if path:
            p = Path(_host_to_container_path(path))
            if not p.is_dir():
                raise HTTPException(
                    400,
                    f"Not a directory (checked {p}). If you run Odysseus in Docker, set "
                    f"ODYSSEUS_HOST_MOUNT='<host_prefix>:<container_prefix>' so host paths "
                    f"map to the container mount (e.g. 'C:/Users/me:/mnt/host').")
            s.root_path = str(p.resolve())
            # Treat every connected folder as a local repo (user requirement):
            # init + snapshot so Diff/chip-bar/git tools work immediately.
            if not (p / ".git").exists():
                try:
                    for argv in (["git", "init"],
                                 ["git", "add", "-A"],
                                 ["git", "commit", "-m",
                                  "odysseus: initial snapshot", "--no-gpg-sign"]):
                        subprocess.run(argv, cwd=str(p), capture_output=True,
                                       timeout=120,
                                       env={**os.environ,
                                            "GIT_AUTHOR_NAME": "odysseus",
                                            "GIT_AUTHOR_EMAIL": "odysseus@local",
                                            "GIT_COMMITTER_NAME": "odysseus",
                                            "GIT_COMMITTER_EMAIL": "odysseus@local"})
                except Exception:
                    pass  # diff view simply stays empty if init fails
        elif url:
            if not re.match(r"^https://github\.com/[\w.-]+/[\w.-]+/?$", url.rstrip(".git")):
                raise HTTPException(400, "Expected a https://github.com/<owner>/<repo> URL")
            from src.constants import DATA_DIR
            repos_dir = Path(DATA_DIR) / "coding_repos"
            repos_dir.mkdir(parents=True, exist_ok=True)
            name = url.rstrip("/").removesuffix(".git").split("/")[-1]
            dest = repos_dir / name
            if not dest.exists():
                argv = ["git", "clone", "--depth", "50", url, str(dest)]
                if body.get("branch"):
                    argv[2:2] = ["--branch", str(body["branch"])]
                try:
                    proc = subprocess.run(argv, capture_output=True, text=True,
                                          timeout=300)
                    if proc.returncode != 0:
                        raise HTTPException(400, f"git clone failed: "
                                                 f"{proc.stderr[-400:]}")
                except subprocess.TimeoutExpired:
                    raise HTTPException(408, "git clone timed out (5 min)")
            s.root_path = str(dest.resolve())
        else:
            raise HTTPException(400, "Provide \"path\" or \"github_url\"")

        s.save()
        # Pre-warm the code-graph index for this workspace (background, non-blocking).
        # The code_graph tool lazy-builds on first query anyway — this just makes the
        # first query instant. Any failure here never blocks connect. (Step 28c)
        try:
            import asyncio
            from src import code_graph as _cg
            asyncio.create_task(asyncio.to_thread(_cg.ensure_index, s.root_path, True))
        except Exception:
            pass
        info = _git_info(s.root_path)
        info["repo"] = Path(s.root_path).name
        info["root_path"] = s.root_path
        return info

    @router.get("/sessions/{session_id}/commands")
    async def workspace_commands(session_id: str, request: Request):
        """Workspace `.claude/commands/*.md` slash commands for the `/` menu."""
        get_current_user(request)
        s = CodingSession.load(session_id)
        if not s or not s.root_path:
            return {"commands": []}
        from src.coding_tools import load_claude_commands
        cmds = load_claude_commands(s.root_path)
        return {"commands": [{"name": c["name"], "description": c["description"]} for c in cmds]}

    @router.get("/mcp-tools")
    async def mcp_tools(request: Request):
        """Connected MCP tools for the '+' menu Connectors submenu."""
        get_current_user(request)
        from src.tool_utils import get_mcp_manager
        mgr = get_mcp_manager()
        if not mgr:
            return {"tools": []}
        try:
            tools = mgr.get_all_tools()
        except Exception:
            return {"tools": []}
        return {"tools": [
            {"qualified_name": t["qualified_name"],
             "server_name": t["server_name"],
             "name": t["name"],
             "description": (t.get("description") or "")[:160]}
            for t in tools if not t.get("is_disabled")
        ]}

    return router


def _host_to_container_path(p: str) -> str:
    """Translate a host path into the container mount, if Odysseus runs in Docker.
    Configured via env `ODYSSEUS_HOST_MOUNT='<host_prefix>:<container_prefix>'`
    (e.g. 'C:/Users/me:/mnt/host'). With no env set, the path is used as-is —
    correct for native installs and for in-container absolute paths."""
    import os
    s = p.strip().strip('"').replace("\\", "/")
    mapping = os.environ.get("ODYSSEUS_HOST_MOUNT", "").strip()
    if mapping and ":" in mapping:
        # split on the LAST ':' so a Windows drive prefix (C:/...) survives
        host_prefix, container_prefix = mapping.rsplit(":", 1)
        host_prefix = host_prefix.strip().replace("\\", "/").rstrip("/")
        container_prefix = container_prefix.strip().rstrip("/")
        if host_prefix and s.lower().startswith(host_prefix.lower()):
            return container_prefix + s[len(host_prefix):]
    return s


def _git_info(root_path: str) -> dict:
    try:
        branch = subprocess.check_output(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=root_path, timeout=5, text=True, stderr=subprocess.DEVNULL
        ).strip()
        # intent-to-add so the chip's +N/−M counts include new untracked files
        subprocess.run(["git", "add", "-N", "-A"], cwd=root_path, timeout=5,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        stat = subprocess.check_output(
            ["git", "diff", "--stat", "HEAD"],
            cwd=root_path, timeout=5, text=True, stderr=subprocess.DEVNULL
        )
        additions = sum(int(m) for m in re.findall(r"(\d+) insertion", stat))
        deletions  = sum(int(m) for m in re.findall(r"(\d+) deletion",  stat))
        return {"branch": branch, "additions": additions, "deletions": deletions}
    except Exception:
        return {"branch": "", "additions": 0, "deletions": 0}
