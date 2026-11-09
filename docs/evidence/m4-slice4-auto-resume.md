# M4 slice 4: auto-lite resume flips to full on workflow-written status.json

Date: 2026-11-10 (Asia/Singapore). Source of truth for the demo itself is
`test/lite-track-auto-acceptance.test.js` (re-run it to reproduce).
Parent issue: #97; slice issue: #103; PR: slice 4 (this change).

## Status: preliminary wall clock — NOT the ≤1.3× conclusion

The wall-clock numbers below are local n=1 measurements of the acceptance
demo harness. The formal wall-clock verdict for issue #5 P1-2 (small tasks
≤1.3× baseline) waits for the bench full-matrix numbers; P1-2 stays
unticked and no ≤1.3× claim is made here.

## The bug (found by the auto acceptance demo on main HEAD 4668b6ab)

A real small fix through `xflow workflow run` with **no flag**: run 1
(pre-fix, clean tree) auto-decides lite, seals the red proof, stops at
tdd-green. The fix is applied, run 2 (resume) re-runs the classifier —
and flips to **full**:

| Run | `lite_track_decision` (from the workflow events) | `lite_fast_track` |
| --- | --- | --- |
| Run 1, pre-fix | `{source: auto, track: lite, reason: 'empty diff: nothing to ritualise', files: 0, total: 0}` | `true` |
| Run 2, resume (pre-fix code) | `{source: auto, track: full, reason: 'touches specs/ paths (specs/changes/chg-m4-auto-demo/status.json): spec/workflow drift needs the full track', files: 3, total: 281}` | `false` |

Root cause: run 1 rewrites the tracked
`specs/changes/<id>/status.json` itself (stage transitions +
`workflow_integrity` block, +268/−2 lines in the demo; the worktree diff
at resume time is 3 files, 277 insertions / 13 deletions). The classifier
measures the worktree diff against the merge-base, sees a `specs/` path,
and the force-full rule fires. The actual user change is still the same
2-file, 20-line fix. The two halves of one change then run on different
tracks: the resume re-executes the spec ritual (J4a/J4b) that run 1
skipped.

Scope note: evalid's own repo gitignores `specs/changes/`, so dogfooding
does not hit this — but any repo that tracks change state does, and the
repo's own acceptance demo (the M4 bar) fails on main HEAD. The defect is
in the shipped classifier, not the demo, so the fix is in the classifier.

## The fix

`classify_repo` in `xflow/atoms/lite_track.py` now excludes
workflow-generated artifacts under `specs/changes/<id>/` from the measured
stats before the verdict: `status.json`, `verify_proof.json`,
`spec_delta_review.json` / `.md`, and the `tdd/` / `cr/` trees.
Human-authored spec files (`proposal.md` / `plan.md` / `tasks.md`) still
force full. No CLI / executor / env / phanes call-surface change.

## Numbers (post-fix demo runs, n=1 each, preliminary)

| Run | lite (first + resume) | full (first + resume) | lite/full |
| --- | --- | --- | --- |
| Auto acceptance test, isolated | 2,446 ms + 2,549 ms = 4,995 ms | 2,854 ms + 3,509 ms = 6,363 ms | 0.785 |
| Auto acceptance test, inside `npm run verify` | 4,135 ms + 4,104 ms = 8,239 ms | 4,126 ms + 2,998 ms = 7,124 ms | 1.157 |

Same demo, same machine, two runs minutes apart: 0.785 vs 1.157. The
slice-2 demo re-measured inside the same suite run gives 1.291 this time
(7,655 ms vs 5,928 ms), against its original 0.644 / 0.798. The spread
itself is the finding: n=1 demo timings are dominated by per-process
startup and machine load (the suite runs test files in parallel), not by
the spec ritual. Do not quote any of these ratios as the lite-track
speedup; the formal ≤1.3× verdict still waits for the bench full-matrix
numbers.

Machine for all runs above: Linux x86_64 VM, AMD EPYC 9D25, 4 vCPU;
node v24.22.1, python 3.12.3.

## What the demo proved (functional, not timing)

- Post-fix resume decision: `{source: auto, track: lite, reason:
  'within thresholds (2 files, 20 lines <= 10 files, 300 lines)',
  files: 2, added: 9, removed: 11, total: 20, force_full: []}` — the
  resume stays lite on the same fix that run 1 lite'd.
- Lite run: `proposal-consistency-check` logged `phase_skipped` (reason
  `lite_track`); `J4a` / `J4b` logged `atom_skipped` (reason
  `lite_track`); the `verify-consistency` gate passed with verdict
  `lite_skipped`; `workflow_completed` recorded `lite_fast_track: true`
  with the auto decision in both `workflow_started` and
  `workflow_completed`.
- Seal + clean replay: red proof `passed: false`; green proof
  `passed: true` with binding hash `8f5f78b44be55c3d` and snapshot scope
  (`lite_track.py`, `test/demo.test.mjs`); I6b validated both; I6d, I6c,
  J1 and J6 all passed.
- Full control (400-line file staged, no flag): first run auto-full
  (`400 lines > 300 max_lines`, 1 file), resume auto-full (420 lines,
  3 files); J4a / J4d / J4b all executed and passed; no `lite_track`
  skip anywhere; `workflow_completed` recorded `lite_fast_track: false`.

## Reproduce

```sh
node --test test/lite-track-auto-acceptance.test.js  # prints [m4-auto-*] lines
node --test test/lite-track.test.js                   # classifier unit tests
npm run verify                                        # full suite
```
