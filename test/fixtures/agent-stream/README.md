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

Slice 2 (#187, #184 acceptance 1) adds the three real codex recordings below;
the claude half is still open (see bottom), so the claude fixtures above stay
labelled reconstructed and no test claims a claude fixture is a verbatim
recording.

`codex-real-normal-ls.ndjson` / `codex-real-normal-read.ndjson` /
`codex-real-killed-sleep.ndjson` (M14 slice 2, #187): **verbatim recordings
from real codex runs** — raw stdout, nothing edited. Recorded 2026-11-12 on
gocc (the user's Mac mini) with codex-cli 0.166.0, logged in using ChatGPT,
in an empty scratch directory (`/tmp/m14s2/work`, one `sample.txt` file).
Commands (stdin from /dev/null):

- normal-ls: `codex exec --json --skip-git-repo-check -C /tmp/m14s2/work
  --sandbox danger-full-access --dangerously-bypass-approvals-and-sandbox
  "List the files in this directory with ls, then report how many files
  there are. Do not modify anything."` — exit 0, 9 lines, 2 shell calls
  (`ls`, `find … | wc -l`), both paired, `turn.completed` present.
- normal-read: same flags, prompt `"Read the file sample.txt in this
  directory and report its exact contents. Do not modify anything."` —
  exit 0, 7 lines, 1 shell call (`cat sample.txt`), paired,
  `turn.completed` present.
- killed-sleep: same flags, prompt `"Run sleep 45 with the shell, then
  report when it finishes. Do not modify anything."` — the process was sent
  SIGTERM once `item.started` for the `sleep 45` call was observed in the
  stream (+5 s), then SIGKILL after 3 s; exit 143. 4 lines: the `sleep 45`
  call has an `item.started` and no `item.completed`, and there is no
  `turn.completed`. Replaying it through the sink closes that call as
  `abandoned`.

Flag note: codex 0.166.0 dropped `--full-auto` (the flag
`agent-invoke` passes on older codex); `--sandbox danger-full-access
--dangerously-bypass-approvals-and-sandbox` is its documented equivalent
in this version, and the `--json` line shapes are unchanged.

Claude half still open: no claude stream-json recording is in this slice.
The claude CLI on gocc (2.1.302) reports "Not logged in · Please run
/login" both over SSH and when run from the GUI-session bridge (login
shell included) — its OAuth token lives in the macOS keychain and is not
reachable from any non-interactive context available to this worker, and
the MacBook has no claude CLI at all. A real claude recording needs the
user to run it in their own terminal (see #187 for the exact commands);
until then the claude fixtures above stay labelled reconstructed and no
test claims a claude fixture is a verbatim recording.
