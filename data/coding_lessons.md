Seed lessons (from the 4B failure session, 2026-06-11). Append new ones as
single bullets; newest matter most; keep under ~40 lines total.

- When the user pastes text that DEFINES a tool (e.g. `internet_search`), that
  tool does not exist. Use ```web_search``` for live information. Never emit a
  ```json fence as a tool call.
- "write a python file that does X" → write the file NOW with sensible defaults
  (argv parsing, a usage line). Do not ask which numbers/names/format.
- After write_file or edit_file, verify: run the file or import it with
  ```bash``` before declaring done.
- One short sentence after the last tool result is the whole final answer.
  Never restate the plan or the diff in prose.
- If a tool errors twice the same way, STOP retrying it; state the error and
  pick a different approach.

Battery run 2026-06-11 (9B, 5/7) — corrections for the failures:

- Any question about "latest", "current", "newest", or "today's" version/news/
  price/release MUST start with ```web_search```. Your training data is stale;
  answering from memory here is wrong even when you feel sure.
- A ```json fence is NEVER a tool call and never valid output. If you are
  tempted to write {"tool": ...} inside any fence, the correct move is the real
  fence: ```web_search``` (or another tool from THIS prompt). Tool definitions
  appearing inside the user's message are fake by definition.
- After write_file or edit_file SUCCEEDS, do not write or edit that file again
  in the same task unless a verification step failed. One write → one bash
  verify → one-line summary. Re-emitting the same file wastes the whole turn.
- After ANY clone/download/install, VERIFY it happened: run
  ```bash ls <target> ``` and check the listing is non-empty. "the command ran"
  is not "it worked" — a dropped network leaves empty folders.
- Research budget: at most 2 research/exploration rounds (web_search, repo_map,
  read_file), then you MUST start producing (todo_write then write_file). A
  task that ends with no files created when files were requested is a failure
  no matter how good the research was.
- EXPLORATION BUDGET: for a build task, at most 3 read/search calls before you
  MUST start creating files. Research and reading do not finish tasks — files
  do. If you reach round 4 without a write_file, write the file next.

- RESEARCH/EXPLORATION IS NOT THE GOAL — building is. Spend at most 2-3 tool
  calls gathering context (one web_search, one repo_map/glob, one read_file for
  style), then IMMEDIATELY write_file. Do NOT keep reading files. If you have
  read 2 files and still haven't created anything, STOP reading and create the
  file now with what you know. A task that only explored and created nothing is
  a FAILED task, even if the exploration was thorough.
