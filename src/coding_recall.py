# src/coding_recall.py
"""Session-recall store — the second half of the "effective 100K context".

The code-graph (src/code_graph.py) lets the model REACH a huge codebase. This lets it
REACH its own past work in a long session: decisions, files it read, tool results, errors,
and even its thinking — after those turns have been pruned/compacted out of the live window.

Deterministic, 0-VRAM, no embeddings — SQLite FTS5 full-text search (validated by Engram /
AIngram / recuerd0: keyword recall beats vector DBs for exact technical terms, with no
embedding model to host on the GPU). Falls back to LIKE if FTS5 isn't compiled in.

Flow: every turn, `capture_turn` stores the pieces; the model calls the `recall` tool
({"query": "..."}) to search them; results are injected as a compact block.
"""
from __future__ import annotations
import os
import re
import sqlite3
from pathlib import Path


def _db_path(session_id: str) -> str:
    try:
        from src.constants import DATA_DIR
        base = str(DATA_DIR)
    except Exception:
        base = os.path.join(os.path.expanduser("~"), ".odysseus")
    return os.path.join(base, "recall", f"{session_id}.db")


def _has_fts5(con: sqlite3.Connection) -> bool:
    try:
        con.execute("CREATE VIRTUAL TABLE IF NOT EXISTS _fts_probe USING fts5(x)")
        con.execute("DROP TABLE IF EXISTS _fts_probe")
        return True
    except sqlite3.OperationalError:
        return False


def _connect(session_id: str) -> tuple[sqlite3.Connection, bool]:
    path = _db_path(session_id)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    fts = _has_fts5(con)
    if fts:
        con.execute("CREATE VIRTUAL TABLE IF NOT EXISTS mem "
                    "USING fts5(kind, title, body, round UNINDEXED)")
    else:
        con.execute("CREATE TABLE IF NOT EXISTS mem "
                    "(kind TEXT, title TEXT, body TEXT, round INTEGER)")
    con.commit()
    return con, fts


def remember(session_id: str, kind: str, title: str, body: str, round_: int = 0) -> None:
    """Store one memory entry. Bodies are truncated to keep the store lean."""
    body = (body or "").strip()
    if not body:
        return
    con, _ = _connect(session_id)
    try:
        con.execute("INSERT INTO mem(kind,title,body,round) VALUES(?,?,?,?)",
                    (kind, (title or "")[:120], body[:2500], int(round_)))
        con.commit()
    finally:
        con.close()


def capture_turn(session_id: str, round_: int, *, user_msg: str = "",
                 thinking: str = "", response: str = "", tool_results=None) -> None:
    """Auto-store every piece of a turn so it's recallable after pruning/compaction."""
    if user_msg.strip():
        remember(session_id, "user", "user request", user_msg, round_)
    if thinking.strip():
        remember(session_id, "thought", "reasoning", thinking, round_)
    if response.strip():
        remember(session_id, "answer", "assistant decision/answer", response, round_)
    for tr in (tool_results or []):
        # tr: (tool_name, output_text)
        try:
            name, out = tr
        except Exception:
            continue
        if out and str(out).strip():
            remember(session_id, "tool", f"{name} result", str(out), round_)


def _fts_query(q: str) -> str:
    """Build a safe FTS5 MATCH expression: OR the alphanumeric terms, quoted."""
    terms = re.findall(r"[A-Za-z0-9_]{2,}", q or "")
    if not terms:
        return ""
    return " OR ".join(f'"{t}"' for t in terms[:12])


def recall(session_id: str, query: str, limit: int = 6) -> str:
    """Search the session store and return a compact block for prompt injection."""
    if not os.path.exists(_db_path(session_id)):
        return "[recall] nothing stored yet this session."
    con, fts = _connect(session_id)
    rows = []
    try:
        if fts:
            expr = _fts_query(query)
            if expr:
                rows = con.execute(
                    "SELECT kind,title,body,round FROM mem WHERE mem MATCH ? "
                    "ORDER BY rank LIMIT ?", (expr, limit)).fetchall()
        if not rows:  # fallback / no FTS match → LIKE on the longest term
            terms = sorted(re.findall(r"[A-Za-z0-9_]{3,}", query or ""), key=len, reverse=True)
            if terms:
                rows = con.execute(
                    "SELECT kind,title,body,round FROM mem WHERE body LIKE ? "
                    "ORDER BY round DESC LIMIT ?", (f"%{terms[0]}%", limit)).fetchall()
    except sqlite3.OperationalError:
        rows = []
    finally:
        con.close()
    if not rows:
        return f"[recall] no earlier entry matching '{query}'."
    out = [f"[recall] {len(rows)} earlier entr(ies) matching '{query}':"]
    for kind, title, body, rnd in rows:
        snippet = re.sub(r"\s+", " ", body)[:400]
        out.append(f"  • (round {rnd}, {kind}) {title}: {snippet}")
    return "\n".join(out)


def status(session_id: str) -> dict:
    if not os.path.exists(_db_path(session_id)):
        return {"entries": 0}
    con, _ = _connect(session_id)
    try:
        n = con.execute("SELECT COUNT(*) FROM mem").fetchone()[0]
        b = con.execute("SELECT COALESCE(SUM(LENGTH(body)),0) FROM mem").fetchone()[0]
    finally:
        con.close()
    return {"entries": n, "recall_tokens_est": int(b / 3.6)}


if __name__ == "__main__":
    import json
    sid = "selftest"
    try:
        os.remove(_db_path(sid))
    except OSError:
        pass
    capture_turn(sid, 1, user_msg="add rate limiting to the API",
                 thinking="user wants redis token-bucket limiter",
                 response="Chose token-bucket with redis backend",
                 tool_results=[("read_file", "def handle(req): return ok")])
    capture_turn(sid, 2, response="Implemented limiter in api/limits.py with 100 req/min")
    print("STATUS:", json.dumps(status(sid)))
    print(recall(sid, "redis rate limiter"))
    print(recall(sid, "limits.py"))
