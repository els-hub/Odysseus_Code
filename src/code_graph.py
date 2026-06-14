# src/code_graph.py
"""Native code-graph for the coding agent — the "effective 100K context" engine.

Deterministic, 0-VRAM, no embeddings. Indexes a workspace into a per-workspace SQLite
graph of symbols (functions/classes/methods) and call edges, so the local model can
REACH a large codebase through precise queries instead of holding it in its 8K window.

Python is parsed precisely with the stdlib `ast` (defs, calls, imports). JS/TS/other
get lightweight regex symbol extraction. tree-sitter is the future multi-language upgrade.

Standalone-testable: every entry point accepts an explicit db_path / root so it runs on
the host without the Docker app env. Wiring into the agent dispatcher is Step 28b.
"""
from __future__ import annotations
import ast
import os
import re
import sqlite3
from pathlib import Path

# Directories we never index (vendored / generated / VCS).
_SKIP_DIRS = {
    ".git", ".hg", ".svn", "__pycache__", "node_modules", ".venv", "venv", "env",
    "dist", "build", ".next", ".cache", "site-packages", ".mypy_cache", ".pytest_cache",
    "coverage", ".idea", ".vscode", "vendor", "target", ".codegraph", "codegraph",
}
_PY_EXT = {".py", ".pyi"}
_JS_EXT = {".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"}
_INDEXABLE = _PY_EXT | _JS_EXT
_MAX_FILE_BYTES = 1_500_000  # skip giant/minified files

_SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY, mtime REAL, lang TEXT, nsym INTEGER, nbytes INTEGER
);
CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, kind TEXT, path TEXT, line INTEGER, end_line INTEGER,
    lang TEXT, signature TEXT, parent TEXT
);
CREATE TABLE IF NOT EXISTS calls (
    caller_id INTEGER, callee_name TEXT
);
CREATE INDEX IF NOT EXISTS ix_sym_name ON symbols(name);
CREATE INDEX IF NOT EXISTS ix_sym_path ON symbols(path);
CREATE INDEX IF NOT EXISTS ix_call_callee ON calls(callee_name);
CREATE INDEX IF NOT EXISTS ix_call_caller ON calls(caller_id);
"""


def _connect(db_path: str) -> sqlite3.Connection:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path)
    con.executescript(_SCHEMA)
    return con


# ── Python extraction (precise via ast) ───────────────────────────────────────

def _py_signature(node: ast.AST) -> str:
    try:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            args = [a.arg for a in node.args.args]
            if node.args.vararg:
                args.append("*" + node.args.vararg.arg)
            if node.args.kwarg:
                args.append("**" + node.args.kwarg.arg)
            prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
            return f"{prefix} {node.name}({', '.join(args)})"
        if isinstance(node, ast.ClassDef):
            bases = [b.id for b in node.bases if isinstance(b, ast.Name)]
            return f"class {node.name}" + (f"({', '.join(bases)})" if bases else "")
    except Exception:
        pass
    return node.__class__.__name__


def _extract_python(src: str, rel: str):
    """Return (symbols, calls). symbols: dicts; calls: (caller_local_key, callee_name)."""
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return [], []
    symbols, calls = [], []

    def walk(node, parent=""):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                kind = "class" if isinstance(child, ast.ClassDef) else \
                    ("method" if parent else "function")
                sym = {
                    "name": child.name, "kind": kind, "path": rel,
                    "line": child.lineno, "end_line": getattr(child, "end_lineno", child.lineno),
                    "lang": "python", "signature": _py_signature(child), "parent": parent,
                }
                symbols.append(sym)
                # calls made *within* this symbol's body (by callee name)
                for sub in ast.walk(child):
                    if isinstance(sub, ast.Call):
                        nm = _call_name(sub.func)
                        if nm:
                            calls.append((f"{rel}::{child.name}::{child.lineno}", nm))
                walk(child, parent=child.name)
    walk(tree)
    return symbols, calls


def _call_name(func) -> str | None:
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


# ── JS/TS extraction (lightweight regex) ──────────────────────────────────────

_JS_PATTERNS = [
    ("function", re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(")),
    ("class",    re.compile(r"^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)")),
    ("function", re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^=]*=>")),
    ("method",   re.compile(r"^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{")),
]


def _extract_js(src: str, rel: str):
    symbols = []
    for i, line in enumerate(src.splitlines(), start=1):
        for kind, pat in _JS_PATTERNS:
            m = pat.match(line)
            if m:
                name = m.group(1)
                if name in {"if", "for", "while", "switch", "catch", "function", "return"}:
                    continue
                symbols.append({
                    "name": name, "kind": kind, "path": rel, "line": i, "end_line": i,
                    "lang": "javascript", "signature": line.strip()[:120], "parent": "",
                })
                break
    return symbols, []


# ── Indexing ───────────────────────────────────────────────────────────────────

def build_index(root: str, db_path: str, full: bool = False) -> dict:
    """Index `root` into the SQLite graph at `db_path`. Incremental by mtime unless full."""
    con = _connect(db_path)
    cur = con.cursor()
    known = {r[0]: r[1] for r in cur.execute("SELECT path, mtime FROM files")}
    seen, reindexed, n_sym = set(), 0, 0
    local_to_id = {}

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS and not d.startswith(".")]
        for fn in filenames:
            ext = os.path.splitext(fn)[1].lower()
            if ext not in _INDEXABLE:
                continue
            full_path = os.path.join(dirpath, fn)
            rel = os.path.relpath(full_path, root).replace("\\", "/")
            try:
                st = os.stat(full_path)
            except OSError:
                continue
            if st.st_size > _MAX_FILE_BYTES:
                continue
            seen.add(rel)
            if not full and rel in known and abs(known[rel] - st.st_mtime) < 1e-6:
                continue  # unchanged
            try:
                src = Path(full_path).read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            # purge old rows for this file
            old = [r[0] for r in cur.execute("SELECT id FROM symbols WHERE path=?", (rel,))]
            if old:
                cur.executemany("DELETE FROM calls WHERE caller_id=?", [(i,) for i in old])
            cur.execute("DELETE FROM symbols WHERE path=?", (rel,))
            lang = "python" if ext in _PY_EXT else "javascript"
            syms, calls = (_extract_python(src, rel) if ext in _PY_EXT else _extract_js(src, rel))
            for s in syms:
                cur.execute(
                    "INSERT INTO symbols(name,kind,path,line,end_line,lang,signature,parent)"
                    " VALUES(?,?,?,?,?,?,?,?)",
                    (s["name"], s["kind"], s["path"], s["line"], s["end_line"],
                     s["lang"], s["signature"], s["parent"]))
                local_to_id[f"{rel}::{s['name']}::{s['line']}"] = cur.lastrowid
            for caller_key, callee in calls:
                cid = local_to_id.get(caller_key)
                if cid:
                    cur.execute("INSERT INTO calls(caller_id,callee_name) VALUES(?,?)", (cid, callee))
            cur.execute(
                "INSERT OR REPLACE INTO files(path,mtime,lang,nsym,nbytes) VALUES(?,?,?,?,?)",
                (rel, st.st_mtime, lang, len(syms), st.st_size))
            reindexed += 1
            n_sym += len(syms)

    # drop deleted files
    for gone in set(known) - seen:
        ids = [r[0] for r in cur.execute("SELECT id FROM symbols WHERE path=?", (gone,))]
        if ids:
            cur.executemany("DELETE FROM calls WHERE caller_id=?", [(i,) for i in ids])
        cur.execute("DELETE FROM symbols WHERE path=?", (gone,))
        cur.execute("DELETE FROM files WHERE path=?", (gone,))
    con.commit()
    stats = status(db_path, con)
    stats.update({"reindexed": reindexed, "new_symbols": n_sym, "files_seen": len(seen)})
    con.close()
    return stats


# ── Queries (return compact text for prompt injection) ─────────────────────────

def _con(db_path, con=None):
    return con or _connect(db_path)


def status(db_path: str, con=None) -> dict:
    c = _con(db_path, con)
    f = c.execute("SELECT COUNT(*) FROM files").fetchone()[0]
    s = c.execute("SELECT COUNT(*) FROM symbols").fetchone()[0]
    b = c.execute("SELECT COALESCE(SUM(nbytes),0) FROM files").fetchone()[0]
    if con is None:
        c.close()
    # ~1 token per 3.6 chars: the "reachable recall pool" in tokens
    return {"files": f, "symbols": s, "bytes": b, "recall_tokens_est": int(b / 3.6)}


def find_symbol(db_path: str, name: str, limit: int = 12) -> str:
    c = _connect(db_path)
    rows = c.execute(
        "SELECT name,kind,path,line,signature,parent FROM symbols WHERE name=? "
        "ORDER BY path LIMIT ?", (name, limit)).fetchall()
    if not rows:
        rows = c.execute(
            "SELECT name,kind,path,line,signature,parent FROM symbols WHERE name LIKE ? "
            "ORDER BY path LIMIT ?", (f"%{name}%", limit)).fetchall()
    c.close()
    if not rows:
        return f"[code_graph] no symbol matching '{name}'"
    out = [f"[code_graph] {len(rows)} match(es) for '{name}':"]
    for nm, kind, path, line, sig, parent in rows:
        loc = f"{path}:{line}"
        scope = f" (in {parent})" if parent else ""
        out.append(f"  {kind} {sig}  →  {loc}{scope}")
    return "\n".join(out)


def outline(db_path: str, path: str) -> str:
    c = _connect(db_path)
    path = path.replace("\\", "/")
    base = path.rsplit("/", 1)[-1]
    # match exact, stored-is-suffix-of-query, or query-is-suffix-of-stored (basename)
    rows = c.execute(
        "SELECT name,kind,line,signature,parent FROM symbols "
        "WHERE path=? OR path LIKE ? OR (? LIKE '%' || path) OR path LIKE ? "
        "ORDER BY line", (path, f"%{path}", path, f"%/{base}")).fetchall()
    c.close()
    if not rows:
        return f"[code_graph] no indexed symbols in '{path}'"
    out = [f"[code_graph] outline of {path} ({len(rows)} symbols):"]
    for nm, kind, line, sig, parent in rows:
        indent = "    " if parent else "  "
        out.append(f"{indent}{line:>5}: {kind} {sig}")
    return "\n".join(out)


def callers(db_path: str, name: str, limit: int = 20) -> str:
    c = _connect(db_path)
    rows = c.execute(
        "SELECT s.name,s.kind,s.path,s.line FROM calls c JOIN symbols s ON c.caller_id=s.id "
        "WHERE c.callee_name=? ORDER BY s.path LIMIT ?", (name, limit)).fetchall()
    c.close()
    if not rows:
        return f"[code_graph] no callers found for '{name}' (Python call-edges only)"
    out = [f"[code_graph] {len(rows)} caller(s) of '{name}':"]
    for nm, kind, path, line in rows:
        out.append(f"  {kind} {nm}  →  {path}:{line}")
    return "\n".join(out)


def callees(db_path: str, name: str, limit: int = 40) -> str:
    c = _connect(db_path)
    rows = c.execute(
        "SELECT DISTINCT c.callee_name FROM calls c JOIN symbols s ON c.caller_id=s.id "
        "WHERE s.name=? ORDER BY c.callee_name LIMIT ?", (name, limit)).fetchall()
    c.close()
    if not rows:
        return f"[code_graph] no callees found for '{name}'"
    names = ", ".join(r[0] for r in rows)
    return f"[code_graph] '{name}' calls: {names}"


def search(db_path: str, term: str, limit: int = 20) -> str:
    c = _connect(db_path)
    rows = c.execute(
        "SELECT name,kind,path,line FROM symbols WHERE name LIKE ? ORDER BY path LIMIT ?",
        (f"%{term}%", limit)).fetchall()
    c.close()
    if not rows:
        return f"[code_graph] no symbols matching '{term}'"
    out = [f"[code_graph] {len(rows)} symbol(s) matching '{term}':"]
    for nm, kind, path, line in rows:
        out.append(f"  {kind} {nm}  →  {path}:{line}")
    return "\n".join(out)


# ── Workspace integration (per-workspace db + auto-index + unified query) ──────

def db_for_workspace(workspace: str) -> str:
    """Per-workspace SQLite graph under DATA_DIR/codegraph/<hash>.db."""
    import hashlib
    try:
        from src.constants import DATA_DIR
        base = str(DATA_DIR)
    except Exception:
        base = os.path.join(os.path.expanduser("~"), ".odysseus")
    h = hashlib.md5(os.path.abspath(workspace).encode("utf-8")).hexdigest()[:12]
    return os.path.join(base, "codegraph", f"{h}.db")


def ensure_index(workspace: str, force: bool = False) -> dict:
    """Build the index if missing/forced, else a throttled incremental refresh so the
    graph reflects files the model edits mid-session. Incremental = mtime-based, so it
    only re-parses changed files (cheap: an os.walk + stat when nothing changed)."""
    import time
    db = db_for_workspace(workspace)
    if force or not os.path.exists(db):
        return build_index(workspace, db, full=not os.path.exists(db))
    try:
        age = time.time() - os.path.getmtime(db)
    except OSError:
        age = 1e9
    if age > 20:                       # refresh at most every ~20s
        return build_index(workspace, db, full=False)
    return status(db)


def query(workspace: str, symbol: str = "", file: str = "",
          search_term: str = "", want_status: bool = False) -> str:
    """Unified code-graph query used by the agent's `code_graph` tool."""
    ensure_index(workspace)              # lazy build on first use
    db = db_for_workspace(workspace)
    if want_status or not (symbol or file or search_term):
        st = status(db)
        return (f"[code_graph] index: {st['files']} files, {st['symbols']} symbols, "
                f"~{st['recall_tokens_est']:,} tokens reachable. "
                f"Query with {{\"symbol\":\"name\"}}, {{\"file\":\"path\"}}, or {{\"search\":\"term\"}}.")
    if file:
        return outline(db, file)
    if search_term:
        return search(db, search_term)
    # symbol: definition + callers + callees in one shot
    return "\n\n".join([find_symbol(db, symbol), callers(db, symbol), callees(db, symbol)])


# ── CLI self-test ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys, json, time
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    db = sys.argv[2] if len(sys.argv) > 2 else "_codegraph_test.db"
    t0 = time.time()
    st = build_index(root, db, full=True)
    st["index_seconds"] = round(time.time() - t0, 2)
    print("INDEX:", json.dumps(st))
    print(); print(find_symbol(db, "build_index"))
    print(); print(callers(db, "build_index"))
    print(); print(callees(db, "build_index"))
