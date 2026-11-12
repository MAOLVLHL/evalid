# agent-stream fixtures — provenance

`claude.ndjson` / `codex.ndjson` (pre-existing, #183): minimal happy-path streams
in real CLI shapes — claude `--output-format stream-json`
(`system`/`assistant`/`user`/`result` lines) and codex `--json`
(`thread.started`/`item.started`/`item.completed`/`turn.completed`).

`claude-error-killed.ndjson` / `codex-killed.ndjson` (M14 slice 1, #185):
**faithfully reconstructed, not recorded from a live CLI run.** This environment
has no usable live CLI to record from (the installed codex CLI reports
"Not logged in"; no claude CLI is installed and no CLI credentials are
available to this worker). Line shapes, field names and orderings were copied
from the real stream formats above and from the CLIs' documented stream-json /
`--json` output:

- claude: an `assistant` line can carry text plus one or more `tool_use`
  blocks; each `tool_result` arrives later on a `user` line and carries only
  `tool_use_id` (plus `is_error` on failure); results for concurrent calls
  may arrive in any order. A killed run ends mid-stream: no `result` line.
- codex: each tool call is an `item.started` / `item.completed` pair keyed by
  `item.id`; a killed run ends after `item.started` with no `item.completed`
  and no `turn.completed`.

Slice 2 (#184 acceptance 1) replaces / extends these with ≥3 streams recorded
from real CLI runs; until then no test in this directory claims a fixture is a
verbatim recording.
