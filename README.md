<h1 align="center">Odysseus_Code</h1>

<p align="center">
  <b>A Claude-Code-Desktop–style coding agent for your self-hosted <a href="https://github.com/pewdiepie-archdaemon/odysseus">Odysseus</a>.</b><br>
  One-click install · works with any API <i>or</i> 100% local · zero-risk to your existing setup.
</p>

<p align="center">
  <!-- TODO: replace with the real demo GIF before publishing -->
  <img src="docs/demo.gif" alt="Odysseus_Code demo" width="760">
</p>

---

> ⚠️ **Alpha.** The installer's zero-risk safeguards (backup → validate → auto-rollback) are
> implemented but **not yet battle-tested across diverse Odysseus installs**. Until this banner is
> removed, **only run the installer against a backed-up or throwaway Odysseus**, and prefer
> `python install.py --dry-run` first. Feedback welcome.

## What it is

Odysseus_Code drops a **Coding tab** into an Odysseus install you already run — the same
plan → search → write → verify agent loop you get in Claude Code Desktop, but on **your**
models and **your** machine. Point it at an API (Anthropic, OpenAI, OpenRouter, Groq, …) or
run it **fully local** on a small GPU.

It is an **add-on**, not a fork: it ships only the coding files + a safe installer and rides on
your Odysseus core. Your existing Odysseus is **never** put at risk (see *Zero-risk* below).

## Features

- 🧠 **Agentic loop** — plan, call tools, read results, verify, iterate, stop. Collapsed
  "Ran …" tool rows, live thinking, +/− diffs.
- 🔌 **Works with API or local** — Anthropic / OpenAI / OpenRouter / Groq, or Ollama locally.
  You choose at install time.
- 🗺️ **~100K *effective* context on a 6 GB GPU** — a deterministic, 0-VRAM **code-graph**
  (symbols, callers, callees) + a **session-recall** store let the model *reach* a huge
  codebase precisely without holding it all in the window. (Recall, not a literal 100K window.)
- 🛠️ **Real tools** — read/write/edit, bash, web search, repo map, git (status/diff/commit/PR).
- 🧩 **Claude-compat** — workspace `.claude/skills/*/SKILL.md`, `.claude/commands/*.md`,
  `.claude/settings.json` hooks (PreToolUse/PostToolUse), `CLAUDE.md`, and MCP servers.
- 🎨 **Themed** — matches Odysseus; Diff / Terminal / Files / Plan views; context wheel.

## Install (one click)

> Requires an existing Odysseus install.

1. **Download** this repo into your Odysseus folder (clone or download-zip):
   ```bash
   cd /path/to/odysseus
   git clone https://github.com/els-hub/Odysseus_Code.git
   ```
2. **Run the installer** (double-click or terminal):
   - Windows: double-click **`install.bat`**
   - macOS: double-click **`install.command`**
   - Any OS: `python Odysseus_Code/install.py`
3. The installer **auto-detects Docker vs native**, **asks which model backend** you want
   (API / local / both), installs only the **missing** dependencies, wires in the tab, and
   (Docker) rebuilds or (native) restarts. Open Odysseus → the **Coding** tab is there.

To remove it cleanly at any time: `python Odysseus_Code/uninstall.py`.

## Zero-risk guarantee

The installer **cannot break your Odysseus**:
- It **backs up** `app.py`, `index.html`, and `requirements.txt` before any change.
- Every edit is **idempotent** and wrapped in `odysseus_code` sentinels.
- After editing it **validates** that `app.py` still parses; on **any** error it performs a
  **full auto-rollback** and leaves your install byte-for-byte as it was.
- If your Odysseus structure doesn't match what it expects, it **aborts before touching anything**.
- Run `python install.py --dry-run` to preview every change without writing.

## Model setup

- **API:** the installer writes the provider key you give it into your Odysseus `.env`
  (see `.env.example`). Keys are never committed.
- **Local:** point at Ollama; the coding tab uses Ollama's native API so the context-window
  and reasoning controls work correctly.
- **Both:** pick the model per session from the model picker.

## How the "100K on a 6 GB GPU" works (the honest version)

A 6 GB card physically cannot hold a literal 100K-token window for a 7–9B model. Instead the
agent **offloads** its work to two deterministic, 0-VRAM stores and **pulls** from them on demand:
a tree-sitter/AST **code-graph** of the repo and a SQLite-FTS **session-recall** store of the
model's own decisions/results. The live window stays small (fast, 100% GPU); the model can
*reach* far more than it holds — the same way Claude Code feels big on large repos.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Good first issues are labeled.

## License

[MIT](LICENSE) © els-hub
