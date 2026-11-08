# Changelog

All notable changes to this project are documented here. Detailed notes live in
[RELEASE_NOTES.md](RELEASE_NOTES.md).

## [0.5.16] - 2026-11-09

### Added
- **M3 slice 1: pytest assertion-execution tracking (#82)**: `xflow/atoms/i6d_assertion_execution.py` now collects every `assert` in a pytest run (file, line, enclosing test) and reports which assertions actually executed, so an unexecuted assertion is red instead of silently green. Test evidence: 5 new tests in `test/i6d-assertion-execution.test.js` 5/5 pass; local full `npm test` 480 tests passed; main CI run 42525749105 success.
- **M3 slice 2: diff-scoped assertion execution (#84)**: assertion-execution verdicts are now scoped to the diff — only new/changed assertions are in scope, legacy dead asserts outside the diff are reported out of scope instead of failing the run. Test evidence: 4 new tests in `test/i6d-assertion-execution.test.js` 4/4 pass (i6d file 9/9 pass); local full `npm test` exit 0; PR CI runs verify 42535505270 and ledger 42535505267 both pass; merged main CI run 42535987353 success.

Milestone M3 "pytest assertion-execution tracking" — **not yet accepted**: slices 1 and 2 are merged checkpoints only; slice 3 is still to be done and the end-to-end acceptance evidence (real-scenario run + data on disk) is not yet in place. This release does not claim M3 acceptance.

Acceptance debt, stated plainly: the bench-number acceptance for P1-2 / P1-3 / P2-1 / P2-3 still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is stopped on MiniMax Token Plan quota exhaustion. No bench numbers are claimed in this release.

## [0.5.15] - 2026-11-09

### Added
- **`xflow audit` standalone mode (#78, M2)**: verify any git diff / PR without adopting evalid workflows — `xflow audit --pr <n>` / `--diff <patch> --base <ref>` / `--base <ref> --head <ref>` extracts the test runs the change claims to have passed (English and Chinese claim phrasing, per-file counts summed for multi-file commands, clause-split so one line's two claims don't leak onto each other), replays each in a clean clone at the change's head (deps installed with `npm ci` in the scratch copy, `NODE_TEST_*` env stripped so a nested `node --test` really runs), and compares exit codes and pass/fail counts against the claim. Diffs carrying an evalid proof seal are replayed through the existing i6b validator (seal semantics untouched). Verdicts: `verified` / `mismatch` / `no_claims` / `unverifiable` (exit 0/1/3/1). Test evidence: 11 new tests in `test/xflow-audit.test.js` (claim extraction incl. #75/#68 bodies, diff/seal parsing, replay-count parsing, fixture-repo verified/mismatch/no_claims end-to-end) 11/11 pass; local full `npm test` 475 tests / 474 pass / 0 fail / 1 skipped (pre-existing); PR CI runs ledger 42516967938 and verify 42516967984 both success.

Milestone M2 "`xflow audit` standalone mode" acceptance evidence (issue #78, comment 6726208145): audits of real historical PRs #75 / #71 / #68 all `verified` (targeted run 24 passed / 0 failed / 24 total plus seal `valid` on #75; full `npm test` exit 0 on all three; #68's claimed 439/0/440 honestly counts-unparsed — multi-file runner has no single total).

Acceptance debt, stated plainly: the bench-number acceptance for P1-2 / P1-3 / P2-1 / P2-3 still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is stopped on MiniMax Token Plan quota exhaustion. No bench numbers are claimed in this release. Audit gaps carried forward: no PR from a different repo or a non-evalid agent audited yet; pytest / go test / cargo test replay paths are parser-level only.

## [0.5.14] - 2026-11-09

### Added
- **PR comment ledger (#75)**: the proof-ledger workflow now posts the claim-vs-evidence ledger as a PR comment (`action/ledger-comment.mjs`, `.github/workflows/proof-ledger.yml`). A green proof gets a ✅ comment naming the verified change; a tampered proof fails the `ledger` check and gets a ❌ comment naming the exact break point, so a replay mismatch can no longer pass CI silently. Test evidence: 18 new tests in `test/github-action-ledger-comment.test.js` 18/18 pass; local full `npm test` 464 tests / 463 pass / 0 fail / 1 skipped (pre-existing); PR CI run 42505482112 success.

Milestone M1 "GitHub Action end-to-end" acceptance evidence (issue #73, comment 6724800077): ① green path — PR #75 merged af88e2da, proof-ledger run 42505482067 success, ✅ ledger comment 6724656930; ② red path — demo PR #76 (closed unmerged by plan) turned the `ledger` check red (run 42505769769) and the ❌ comment 6724768829 names the break point `green_tree_mismatch: test/demo-tamper.test.js`; ③ CI replay and local replay agree on both verdicts (`valid` green, `green_tree_mismatch` tampered) through the same validator entry.

Acceptance debt, stated plainly: the bench-number acceptance for P1-2 / P1-3 / P2-1 / P2-3 still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is stopped on MiniMax Token Plan quota exhaustion. No bench numbers are claimed in this release.

## [0.5.13] - 2026-11-09

### Added
- **Proof-seal verification GitHub Action (#71)**: new JavaScript action (`action.yml`, node22) that runs the existing i6b seal validator for one change-id/phase/attempt and exits non-zero unless the seal verifies and the clean replay matches the claim. Inputs: change-id, phase, attempt, project-root, tdd-mode; outputs: ok, verdict. Test evidence: 6 new tests in `test/github-action-verify-proof.test.js` (valid sealed green proof verifies; tampered proof fails with `binding_mismatch`; test drift after the seal fails with `green_tree_mismatch`; missing proof fails with `missing`; CLI entry exit 0/1; action.yml declares inputs and entry) 6/6 pass; RED→GREEN verified (`ERR_MODULE_NOT_FOUND` before the entry existed); PR CI run 42494536803 success.

### Changed
- **Removed dead phase-run-dispatch atom wrapper (#68)**: `src/agent_team/atoms/phase-run-dispatch.js` had zero callers — repo-wide grep finds only its own definition site, it is absent from `atoms/registry.json` and from the public `src/index.js` surface, and registry entry `I2.phase_run.dispatch` points elsewhere. No runtime behaviour changed. Test evidence: local full `npm test` 440 tests / 439 pass / 0 fail / 1 skipped (pre-existing); PR CI run 42483989723 verify pass.

Acceptance debt, stated plainly: the bench-number acceptance for P1-2 / P1-3 / P2-1 / P2-3 still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is stopped on MiniMax Token Plan quota exhaustion. No bench numbers are claimed in this release.

## [0.5.12] - 2026-11-08

### Added
- **Policy resolve atom coverage (#66)**: `src/core/atoms/policy/resolve.js` (P1 `policy.resolve`) was at 0% coverage. Added 6 tests to `test/policy-overlay.test.js` covering personal-default resolution with `policy_effective.json` writing, change_id and execution_mode taken from input, `team_policy_missing` / `team_policy_invalid` passthrough, no artifact when no change id is supplied, and registry wiring. Test evidence: RED→GREEN (stubbed-throwing implementation failed the new tests, then green after restore); `node --test test/policy-overlay.test.js` 18 pass / 0 fail; `npm test` 435 tests / 434 pass / 0 fail / 1 skipped (pre-existing); coverage after: resolve.js 100% statements / 83.33% branches / 100% functions / 100% lines (was 0% before; the single uncovered branch is the `process.cwd()` fallback, untested by design to avoid polluting the repo).

Acceptance debt, stated plainly: the bench-number acceptance for P1-2 / P1-3 / P2-1 / P2-3 still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is stopped on MiniMax Token Plan quota exhaustion. No bench numbers are claimed in this release.

## [0.5.11] - 2026-11-08

### Added
- **Codex app bridge atom coverage (#63)**: `src/agent_team/atoms/codex-app-bridge.js` (I5 `codex.app_bridge`) was at 0% coverage. Added 6 tests to `test/heavy-atoms.test.js` covering the default local-bridge placeholder return, input.phase preference over context.phase.id, empty-string and missing-phase fallbacks, and registry wiring. Test evidence: RED→GREEN (stubbed-throwing implementation failed all 6 new tests, then green after restore); `npm run coverage` 424 pass / 0 fail; coverage after: codex-app-bridge 100% (all four measures, was 0% before).
- **Visual layout competition atom coverage (#64)**: `src/agent_team/atoms/visual/layout-competition.js` (H3b `visual.layout_competition`) was at 0% coverage. Added 4 tests to `test/heavy-atoms.test.js` covering `layout_competition.json` writing with the fixed phase and summary (verdict accept / confidence 0.76, two findings), the fixed phase winning over input/context phase names, the missing-change_id error, and registry wiring. Test evidence: RED→GREEN (an intentionally wrong assertion failed, then green after restore); `node test/heavy-atoms.test.js` 64 pass / 0 fail; `npm run coverage` 429 tests / 428 pass / 0 fail / 1 skipped (pre-existing); coverage after: layout-competition 100 / 100 / 100 / 100 (was 0% before).

Acceptance debt, stated plainly: the bench-number acceptance for P1-2 / P1-3 / P2-1 / P2-3 still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is stopped on MiniMax Token Plan quota exhaustion. No bench numbers are claimed in this release.

## [0.5.10] - 2026-11-08

### Added
- **Intake atoms coverage (#60)**: `src/core/atoms/intake/preview-or-refine.js` (G1 `intake.preview_or_refine`) and `src/core/atoms/intake/recommend.js` (G5 `intake.recommend`) were at 0% coverage. Added `test/intake-atoms.test.js` (8 tests) covering intake preview/refine file writing with mode/summary/answers/constraints, context title fallback for the summary, change_id from input, the missing-change_id error, workflow recommendation (yolo for docs with no coverage gate, corps with a human checkpoint for payments) plus `workflow_recommendation.json` / `policy_effective.json` writing, and registry wiring for both atoms. Test evidence: new file 8/8 pass; full suite green on the merged tree; coverage after: preview-or-refine 100% (19/19), recommend 100% (20/20) (both were 0% before); all-files statements 86.78% → 86.97%.
- **Phase-run fail atom coverage (#61)**: `src/core/atoms/phase-run/fail.js` (D3d `phase_run.fail`, ~40 lines of failure-path state machine) was at 0% coverage. Added 7 tests to `test/heavy-atoms.test.js` alongside the existing D3 lifecycle tests, covering the success path (explicit session_id + summary + detail, session marked failed with stop_reason and failure persisted), resolving the most recent running session without a session_id, session_id from `context.runtime.phaseRunSessionId`, stop_reason fallback and the default `phase_run_failed` summary, an explicit `data_file` custom store, and the two error paths (missing mission, no session for the mission). Test evidence: RED→GREEN (stubbed-throwing implementation failed all 6 initial tests, then green after restore); `node test/heavy-atoms.test.js` 54 pass / 0 fail; coverage after: fail.js 100% statements / 94.44% branches / 100% functions / 100% lines (was 0% on all four; the single uncovered branch is the `process.cwd()` fallback, untested by design to avoid polluting the repo state).

Acceptance debt, stated plainly: the bench-number acceptance for P1-2 / P1-3 / P2-1 / P2-3 still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is stopped on MiniMax Token Plan quota exhaustion. No bench numbers are claimed in this release.

## [0.5.9] - 2026-11-08

### Added
- **Design atoms coverage (#57)**: `src/agent_team/atoms/design/` H2b/H2d/H2e atoms (competitor reconstruction review, reference surface lock, reconstruction pack) had no tests. Added `test/design-atoms.test.js` (10 tests) covering contract freezing, primary-surface selection, non-array input handling, lock-file writing and pack building. Test evidence: full suite green on the merged tree.
- **Memory atoms coverage (#58)**: `src/core/memory-state.js` and `src/core/atoms/memory/manage.js` / `mount.js` were at 0% coverage. Added `test/memory-atoms.test.js` (21 tests) covering create/list/mount/resolve defaults and filters, mission resolution via input, runtime and bindings file, and manage/mount against a temp-dir sqlite store (the `process.cwd()` fallback is exercised via `AS_XFLOW_DATA_FILE` pointed at a temp path, so no workspace pollution). No implementation changes: two initially failing expectations were test-side misreadings of `ensureArray` (truthy non-array values are wrapped, not reset). Test evidence: `npm run coverage` 404 tests / 403 pass / 0 fail / 1 skipped (pre-existing); coverage after: memory-state 100/100/100/100, manage 100/100/100/100, mount 100/100/100/100 (all three were 0% before); all-files statements 86.28% → 86.78%.

Acceptance debt, stated plainly: the bench-number acceptance for P1-2 / P1-3 / P2-1 / P2-3 still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is stopped on MiniMax Token Plan quota exhaustion. No bench numbers are claimed in this release.

## [0.5.8] - 2026-11-08

### Added
- **README Commands section (#54)**: README had no single command reference; top-level commands were only scattered through prose examples. A Commands section after "3 Minute Start" now lists all 31 top-level commands with a one-line description each, and states explicitly that the installed binary is `xflow` (there is no `evalid` binary). Every entry was checked against live `--help` output (`node bin/xflow.js --help` plus `xflow <command> --help` for all 31 commands, including subcommand lists for spec/qa/visual/launch/adoption/package/demo/goal/atom/host/compare). No CLI behaviour changed; docs only. Test evidence: `npm test` 46 files / 373 tests / 372 pass / 0 fail / 1 skipped (pre-existing).

### Changed
- **CI actions bumped to v7 (#55)**: `actions/checkout` v4 → v7.0.1 and `actions/setup-node` v4 → v7.1.0, in both workflows (ci.yml, npm-publish.yml — 4 pin sites). Both v4 actions ran on the Node 20 runtime and CI reported Node 20 deprecation warnings; v7 runs on node24 (`runs.using: node24`, read from the action.yml files), so the warnings go away. No behaviour change for this repo: the only trigger events are push / pull_request / release / workflow_dispatch, so checkout v7's fork-PR guard for pull_request_target / workflow_run does not apply; setup-node v7's removal of the dummy NODE_AUTH_TOKEN export does not affect npm Trusted Publishing (OIDC), which npm-publish.yml uses and which never sets NODE_AUTH_TOKEN; node-version stays '22' with cache: npm unchanged. Test evidence: `npm run verify` exit 0 on the merged tree.

Acceptance debt, stated plainly: the bench-number acceptance for P1-2 / P1-3 / P2-1 / P2-3 still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is stopped on MiniMax Token Plan quota exhaustion. No bench numbers are claimed in this release.

## [0.5.7] - 2026-11-08

### Added
- **c8 coverage config (#52)**: the repo previously had no coverage tooling. Added `c8` (^12.0.0) as a dev-dependency, `.c8rc.json` (covers `src/**` and `bin/**`, excludes `test/**`, reports to `coverage/`), and `npm run coverage`; `test/coverage-config.test.js` pins the wiring with 3 assertions; `coverage/` added to `.gitignore`; README dev-commands block gains one line. No runtime behavior changes. Test evidence: `npm run coverage` 372 tests / 372 pass / 0 fail (baseline 369, +3 new); measured coverage 84.64% statements / 62.73% branches / 94.02% functions, `coverage/lcov.info` generated. No bench numbers are involved; the bench-number acceptance for P1-2 / P1-3 / P2-1 / P2-3 still awaits the MiniMax full-matrix batch.

## [0.5.6] - 2026-11-07

### Changed
- **Playwright 1.59.1 → 1.65.0 (#49)**: dev-dependency bump; paired Chromium 158.0.8127.18 (build 1254) verified locally. Test evidence: `npm test` 363 tests / 362 pass / 0 fail / 1 skipped (pre-existing); `drift:scan` + `pack:check` green.
- **js-yaml 4.1.1 → 5.5.0 (major) (#50)**: dependency upgraded; the repo's only production use is `yaml.load` in `src/core/workflow-loader.js` (default schema) plus test-only loads of the two shipped workflows. Migration verified item by item before upgrading (2026-11-07, v4 vs v5 parsers run side by side): both `workflows/yolo.yaml` and `workflows/corps.yaml` parse deep-equal; scalar resolution is unchanged (`on`/`yes` stay strings, `017` stays decimal 17, `0o17` stays octal 15, `1:30` stays a string, anchors/aliases still resolve, duplicate keys still throw); empty input now throws `expected a document, but the input is empty` instead of returning `undefined` (the loader threw either way, the message is better). One real break, handled explicitly: v5's default CORE_SCHEMA no longer resolves the `<<` merge key — a merge key now survives as a literal `"<<"` property, and the loader rejects it with an actionable error ("Inline the merged mapping instead") instead of a confusing schema-validation failure. Pinning `YAML11_SCHEMA` was considered and rejected: it restores additive merging but flips scalars (`on`/`yes` → `true`, `017` → 15, `1:30` → 90) and throws on merge-with-override. The import form also changed with v5 (flat named exports, no default export): the four `import yaml from 'js-yaml'` sites now use `import * as yaml from 'js-yaml'`, call sites unchanged. Pinned by `test/workflow-loader-yaml5.test.js` (7 tests). No bench numbers are involved; the bench-number acceptance for P1-2 / P1-3 / P2-1 / P2-3 still awaits the MiniMax full-matrix batch.

## [0.5.5] - 2026-11-07

### Fixed
- **Missing package main entry `src/index.js` (#46)**: the published package had no main entry file, so `import '@surlymochan/evalid'` / `require('@surlymochan/evalid')` could not resolve. The entry module is added and pinned by `test/package-entry.test.js`.

### Changed
- **Dead code removed (#47)**: `writePlanMarkdown` (+ its only caller `buildPlanCommands`), `readPendingGate`, `getLatestMissionSession`, and `resolveAtom` — 51 lines deleted, 0 added. Each was verified dead by repo-wide grep (src, bin, test, docs, scripts, including string-form references): only the definition site remained, with no documentation references. None of the four was part of the public `src/index.js` export surface. Test evidence: full `npm run verify` exit 0 on the merged tree.

Acceptance debt, stated plainly: the bench-number acceptance for P1-2 / P1-3 / P2-1 / P2-3 still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is running — no bench numbers are claimed in this release.

## [0.5.4] - 2026-11-07

### Fixed
- **Phase-cost drift test stops flaking under load (#44, issue #5 P1-1)**: the two `within_tolerance` integration tests used 2 x 400 ms sleeps, so the 5% drift budget was 40 ms against tens of ms of fixed executor overhead outside phases (run setup plus `phase_completed` log / state writes). On main this tripped at 5.7% drift while the MiniMax batch was running, then the same file went 7/7 green on a quiet re-run — a load-dependent flake at a marginal threshold, not an accounting bug (the accounting correctly flagged the drift). The sleeps are now 2 x 1500 ms, putting the same overhead at ~2% of the phase sum with headroom under load. Production tolerance and accounting unchanged. Test evidence: `node test/phase-cost.test.js` 7/7 green; full `npm run verify` exit 0 (43 files, 361 tests, 360 pass, 1 skipped pre-existing, 0 fail).

Acceptance debt, stated plainly: the bench-number acceptance for P1-2 / P1-3 / P2-1 / P2-3 still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is running — no bench numbers are claimed in this release.

## [0.5.3] - 2026-11-07

### Fixed
- **Bench openswarm planner timeout raised 300s → 600s (#41)**: the 300s cap was calibrated on DeepSeek, whose planner finished in 87–244s on the 6 pilot instances. With MiniMax M3.1-Flash-Preview at high thinking the planner exceeds 300s on all 6 pilot2 cells: killed mid-work (rc 143) before writing the task file, so the executor never ran and all 6 cells recorded false negatives (wall ~301s). 600s keeps planner + executor inside the CAP_S 1200s cell budget; the executor budget is derived from the remaining time.
- **Bench openswarm planner prompt tightened to read-only planning (#42)**: the 600s validation cell (pylint-8898) showed the planner spending 13 turns / 23 tools exploring (openswarm lane serve/assign probes, full-disk find for pylint wheels) and getting killed (rc 143) before writing the task file — raising the budget alone cannot fix that. The planner now reads only the skill text and the task, runs no shell command, does not reproduce / explore / list / search, launches no other program, writes the task file + verify command, then stops. The 600s planner timeout from #41 is unchanged. Test evidence: new `bench/swebench/test_planner_prompt.py` (7 tests, stdlib-only via ast so CI can run it without pandas/swebench) + node wrapper `test/bench-planner-prompt.test.js`; bench Python suite 35/35, full `npm test` green.

Acceptance debt, stated plainly: the bench-number acceptance for P1-2 / P1-3 / P2-1 / P2-3 still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3) — no bench numbers are claimed in this release.

## [0.5.2] - 2026-11-07

### Fixed
- **Bench grading no longer silently zeroes on relative paths (#38)**: `run.py` / `regrade.py` passed `--raw-root` / `--raw` through unresolved, but `swe_env.grade()` runs `git apply <test.patch>` with `cwd=<cell repo>` — with a relative raw root every cell failed grading with `test_patch did not apply` and `run.py` recorded it as an ordinary `resolved: false`. `run.py` now resolves `--out` / `--raw-root` / `--predictions-dir` to absolute paths up front, `regrade.py` resolves `--raw`, and `grade()` writes `grade.json` on the test_patch-apply early return (previously the failure path wrote nothing, which is how this stayed invisible). Found during the 2026-11-06 bench rebuild: the first MiniMax pilot went 4/4 on this error before diagnosis.

### Added
- **P2-2 15-instance bench set validated (#39, issue #5 P2-2)**: the 3 round-3 additions (sympy-15599, sympy-19040, sympy-24213) have passed the gold-patch check — `harness/validate.py` over all 15 ids in `instances.json` (fa7ea30): 15/15 ok, no errors (`bench-env/validate-15.log`, 2026-11-06 19:35 UTC). `round3_extension.pending_validation` is cleared, the validated ids are recorded, and `test_instances.py` now pins the validated state. The issue #5 P2-2 checkbox is ticked; the bench-number acceptance for P1-2 / P1-3 / P2-1 / P2-3 still awaits the MiniMax full-matrix batch — no bench numbers are claimed here.

## [0.5.1] - 2026-11-07

### Added
- **Per-process read cache for the review gates (issue #5, P1-2 follow-up to #34)**: one gate run used to read the same source file several times — I6c for symbols, implementation sources and test review, J6 for spec alignment and then test follow once per changed code file. Both gates now read through a per-process cache keyed by the P1-3 stat anchor (size, mtime_ns, inode): each unchanged file is read from disk once per run and served from memory on later reads, while a changed file is re-read instead of served stale (a mid-read change is retried once, like the seal's `read_with_anchor`). J6 keeps its self-contained copy of the cache and does not import tdd_lib. Both proofs report `read_cache` (`disk_reads` / `cache_hits`) so the skipped re-reads are observable. No verdict logic changed; the token acceptance still needs a benchmark-environment rerun — no performance numbers are claimed here.
- **Stat-anchored gate verification (issue #5, P1-3)**: the TDD seal now records a stat anchor (size, mtime_ns, inode) per sealed file alongside its sha256 — tree anchors and snapshot-copy anchors in the proof's snapshot scope, bound into the proof like the scope itself. Proof validation (I6b) and the CR review seal partition (J6) stat-check first and re-read + re-hash only files whose anchor moved, instead of re-reading every sealed file on every gate pass; proofs sealed before the anchors existed fall back to the full re-read. Validation reports `reread_files` / `reread_count` and the seal partition reports `stat_checked`, so the skipped re-reads are observable. The token acceptance (median tokens incl. cache ≤ 2.0M) still needs a benchmark-environment rerun — no performance numbers are claimed here.

### Changed
- **Bench harness runs all four SWE-bench arms at high thinking effort**: `run_pi()` in `bench/swebench/harness/arms.py` and `bench/swebench/harness/pi_shim.sh` now set `--effort high` at both pi call sites, so the workflow remains the only variable across arms. The archived DeepSeek tables were recorded with the settings of their time and are not affected.

## [0.5.0] - 2026-11-06

### Added
- **CR review seal partition (issue #5, P1-2)**: the J6 review proof (`cr/review-0.json`) now splits the changed files into `sealed_unchanged` (bytes still identical to the green TDD proof's sealed hashes) and `seal_drifted`, with a `reread_count`. The yolo skill's verify-consistency guidance uses the partition so the review pass re-reads only drifted files instead of everything the gate already verified. Reporting only — verdicts are unchanged, and without a green seal the partition is `null` and everything is re-read.
- **Bench Verified set extended to 15 instances (issue #5, P2-2)**: `bench/swebench/instances.json` grows from 12 to 15, adding sympy-15599, sympy-19040 and sympy-24213, and a structural validation of the instance set (`bench/swebench/test_instances.py`) now runs in CI. Gold-patch checks for the three new instances stay pending the benchmark environment.
- **Bench report aggregates median (IQR) (issue #5, P2-1)**: `bench/swebench/report.py` now aggregates per-arm wall-clock, token and cost results with q1/median/q3 and presents them as median (IQR); reps isolation and the aggregation itself are pinned by `bench/swebench/test_reps_report.py`. Live multi-rep runs stay pending the benchmark environment.
- **P0-2 acceptance pinned against saved pre-fix patches (issue #5, P0-2)**: regression tests in `bench/swebench/test_diff_filter.py` run the saved pre-fix patches through the evidence filter (`specs/`, `.xflow/`, `.as-xflow/` excluded from solution patches). The saved 9.7 MB evidence-laden patch filters down to 4.3 KB, and every saved patch lands under the 200 KB acceptance line.

## [0.4.1] - 2026-11-06

### Fixed
- **TDD gate counts skipped/todo tests again on Node 24**: the gate parsed skip/todo counts only from the TAP reporter's `# skipped / # todo` summary lines, but Node 24's built-in runner defaults to the spec reporter when piped, whose summary lines carry a `ℹ` marker — an all-skipped/todo run exited 0, parsed as zero skips, and was waved through as green. The parser now reads the runner's summary block in both reporter formats (anchored to the summary lines, gated on the full node signature), and fails closed: a node summary whose gate counts cannot be fully parsed classifies as `counts_unknown` and is rejected by proof validation (`tests_counts_unknown`) instead of reading as zero skipped.

### Added
- **Phase cost evidence on every run (issue #5 P1-1)**: the per-phase timing/token report (`src/core/phase-cost.js`, landed in 0.3.0) now also rides on the `workflow_failed` execution-log event — a run that stops mid-way still reports where its time and tokens went — and is persisted as a standalone artifact at `.as-xflow/phase-cost.json` on both completion and failure, so the breakdown is readable without mining the ndjson execution log. Acceptance rerun on the SWE-bench cells stays pending the benchmark environment; the accounting structure (phase sum vs wall clock within 5%) is covered by `test/phase-cost.test.js`.

## [0.4.0] - 2026-11-04

### Changed
- **Overhead cut 1 (v0.4 F2, issue #5 P1-2/P1-4)**: the lite (yolo) track seals the TDD red proof immediately after `plan` — the issue/branch ceremony no longer sits between planning and red-proof, and the planning pass now authors the failing test, so plan and red share one agent pass. `xflow workflow run --title "..."` also derives the change id from the title when the branch cannot provide one (previously a hard stop on `main` that pushed agents into manual atom-by-atom driving). TDD snapshots are scoped: inside a git work tree I6a seals only the files that differ from HEAD plus the files the test command names, and I6b materializes the rest from the recorded HEAD at replay — on the SWE-bench sympy tree the sealed manifest drops from 1,543 files / 164 KB to the changed files only (2 files / 197 B for a one-file change), and the snapshot copy from 26.9 MB to ~51 KB. Proofs sealed before this change keep verifying (the scope joins the binding only when present).

### Added
- **CR gate `J6.cr.review` wired into the verify stage (v0.4 F1)**: closes the v0.3.0 known gap where J6 was registered and unit-tested but no workflow phase invoked it. The yolo `verify-consistency` phase and the corps `qa` phase now run J6 on every change — after the spec-delta review, before the stage flips to verify — and declare its verdict record `specs/changes/<change_id>/cr/review-0.json` as a required artifact. A failing verdict (spec misalignment, changed code with no test follow, net assertion decrease, blown loop budget) stops the workflow at verify instead of waving the change through to archive. Orchestration evidence: `test/cr-review-wiring.test.js` drives the real yolo verify phase through `WorkflowExecutor` against a git fixture — an aligned, tested change passes with a verdict record, and an untested change is stopped at the phase.
- **SWE-bench predictions emitted directly by `run.py` (v0.4 F3)**: the bench harness no longer relies on a one-off converter outside the repo. A stdlib-only `bench/swebench/harness/predictions.py` builds records with exactly `instance_id`, `model_name_or_path`, `model_patch`, re-applies the P0-2 evidence filter (`specs/`, `.xflow/`, `.as-xflow/`) on both paths, and upserts per-arm files so resumable reruns never duplicate lines; `run.py --export-predictions` rebuilds the same files from saved patches with no model calls. Regression: all four pilot arms rebuilt through the new path are byte-identical to the hand-converted pilot files (`cmp` = 0 across 24 instances), and the largest openflow-arm patch stays at 9,650 bytes, well under the 200 KB line.
- **`xflow init` writes the project `.gitignore` (v0.4 F4)**: init now creates or merges `.gitignore` entries for evalid local state (`.as-xflow/`, `specs/changes/`), appending only the entries that are missing and never modifying existing lines; `.xflow/` stays tracked on purpose (`GOAL.md` is a reviewable project document). Re-running `init --force` tops up projects initialized before v0.4. Closes the v0.3.0 known gap.

## [0.3.1] - 2026-11-04

### Changed
- **Renamed: OpenFlow → evalid.** The repository is now `surlymochan/evalid` (old links redirect) and the npm package is now `evalid`. Same code and behaviour as 0.3.0; the rename matches the repositioned first screen — a runtime verification layer for coding agents ("Claimed ≠ verified"). The `xflow` CLI name is unchanged in this release.

## [0.3.0] - 2026-11-04

### Added
- **SPEC clarification gate `J4d.spec_clarify.gate`** (#11): blocks ambiguous specs before the loop starts. Flags MUST clauses with no quantified anchor, missing WHEN/THEN scenarios, vague wording (EN/CN tables) and TBD/placeholder text; every finding carries an answerable clarification question. Available as `xflow spec clarify` and wired into the yolo/corps proposal-consistency stage.
- **Code review gate `J6.cr.review`** (#10): deterministic review checks — spec alignment (zero alignment fails), test-follow (untested changes fail unless `cr_allow_untested` is declared in status), net assertion decrease fails, test files may not be edited to force green, and a loop budget (default 10 files / 400 lines; warn over budget, fail at 2x).
- **Test gate v2 checks in `I6c`** (#12): rejects expected values sourced from the implementation itself, dead-callback assertions, and self-comparison tautologies. Adds per-phase cost accounting (`src/core/phase-cost.js`): wall-clock and token spend per phase, flagged when it diverges from total wall-clock by more than 5%.

### Fixed
- **Benchmark evidence no longer leaks into solution patches** (#8): `run.py` now excludes `specs/` when generating `solution.diff`, with a second filter in the harness (regrade strips it from old patches too). A real openflow-arm patch shrank from 17.0 MB to 24 KB — 99.9% of it was evidence files, not code.
- **Per-run uv cache** (#8): `UV_CACHE_DIR` is set per run instead of sharing one cache across benchmark arms.
- **CI runner pinned to `ubuntu-24.04`** (#9): Playwright 1.59.1 does not support chromium on ubuntu 26.04, which silently killed the verify job.

### Docs
- Added `CONTRIBUTING.md` and issue/PR templates (#8, #11, #10). Workflow manual atom count updated 83 → 85.

### Known gaps
- `J6.cr.review` is registered and tested but not yet wired into the yolo/corps verify stage (planned for v0.4).
- `xflow init` does not yet add OpenFlow artefacts to the user project's `.gitignore` (planned for v0.4).

## [0.2.2] - 2026-10-18

### Docs
- Added the SWE-bench Verified results to the README and `bench/swebench/`: 6 hard sympy, pytest and pylint instances on DeepSeek-V4.1-Flash (`deepseek-flash`), n=1 per cell.
- Corrected the first published results after a pytest temp-directory race in grading: `pytest-5787` and `pytest-6197` became resolved for all arms; `pytest-10356` is unresolved by every arm. See the [regrade notes](bench/swebench/README.md#regrade-2026-10-18).
- Linked the [optimization backlog issue #5](https://github.com/surlymochan/openflow/issues/5).

No CLI or gate changes in this release.

## [0.2.1] - 2026-10-17

### Changed
- TDD proofs are bound to a tree snapshot. `I6b` recomputes the binding and re-runs the recorded command. Green also checks that snapshotted test files still match disk.
- Red and green must run the same test, or green must be a superset. Skip, todo, and focused tests do not count. Import-only or empty failures do not count as red. Type-only assertions fail when they are the only assertions.
- `J4b` fails when the same subject has contradictory `MUST`/`SHALL` verb/value clauses.
- `self.assert*`, `pytest.raises`, and bare `assert` count as assertions.
- `tdd_mode` `refactor` and `docs` (status.json or `--tdd-mode`) are the exemption path for an honest refactor or a docs-only diff. Misuse fails.

## [0.2.0] - 2026-10-17 (relaunch)

### Added
- Policy overlay execution mode: `xflow policy validate`, plus policy, notify, storage, plugin and
  experience-digest atoms.
- `xflow intake recommend` for adaptive yolo/corps track selection.
- `xflow profile show|set` for execution profiles.
- `xflow compare super-assistant`.
- `docs/assets/demo.gif`, recorded from a real CLI run, and a README rewrite.
- `CHANGELOG.md`.

### Changed
- The npm package is now named `@surlymochan/openflow`, because the unscoped `openflow` name is taken. The CLI is still `xflow`.
- `package.json` adds repository/homepage/bugs/keywords/author, `engines.node >= 22.5` and public `publishConfig`.
- The `xflow serve` fallback message no longer links to an unpublished repository.

### Fixed
- `agent_invoke` no longer crashes with an uncaught `EPIPE` when an agent CLI exits before reading its stdin prompt. This fixes an intermittent `heavy-atoms` test failure.

## [0.1.0] - 2026-05-25

### Added
- First public extraction:
  - YAML workflows (`yolo`, `corps`) validated against the atom registry.
  - Red/green TDD proof gates and a test-quality review.
  - Handoff and AHA state, archive ordering, and the `xflow` CLI.
- Adapters: `xflow adapter import-file` and `xflow adapter github-issue`.
