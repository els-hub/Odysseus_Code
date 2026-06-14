# Contributing to Odysseus_Code

Thanks for helping make the Odysseus coding tab better! This is an **add-on** for
[Odysseus](https://github.com/pewdiepie-archdaemon/odysseus) — it ships the coding files +
a safe installer and relies on Odysseus core.

## Ground rules
- **Zero-risk first.** Anything touching a user's Odysseus must back up, validate, and
  auto-rollback on failure. Never ship an installer change that can half-edit a host.
- **No personal data.** No hardcoded paths, machine-specific model names, tokens, or private
  repos. Use config + `.env`.
- **Keep it an add-on.** Don't add hard dependencies on a specific Odysseus version; detect and
  degrade gracefully.

## Project layout
- `src/`, `routes/`, `static/` — the coding tab itself (copied into the host on install).
- `install.py` / `uninstall.py` — the zero-risk installer + remover.
- `install_assets/` — the exact HTML/py fragments the installer inserts (with anchors).

## Dev loop
1. Make changes here (this repo), never against a live Odysseus.
2. Test the installer against a **throwaway copy** of an Odysseus install:
   `python install.py --target /path/to/copy --dry-run` then a real run.
3. Verify the Coding tab opens and a simple request (e.g. "write hello.py") works.

## Good first issues
- Native provider function-calling (vs text-fenced tools) for API models.
- More `.claude/commands` + skill coverage.
- tree-sitter grammars for more languages in the code-graph.
- Installer support for additional Odysseus layouts.

## PRs
Small, focused PRs with a clear before/after. Describe what you tested.
