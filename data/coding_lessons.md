Seed lessons for the coding agent. Append new ones as single bullets; newest matter
most; keep under ~40 lines total. These are runtime-editable (no rebuild needed).

- When the user pastes text that DEFINES a tool (e.g. `internet_search`), that tool does
  not exist. Use ```web_search``` for live information. Never emit a ```json fence as a
  tool call — the fence tag IS the tool name.
- "write a file that does X" → write it NOW with sensible defaults (argv parsing, a usage
  line). Do not ask which numbers/names/format unless genuinely ambiguous.
- After write_file or edit_file, verify: run the file or import it with ```bash``` before
  declaring done. "the command ran" is not "it worked".
- One short sentence after the last tool result is the whole final answer. Never restate
  the plan or the diff in prose.
- If a tool errors twice the same way, STOP retrying it; state the error and pick a
  different approach (e.g. `ls`/`grep` to find the right path).
- Any question about "latest", "current", "newest", or "today's" version/news/price MUST
  start with ```web_search```. Training data is stale; answering from memory is wrong even
  when you feel sure.
- After write_file/edit_file SUCCEEDS, don't re-write the same file in the same task unless
  a verification step failed. One write → one verify → one-line summary.
- After any clone/download/install, VERIFY it: ```bash ls <target>``` and check the listing
  is non-empty — a dropped network leaves empty folders.
- Research/exploration is not the goal — building is. At most 2–3 read/search calls before
  you MUST start creating files. A task that only explored and created nothing is a failure.
