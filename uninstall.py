#!/usr/bin/env python3
"""Cleanly remove Odysseus_Code from a host Odysseus.

Strategy: strip the sentinel-wrapped blocks from app.py + index.html (idempotent),
remove the copied coding files, and validate app.py still parses. If anything looks
wrong, it can restore the most recent installer backup instead.
"""
import argparse
import ast
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SENT_HTML = re.compile(r"\n?<!-- >>> odysseus_code >>> -->.*?<!-- <<< odysseus_code <<< -->\n?", re.S)
SENT_PY = re.compile(r"\n?# >>> odysseus_code >>>.*?# <<< odysseus_code <<<\n?", re.S)

COPY_FILES = [
    "src/coding_agent.py", "src/coding_prompts.py", "src/coding_tools.py",
    "src/coding_session.py", "src/coding_git.py", "src/code_graph.py",
    "src/coding_recall.py", "routes/coding_routes.py", "static/css/coding.css",
    *[f"static/js/coding/{p.name}" for p in (HERE / "static/js/coding").glob("*.js")],
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target")
    ap.add_argument("--restore-backup", action="store_true",
                    help="restore the most recent installer backup instead of stripping")
    args = ap.parse_args()

    root = Path(args.target) if args.target else HERE.parent
    if not (root / "app.py").is_file():
        print(f"  ✗ no Odysseus app.py found at {root}; pass --target")
        sys.exit(1)
    root = root.resolve()
    print(f"\n  Uninstalling Odysseus_Code from {root}\n  " + "-" * 40)

    if args.restore_backup:
        backups = sorted((root / ".odysseus_code_backup").glob("*"))
        if not backups:
            print("  ✗ no backup found")
            sys.exit(1)
        latest = backups[-1]
        for rel in ("app.py", "static/index.html", "requirements.txt"):
            src = latest / rel
            if src.is_file():
                shutil.copy2(src, root / rel)
        print(f"  ✓ restored backup {latest.name}")
    else:
        for rel in ("app.py", "static/index.html"):
            p = root / rel
            txt = p.read_text(encoding="utf-8", errors="replace")
            txt2 = (SENT_PY if rel.endswith(".py") else SENT_HTML).sub("\n", txt)
            txt2 = SENT_HTML.sub("\n", txt2) if rel.endswith(".py") else txt2
            if rel.endswith(".py"):
                try:
                    ast.parse(txt2)
                except SyntaxError as e:
                    print(f"  ✗ stripped app.py would not parse ({e}); "
                          f"re-run with --restore-backup")
                    sys.exit(1)
            p.write_text(txt2, encoding="utf-8")
        print("  ✓ removed integration blocks from app.py + index.html")

    removed = 0
    for rel in COPY_FILES:
        p = root / rel
        if p.is_file():
            p.unlink()
            removed += 1
    # tidy empty coding dir
    cdir = root / "static" / "js" / "coding"
    if cdir.is_dir() and not any(cdir.iterdir()):
        cdir.rmdir()
    print(f"  ✓ removed {removed} coding files")
    print("\n  Done. Rebuild (Docker) or restart (native) to fully unload.\n")


if __name__ == "__main__":
    main()
