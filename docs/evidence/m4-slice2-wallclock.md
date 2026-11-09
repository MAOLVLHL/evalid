# M4 slice 2: lite vs full wall-clock — local preliminary numbers

Date: 2026-11-10 (Asia/Singapore). Source of truth for the demo itself is
`test/lite-track-acceptance.test.js` (re-run it to reproduce).

## Status: preliminary — NOT the ≤1.3× conclusion

These are local n=1 measurements of the acceptance demo harness. The formal
wall-clock verdict for issue #5 P1-2 (small tasks ≤1.3× baseline) waits for
the bench full-matrix numbers; P1-2 stays unticked and no ≤1.3× claim is
made here.

## Method

Same demo flow per track, in a throwaway git repo holding a buggy copy of
`lite_track.py`: the real `WorkflowExecutor` runs the real
`workflows/yolo.yaml` phases (`proposal-consistency-check`, `tdd-red`,
`tdd-green`, `verify-consistency`) with the real atom registry. First run
(red seals, green stops pre-fix), fix applied, resume run (green seals,
verify runs). The lite run skips the spec ritual; the full run executes it.
Each total below is first run + resume run.

Machine: Linux x86_64 VM, AMD EPYC 9D25, 4 vCPU; node v24.22.1, python 3.12.3.

## Numbers

| Run | lite (first + resume) | full (first + resume) | lite/full |
| --- | --- | --- | --- |
| Standalone acceptance test | 2,198 ms + 2,852 ms = 5,050 ms | 2,816 ms + 3,514 ms = 6,330 ms | 0.798 |
| Inside `npm run verify` (full suite) | 4,120 ms + 6,300 ms = 10,420 ms | 7,601 ms + 8,590 ms = 16,191 ms | 0.644 |

n=1 per track per run. The two runs, minutes apart on the same machine,
disagree by ~0.15 on the ratio — that spread is itself the reason these
numbers are preliminary: the demo's absolute times are dominated by
per-process startup (node + python atoms) and machine load, not by the
spec ritual alone. Do not quote 0.64 or 0.80 as the lite-track speedup.

## What the demo proved (functional, not timing)

- Classifier: the real fix (2 files, `lite_track.py` + `test/demo.test.mjs`)
  classifies `lite`; a 400-line addition classifies `full`; a one-line
  touch under `specs/` classifies `full` (force-full).
- Lite run: `proposal-consistency-check` logged `phase_skipped`
  (reason `lite_track`); `J4a` / `J4b` logged `atom_skipped` (reason
  `lite_track`); the `verify-consistency` gate passed with verdict
  `lite_skipped`; `workflow_completed` recorded `lite_fast_track: true`.
- Seal + clean replay: red proof `passed: false`
  (`failure_kind: assertion`); green proof `passed: true` with binding
  hash and snapshot scope; I6b validated both (binding recomputed,
  snapshot hashes checked, command re-run on the snapshot).
  I6d, I6c, J1 and J6 all passed in both tracks.
- Full run (control): J4a / J4d / J4b all executed and passed; no
  `lite_track` skip anywhere; `workflow_completed` recorded
  `lite_fast_track: false`.

## Reproduce

```sh
node test/lite-track-acceptance.test.js   # prints a [m4-slice2-wallclock] line
npm run verify                            # full suite; same line appears
```
