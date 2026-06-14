#!/usr/bin/env python3
"""
Odysseus_Code installer — adds the Coding tab to an existing Odysseus install.

ZERO-RISK GUARANTEE (the whole point):
  • Backs up app.py, static/index.html, requirements.txt BEFORE any change.
  • Every host edit is idempotent and wrapped in `odysseus_code` sentinels.
  • After editing, validates that app.py still parses (ast); on ANY error → full
    auto-rollback from backup → host left byte-for-byte as before.
  • If the host structure doesn't match expected anchors → ABORT before writing anything.
  • `--dry-run` previews every change without touching a single file.

Usage:
  python install.py                 # auto-detect target (parent dir), interactive
  python install.py --target PATH   # explicit Odysseus root
  python install.py --dry-run       # preview only
  python install.py --yes           # non-interactive (defaults: backend=both)
"""
import argparse
import ast
import importlib.util
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

# Windows consoles default to cp1252 and crash on non-ASCII output. Force UTF-8 so the
# installer can NEVER die on an encoding error (it would otherwise abort mid-run).
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
except Exception:
    pass

HERE = Path(__file__).resolve().parent
SENTINEL = "odysseus_code"
S_OPEN = f"<!-- >>> {SENTINEL} >>> -->"
S_CLOSE = f"<!-- <<< {SENTINEL} <<< -->"
PY_OPEN = f"# >>> {SENTINEL} >>>"
PY_CLOSE = f"# <<< {SENTINEL} <<<"

# Files this add-on copies into the host (relative paths preserved).
COPY_FILES = [
    "src/coding_agent.py", "src/coding_prompts.py", "src/coding_tools.py",
    "src/coding_session.py", "src/coding_git.py", "src/code_graph.py",
    "src/coding_recall.py", "routes/coding_routes.py",
    "static/css/coding.css",
    *[f"static/js/coding/{p.name}" for p in (HERE / "static/js/coding").glob("*.js")],
    "data/coding_lessons.md",
]

# ── HTML / Python fragments inserted into the host (exact, self-contained) ──────
FRAG_CSS = '  <link rel="stylesheet" href="/static/css/coding.css">'
FRAG_SIDEBAR = (
    '        <div class="list-item" id="tool-coding-btn">\n'
    '          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>\n'
    '          <span class="grow">Coding</span>\n'
    '        </div>'
)
FRAG_MODAL = (
    '  <div id="coding-modal" class="modal hidden">\n'
    '    <div class="modal-content" style="width:100vw;height:100vh;max-width:100vw;'
    'max-height:100vh;border-radius:0;padding:0;display:flex;flex-direction:column;overflow:hidden;">\n'
    '      <div id="coding-panel-root" style="flex:1;display:flex;flex-direction:column;'
    'overflow:hidden;min-height:0;"></div>\n'
    '    </div>\n'
    '  </div>'
)
FRAG_SCRIPT = '  <script type="module" src="/static/js/coding/panel.js"></script>'
FRAG_APP = (
    "from routes.coding_routes import setup_coding_routes\n"
    "app.include_router(setup_coding_routes(\n"
    "    memory_manager=memory_manager,\n"
    "    skills_manager=skills_manager,\n"
    "))"
)
# app.py insert goes AFTER this anchor (guarantees the managers are in scope)
APP_ANCHOR = "setup_skills_routes(skills_manager)"

REQUIRED_IMPORTS = ["fastapi", "httpx"]   # the tab is pure-Python on top of Odysseus core


def log(msg): print(f"  {msg}")
def ok(msg): print(f"  [OK] {msg}")
def warn(msg): print(f"  [!] {msg}")
def die(msg):
    print(f"\n  [X] {msg}\n  Nothing was changed.\n")
    sys.exit(1)


def find_target(explicit):
    """Locate the Odysseus root. Default: the repo's parent dir (you cloned it inside)."""
    candidates = []
    if explicit:
        candidates.append(Path(explicit))
    candidates += [HERE.parent, Path.cwd()]
    for c in candidates:
        if (c / "app.py").is_file() and (c / "static" / "index.html").is_file():
            return c
    return None


def verify_odysseus(root):
    """Confirm this really is an Odysseus install (signature checks) before touching it."""
    app = (root / "app.py").read_text(encoding="utf-8", errors="replace")
    html = (root / "static" / "index.html").read_text(encoding="utf-8", errors="replace")
    if "include_router" not in app:
        die(f"{root/'app.py'} doesn't look like an Odysseus app (no include_router).")
    if "</head>" not in html or "</body>" not in html:
        die("index.html missing </head>/</body> — unexpected structure.")
    return app, html


def detect_mode(root):
    has_compose = any((root / n).is_file() for n in
                      ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"))
    docker_ok = shutil.which("docker") is not None
    return "docker" if (has_compose and docker_ok) else "native"


def ask_backend(noninteractive):
    if noninteractive:
        return "both"
    print("\n  Which model backend do you want the Coding tab to use?")
    print("    1) API only   (Anthropic / OpenAI / OpenRouter / Groq …)")
    print("    2) Local only (Ollama)")
    print("    3) Both")
    choice = input("  Choose [3]: ").strip() or "3"
    return {"1": "api", "2": "local", "3": "both"}.get(choice, "both")


def insert_block(text, fragment, *, before=None, after=None, marker_check):
    """Return (new_text, changed). Idempotent: skips if marker_check already present.
    Wraps the fragment in sentinels. Raises if the anchor isn't found."""
    if marker_check in text:
        return text, False                      # already installed
    block = f"{S_OPEN}\n{fragment}\n{S_CLOSE}\n"
    if before is not None:
        idx = text.find(before)
        if idx == -1:
            raise KeyError(f"anchor not found: {before!r}")
        # Snap to the START of the line containing the anchor so we insert whole lines
        # and NEVER split an existing tag/line (e.g. anchoring on id="tool-" must not
        # cut `<div class="list-item" id="tool-memory-btn">` in half).
        line_start = text.rfind("\n", 0, idx) + 1
        return text[:line_start] + block + text[line_start:], True
    if after is not None:
        idx = text.find(after)
        if idx == -1:
            raise KeyError(f"anchor not found: {after!r}")
        end = text.find("\n", idx) + 1
        return text[:end] + "\n" + PY_OPEN + "\n" + fragment + "\n" + PY_CLOSE + "\n" + text[end:], True
    raise ValueError("need before= or after=")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--yes", action="store_true")
    args = ap.parse_args()

    print("\n  Odysseus_Code installer\n  " + "-" * 40)
    root = find_target(args.target)
    if not root:
        die("Couldn't find an Odysseus install (looked for app.py + static/index.html). "
            "Pass --target /path/to/odysseus.")
    root = root.resolve()
    ok(f"target Odysseus: {root}")
    app_text, html_text = verify_odysseus(root)
    mode = detect_mode(root)
    ok(f"install mode: {mode}")
    backend = ask_backend(args.yes)
    ok(f"model backend: {backend}")

    # ── Pre-flight: compute ALL edits first; abort if any anchor is missing ──────
    try:
        new_app, app_changed = insert_block(app_text, FRAG_APP, after=APP_ANCHOR,
                                             marker_check="setup_coding_routes")
        new_html = html_text
        new_html, c1 = insert_block(new_html, FRAG_CSS, before="</head>",
                                    marker_check='href="/static/css/coding.css"')
        new_html, c2 = insert_block(new_html, FRAG_SIDEBAR, before='id="tool-',
                                    marker_check='id="tool-coding-btn"')
        new_html, c3 = insert_block(new_html, FRAG_MODAL + "\n" + FRAG_SCRIPT, before="</body>",
                                    marker_check='id="coding-modal"')
    except KeyError as e:
        die(f"Your Odysseus structure doesn't match what the installer expects ({e}). "
            "Aborting so nothing is altered. Please open an issue with your Odysseus version.")

    # ── Validate the proposed app.py BEFORE writing anything ────────────────────
    try:
        ast.parse(new_app)
    except SyntaxError as e:
        die(f"Proposed app.py would not parse ({e}) — aborting, host untouched.")

    if args.dry_run:
        print("\n  DRY RUN — would make these changes:")
        log(f"copy {len(COPY_FILES)} coding files into {root}")
        log(f"app.py: {'insert coding router' if app_changed else 'already present'}")
        log(f"index.html: css={c1} sidebar={c2} modal+script={c3}")
        log(f"backend={backend}, mode={mode}; deps checked: {REQUIRED_IMPORTS}")
        print("\n  (no files were changed)\n")
        return

    # ── BACKUP (refuse to proceed if it fails) ──────────────────────────────────
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")  # noqa: DTZ005 (local stamp ok)
    backup = root / ".odysseus_code_backup" / stamp
    backup.mkdir(parents=True, exist_ok=True)
    to_backup = ["app.py", "static/index.html", "requirements.txt"]
    backed = []
    try:
        for rel in to_backup:
            src = root / rel
            if src.is_file():
                dst = backup / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                backed.append(rel)
        ok(f"backup created: {backup}")
    except OSError as e:
        die(f"backup failed ({e}) — refusing to continue.")

    def rollback(reason):
        for rel in backed:
            try:
                shutil.copy2(backup / rel, root / rel)
            except OSError:
                pass
        print(f"\n  [X] {reason}\n  [rolled back] from backup - your Odysseus is unchanged.\n")
        sys.exit(1)

    # ── Dependency dedup: install only what's missing ───────────────────────────
    missing = [m for m in REQUIRED_IMPORTS if importlib.util.find_spec(m) is None]
    if missing and mode == "native":
        log(f"installing missing deps: {missing}")
        try:
            subprocess.run([sys.executable, "-m", "pip", "install", *missing], check=True)
        except subprocess.CalledProcessError:
            rollback("dependency install failed")
    elif missing:
        warn(f"missing deps {missing} — they'll be installed in the Docker image rebuild")
    else:
        ok("all required deps already present")

    # ── Copy coding files ───────────────────────────────────────────────────────
    try:
        for rel in COPY_FILES:
            src = HERE / rel
            if not src.is_file():
                continue
            dst = root / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
        ok(f"copied {len(COPY_FILES)} coding files")
    except OSError as e:
        rollback(f"file copy failed ({e})")

    # ── Apply the edits ─────────────────────────────────────────────────────────
    try:
        (root / "app.py").write_text(new_app, encoding="utf-8")
        (root / "static" / "index.html").write_text(new_html, encoding="utf-8")
    except OSError as e:
        rollback(f"edit failed ({e})")

    # ── Post-write validation ───────────────────────────────────────────────────
    try:
        ast.parse((root / "app.py").read_text(encoding="utf-8"))
        h = (root / "static" / "index.html").read_text(encoding="utf-8")
        assert 'id="coding-modal"' in h and 'href="/static/css/coding.css"' in h
    except (SyntaxError, AssertionError) as e:
        rollback(f"post-write validation failed ({e})")

    ok("integration applied + validated")

    # ── Apply mode ──────────────────────────────────────────────────────────────
    print()
    if mode == "docker":
        log("Docker detected — rebuild to load the Coding tab:")
        log(f"    cd {root} && docker compose up -d --build")
    else:
        log("Native install — restart your Odysseus server to load the Coding tab.")
    print(f"\n  [OK] Done. Backend: {backend}. Backup: {backup}")
    print("  Open Odysseus -> the Coding tab is in the sidebar. Uninstall: python uninstall.py\n")


if __name__ == "__main__":
    main()
