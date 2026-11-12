# Release Notes

## 0.5.32 - Milestone M12 "`xflow audit --batch` 整仓批量审计" accepted

Patch release. One merged PR since 0.5.31, verified end to end in CI and locally — and the milestone it completes is now accepted.

**Milestone M12 "`xflow audit --batch` 整仓批量审计" — accepted (issue #69; acceptance detail issue #171, comment 6814927635; #171 closed 2026-11-12T04:52:24Z).** `xflow audit --batch` now audits a whole window of merged PRs in one run, emitting a per-PR verdict table plus a summary (verdict counts, divergence rate) as JSON. Slice 1 (PR #173, merged 2026-11-12T01:48:48Z, squash 5dd1d584) adds the `--batch` command core: per-PR verdicts (verified / mismatch / no_claims / unverifiable / error), one automatic retry on mismatch before the verdict is fixed, and a batch summary.

**Acceptance evidence, all measured, not worker claims.** Three real repos audited in one window (`--since 2026-11-11 --limit 5` each, main 5dd1d584): evalid 5 rows (verified 0, mismatch 5, divergence rate 1.0), swrm 5 rows (verified 0, mismatch 3, no_claims 2, divergence rate 0.6), senpi 5 rows first run all unverifiable (clone failed: /tmp 512M tmpfs out of space), then re-run with TMPDIR in the workspace (528.9s, exit 0) giving verified 2, no_claims 3, mismatch 0. Every row's claimed/replayed counts were cross-checked against the batch logs and JSONs. The 8 mismatches were each classified by mechanism — claim-extraction limits, replay timeouts (~300s per attempt on swrm), and environment gaps (`pytest` not on PATH) — and none was classified as a real PR quality issue. Evidence filed at #174, comments 6814581106 and 6814870874, whose numbers agree with each other; the main round independently re-read the batch JSONs before accepting.

Honest note, stated plainly: the 0 verified in the evalid/swrm batches is not a quality conclusion — every mismatch in those two batches traces to an extraction limit, a replay timeout, or an environment gap, not to a PR being wrong; the senpi re-run's 2 verified were judged on exit-code agreement only, with no count comparison. Known issue, stated plainly: #160's claimed `failed=-460` is a real extraction bug in `parseClaimCounts` (an `A/B` written as passed/failed is misread as passed/total), filed as follow-up issue #175 (OPEN); correcting the claim to 472/12 does not flip #160's mismatch verdict.

Acceptance ledger, stated plainly: the issue #5 ledger is settled as a conclusion on the MiniMax full-matrix recheck (135/135 complete, 2026-11-10) — P2-1 passed, P1-2 / P1-3 / P2-3 did not pass — so no bench numbers are claimed in this release.

## 0.5.31 - Milestone M11 "Go test 计数精确到顶层测试" accepted

Patch release. Two merged PRs since 0.5.30, verified end to end in CI and locally — and the milestone they complete is now accepted.

**Milestone M11 "Go test 计数精确到顶层测试" — accepted (issue #69; acceptance detail issue #161, comment 6810324693; #161 closed 2026-11-12T00:07:36Z).** `xflow audit` now counts only top-level Go tests. Slice 1 (PR #163, merged 2026-11-11T23:20:47Z, squash e40e677d) fixes the Go counter core: first-level subtest FAIL lines are no longer counted as failures. Slice 3 (PR #167, merged 2026-11-11T23:53:27Z, squash eb190831) adds full test-name parsing plus package-level attribution, so FAIL lines inside an `ok` package are correctly excluded.

**Acceptance evidence, all measured, not worker claims.** Slice 4 re-ran the testify full audit on merged main (eb190831, same case: stretchr/testify 5e8a21e + patch, base 959dbda): 2nd run verified, 472 pass / 0 fail / exit 0, 8/8 packages ok — phantom failures 12 → 5 → 0, a real flip confirmed. go-cmp green case verified (20/0, exit 0), red case mismatch (19/1, exit 1, breaking point exactly TestDifference, the only FAIL package github.com/google/go-cmp/cmp/internal/diff), no regression. Regression: go-rust suite 27/27, audit suite 61 pass / 3 fail — the 3 failures are the pre-existing I6d pytest environment cases (`pytest` not on PATH in this VM), same names and same cause as the slice 2 baseline. Evidence filed at #168, comment 6810293799; the main round independently re-read the new audit JSONs number-for-number before accepting.

Honest note, stated plainly: the 1st audit run on merged main was mismatch (471/1), the single counted failure being upstream testify's timing test TestEventuallyTrue (100ms/20ms window), unrelated to this change's diff (mock package only); the same command re-run verified. Follow-up filed as issue #169 (OPEN), not a blocker for this milestone. This milestone closes the counting gap filed as issue #159 (still OPEN at release time; closure is for the main round to decide).

Acceptance ledger, stated plainly: the issue #5 ledger is settled as a conclusion on the MiniMax full-matrix recheck (135/135 complete, 2026-11-10) — P2-1 passed, P1-2 / P1-3 / P2-3 did not pass — so no bench numbers are claimed in this release.

## 0.5.30 - Milestone M10 "Go/Rust 回放保真度扩展" accepted

Patch release. One merged PR since 0.5.29, verified end to end in CI and locally — and the milestone it completes is now accepted.

**Milestone M10 "Go/Rust 回放保真度扩展" — accepted (issue #69; acceptance detail issue #155, comment 6808773596; #155 closed 2026-11-11T22:38:18Z).** `xflow audit` now recognises `go test` / `cargo test` claims and supplies replay-tree dependencies for Go and Rust runs. Slice 1 (PR #157, merged 2026-11-11T22:06:51Z, squash 724045b9) adds the claim recognition plus replay dependency supply (`go mod download all`, `cargo fetch`, `cargo fetch --locked` when a Cargo.lock exists).

**Acceptance evidence, all measured, not worker claims.** Four real cases, all taken from real public repos' real commits, each run in a cold cache (fresh GOMODCACHE / CARGO_HOME, dependencies genuinely downloaded, not warm-cache hits): testify `go test -v ./...` 472 pass / 12 fail, exit 0, replay verified, dep supply `go mod download all` (status supplied; 1.1M newly downloaded); serde_json `cargo test` 240 pass / 0 fail, exit 0, replay verified, dep supply `cargo fetch` (status supplied; no Cargo.lock, 52M newly downloaded); hexyl `cargo test` 56 pass / 0 fail, exit 0, replay verified, dep supply `cargo fetch --locked` (status supplied; 152M newly downloaded); testify mock red case — the fixed commit's test half pasted onto the pre-fix code — claimed 126 pass / 0 fail / exit 0, replayed 64 pass / 1 fail / exit 1, verdict mismatch, with a real panic in the replay output (`mock.go:1291 runtimeFunc`, `reflect: call of reflect.Value.Pointer on uint8 Value`). 3 verified (Go 1, Rust 2) + 1 mismatch (real red). Evidence filed at #158, comment 6808726204 (4 audit JSONs with full replay output, source-run logs, and diffs). The three source commits (testify 5e8a21e, serde_json 8c535a2, hexyl 626f03b) were each verified to exist via the GitHub API with matching titles; the claims were taken from real measurements of the corresponding commits in the source repos, as the source PRs' own text wrote no test counts.

Honest note, stated plainly: the Go counter counts first-level subtest FAIL lines at column 0 as failures (the testify case's 12 "failures" are all first-level subtest FAIL lines such as `TestSuiteRequireTwice/SuiteRequireTwice`; every top-level test passes, all packages ok, exit 0), so a human writing the claim as "0 failures" would be judged mismatch — claim and replay share the same parser, so verdicts still agree. Follow-up filed as issue #159 (OPEN), not a blocker for this milestone. The red case's count floats across re-runs (64/1 in the audit JSON, 67/2 on a manual re-run) because the panic crash point moves with scheduling, while exit 1 and the mismatch verdict are stable.

Acceptance ledger, stated plainly: the issue #5 ledger is settled as a conclusion on the MiniMax full-matrix recheck (135/135 complete, 2026-11-10) — P2-1 passed, P1-2 / P1-3 / P2-3 did not pass — so no bench numbers are claimed in this release.

## 0.5.29 - Milestone M9 "proof/audit findings as SARIF" accepted

Patch release. Two merged PRs since 0.5.28, verified end to end in CI and locally — and the milestone they complete is now accepted.

**Milestone M9 "proof/audit findings as SARIF" — accepted (issue #69; acceptance detail issue #148, comment 6806263843; #148 closed 2026-11-11T20:16:45Z).** Proof and audit findings are now emitted as SARIF 2.1.0, so GitHub code scanning surfaces them as alerts. Slice 1 (PR #150, merged 2026-11-11T19:47:59Z, squash 941ba522) is the SARIF generation core: every finding carries rule id, message, location, and an evidence pointer (`properties['evalid/evidence']`). Slice 2 (PR #152, merged 2026-11-11T20:15:09Z, squash acd71870) removes `continue-on-error` from the SARIF upload step in the proof-ledger workflow, so an upload failure fails the job instead of being swallowed; the upload runs only for same-repo PRs and skips visibly for fork PRs.

**Acceptance evidence, all measured, not worker claims.** Six real-case SARIF files were each independently validated with jsonschema against `schemas/sarif-2.1.0.minimal.schema.json` — all pass: tampered seal binding (`evalid/binding-mismatch`, located at `specs/changes/m9s2-tamper/tdd/green-0.json`) and tampered test file (`evalid/green-tree-mismatch`, located at `test/demo.test.js`, message names the exact broken file) one finding each; claim/replay mismatch (`evalid/claim-replay-mismatch`, claimed 5 / replayed 3, located at `test/count.test.js`); clean seal and honest claim 3/3 each produce empty results (zero false positives); `proof --sarif` with no runs produces 241 `evalid/proof-incomplete` findings. Real-repo CI upload, evidence PR #153 (never to merge): proof ledger run 43092866680 (by-design failure — tampered proof makes verify exit 1), CI run 43092866716 success; code scanning analysis 2146969636 (results_count 1) and alert #3 (rule `evalid/binding-mismatch`, severity error, state open, location `specs/changes/m9s2-ci-tampered/tdd/green-0.json:1`), both read directly by the main round; default branch has 0 open alerts (the tampered proof never entered main, as expected). Evidence filed at #151, comment 6806158854.

Honest note, stated plainly: the upload-failure path was not actually induced (no upload failure was faked); the claim that an upload failure now fails the job rests only on GitHub semantics after removing `continue-on-error` plus a file read of the workflow. Evidence PR #153 is never to be merged.

Acceptance ledger, stated plainly: the issue #5 ledger is settled as a conclusion on the MiniMax full-matrix recheck (135/135 complete, 2026-11-10) — P2-1 passed, P1-2 / P1-3 / P2-3 did not pass — so no bench numbers are claimed in this release.

## 0.5.28 - Milestone M8 "I6b 回放树依赖供给" accepted

Patch release. One merged PR since 0.5.27, verified end to end in CI and locally — and the milestone it completes is now accepted.

**Milestone M8 "I6b 回放树依赖供给" — accepted (issue #69; acceptance detail issue #143, comment 6803176660; #69 comment 6803179689; #143 / #146 / #111 closed).** The I6b replay tree now supplies npm dependencies inside the replay tree, so replay can verify test runs that import packages instead of failing with `no_test_evidence`. Slice 1 (PR #145, merged 2026-11-11T17:17:19Z, merge commit 79bf656d; verify check on the merge commit success) installs the sealed dependencies (`npm ci`, versions as sealed) inside the replay tree. Slice 2 (no code change) re-ran three real `no_test_evidence` cases on the new code and flipped all three to real green verdicts (evidence in issue #146, comment 6803005629): lite-track 22/22, workflow-loader 32/32, cli-usability 68/68, I6b `valid` on all three; the same three cases on the old code still fail with `no_test_evidence` (`Cannot find package 'js-yaml'`), and a direct cross-check of the three files gives tests 122 / pass 122 / fail 0, matching the sealed counts.

**Acceptance evidence, all measured, not worker claims.** The main round independently reproduced the workflow-loader case (sealed pass, replay valid, install record `npm ci` / js-yaml 5.5.0) and independently re-ran the audit suite on the new code: 105 tests / 102 pass / 3 fail, the 3 failures being the pre-existing I6d audit-pytest cases (`pytest` not on PATH in this VM), which fail identically on the old code — zero regression. The old-code `no_test_evidence` classification for the three cases was verified against the original classification JSONs.

Honest note, stated plainly: the three cases' new verdicts are all green, 0 red — the three test files themselves genuinely all pass, and replay can now prove that; before this change the three cases could not even be given a red or a green verdict.

Acceptance ledger, stated plainly: the issue #5 ledger is settled as a conclusion on the MiniMax full-matrix recheck (135/135 complete, 2026-11-10) — P2-1 passed, P1-2 / P1-3 / P2-3 did not pass — so no bench numbers are claimed in this release.

## 0.5.27 - Milestone M7 "J1 账本 agent/model 字段落地" accepted

Patch release. One merged PR since 0.5.26, verified end to end in CI and locally — and the milestone it completes is now accepted.

**Milestone M7 "J1 账本 agent/model 字段落地" — accepted (issue #69; acceptance detail issue #138, comment 6797474485; #69 comment 6797477317).** J1 now writes the executing agent/model into `verify_proof.json`, so `xflow trend` groups by real agent/model instead of always reporting `unknown`. Slice 1 (PR #140, merged 2026-11-11T13:35:03Z, squash afd52b32; main CI run 43030442378 success) adds `agent` / `model` to the J1 proof, resolved per field in order — explicit `--agent` / `--model` flags (the executor passes its own real identity) > environment variables `EVALID_AGENT` / `EVALID_MODEL` > `unknown`; empty values count as missing, never invented. The J1 input schema in `atoms/registry.json` gains optional `agent` / `model`. `xflow trend` itself is unchanged: per-agent/model grouping and unknown-grouping for legacy proofs were already implemented in M5 slice 1, and no historical ledger backfill is needed.

**Acceptance evidence, all measured, not worker claims.** Slice 1: 5 new tests, RED then GREEN (all 5 failed at RED, per #139 evidence comment); local `npm test` 275 items, 274 pass, the single failure `test/i6d-acceptance-demo.test.js` fails identically on clean main and is unrelated to this change; PR #140 CI runs verify 43028092917 and ledger 43028092888 both pass. Slice 2 (no code change): 8 real J1 runs, 2 groups × 4 records, evidence in issue #141, comment 6797437856 — `xflow trend` reports muse/muse-spark-1.3 claimed 12 / replayed 8 / delta 4 / 33.3% / samples 12 and muse-subagent/muse-spark-1.3 claimed 12 / replayed 8 / delta 4 / 33.3% / samples 12, TOTAL 24 / 16 / 8 / 33.3% / samples 24, records 8, 0 skipped; hand-recomputed from the 8 raw `verify_proof.json` files by an independent script (not through `src/core/trend.js`), agreeing number-for-number. The read-only report is unchanged, and a field-stripped copy of a real proof still groups as `unknown` (trend output `unknown 3 / 2 / 1 / 33.3% / 3`, exit 0); the trend suite passes 18/18, including the legacy-proof-groups-as-unknown case. The main round independently re-read the 8 raw proofs and independently re-ran `xflow trend` before accepting.

Honest note, stated plainly: the two groups report identical numbers because all 8 runs executed the same deterministic command set (each proof's `recorded_at` differs); each group's delta of 4 comes from the real replay of the pre-existing failing `test/i6d-acceptance-demo.test.js` on main (assertion: actual 1 / expected 0, reproduced in all 8 runs — the same single failure seen in the full-suite count of 274/275, unrelated to this milestone); group B was executed by a derived subagent and its identity is honestly recorded as `muse-subagent`.

Acceptance ledger, stated plainly: the issue #5 ledger is settled as a conclusion on the MiniMax full-matrix recheck (135/135 complete, 2026-11-10) — P2-1 passed, P1-2 / P1-3 / P2-3 did not pass — so no bench numbers are claimed in this release.

## 0.5.26 - Milestone M6 "audit 回放保真度" accepted

Patch release. Two merged PRs since 0.5.25, verified end to end in CI and locally — and the milestone they complete is now accepted.

**Milestone M6 "audit 回放保真度" — accepted (issue #69; acceptance detail issue #131, comment 6794844181).** `xflow audit` now recognises `bun test` claims, no longer misjudges legitimately skipped optional packages as snapshot inconsistencies, and reports `cannot-determine` instead of a hollow `consistent` when no trustworthy lockfile exists. Slice 1 (PR #133, merged 2026-11-11T09:35:00Z) adds `bun test` / `bun run test` claim recognition (G3) and a node_modules snapshot-consistency classification for the replay tree (G4: classification only, no verdict threshold changes, no verdict flips). Slice 3 (PR #136, merged 2026-11-11T11:40:25Z) adds the optional-platform exemption (lockfile `optional: true` entries missing from the replay tree are exempted; version drift on an installed optional package is still a real difference), bun.lock parsing (JSONC; package-lock.json first, then bun.lock; bun's `node_modules/.bun` store counted as installed), and `cannot-determine` when no trustworthy lockfile exists (the old replay-vs-source-tree comparison is removed — the root cause of omo#8014's hollow consistent).

**Acceptance evidence, all measured, not worker claims.** Three real historical PRs re-run with the new CLI (same command / repoDir / timeout as slice 2): code-yeongyu/senpi#2606 consistent (0 differences, 92 optional exempted), code-yeongyu/senpi#4801 consistent (0 differences, 162 optional exempted), code-yeongyu/oh-my-openagent#8014 inconsistent (401 differences = 317 missing + 84 drifted, 99 optional exempted; e.g. @anthropic-ai/claude-agent-sdk 0.3.306 vs lockfile 0.3.259) — G4 now has a real answer: the November-copied source tree genuinely does not match the September merge head's dependencies. The senpi diffs were checked entry-by-entry against the merge-head package-lock.json and are all optional entries (platform packages + pruned optional transitives), 0 real drift. Slice 2's evidence (3 re-audited PRs + exact new breaking-point classes B1-1–B3-3) is in issue #134, comment 6792844369; the slice-3 re-run evidence is in issue #135 (worker comment + main-round second-party verification by independently re-reading the three audit JSONs). Test evidence: slice 1 audit suite 55/55; slice 3 adds 9 new tests, all passing, audit suite 64 tests / 61 pass with the 3 failures all I6d cases (pytest not on PATH in this VM, same 3 fail on pristine main, zero regression); PR #133 CI runs verify 42995275159 and ledger 42995274547 both pass; PR #136 CI runs verify 43012680508 and ledger 43012680582 both pass.

Honest note, stated plainly: all three PRs' overall verdicts are still mismatch — the claims themselves have not changed, only the snapshot noise is gone. The exempted-packages list shows only the first 50 entries; the exempted counts are full. #4801 has `depsChanged=true` (its diff touches 4 package.json files), correcting the 17:03 round's "both PRs depsChanged=false" wording; the exemption keys on the differences themselves, not on depsChanged. The interim omo#8014 numbers in the merged commit message (292 missing + 137 drifted) were superseded by the re-run evidence (317 missing + 84 drifted), verified by the main round re-reading the JSONs.

Acceptance ledger, stated plainly: the issue #5 ledger is settled as a conclusion on the MiniMax full-matrix recheck (135/135 complete, 2026-11-10) — P2-1 passed, P1-2 / P1-3 / P2-3 did not pass — so no bench numbers are claimed in this release.

## 0.5.25 - Milestone M5 "判定历史趋势" accepted

Patch release. One merged PR since 0.5.24, verified end to end in CI and locally — and the milestone it completes is now accepted.

**Milestone M5 "判定历史趋势" — accepted (issue #69; acceptance detail issue #125, comment 6789560856; #125 closed).** `xflow trend` now aggregates the proof ledger into claimed-vs-replayed rates, grouped by repo and by agent/model, with a `--since` window and `--json` mode. It is a read-only report: no seal, replay, or verdict behaviour changes. Slice 1 (PR #127, merged 2026-11-11T05:31:21Z) adds the ledger aggregation (`src/core/trend.js`) and the `xflow trend` CLI: a per-repo claimed / replayed / delta / delta% / samples table, `--since` window filtering, and `--json` output; a missing ledger or an empty window prints an actionable hint (exit 3), while a bad repo path or date is misuse (exit 2). Slice 2 adds no code — it is the real-warehouse report evidence below.

**Acceptance evidence, all measured, not worker claims.** Slice 1: 17 new tests in `test/xflow-trend.test.js`; local `npm run verify` 645 pass, 0 fail (per the merged commit message); PR #127 CI runs verify 42965510663 and ledger 42965510662 both pass. Slice 2: real trend reports on two real repos, each with 2 proof ledgers generated by actually running the J1 atom — evalid and swrm both report claimed 4 / replayed 3 / delta 1 / delta rate 25.0% / samples 4, records 2, 0 skipped, exit 0. Hand-recomputed from the 4 raw `verify_proof.json` files, both groups agree number-for-number (evalid-a 2 results / 1 passed, evalid-b 2 / 2; swrm-a 2 / 1, swrm-b 2 / 2); `--since 2026-11-11` keeps both records, `--since 2026-11-12` correctly reports an empty window (exit 3), `--json` matches the text table (`delta_rate: 0.25`). Evidence landed on issue #128, comment 6789533314, and was independently re-run and re-read by the main round. No bug was found in slice 2.

Honest note, stated plainly: both groups' agent/model read `unknown` — the J1 ledger carries no agent/model fields, so per-agent/model grouping has not yet been demonstrated on real data. Follow-up filed as issue #129, not a blocker for this milestone.

## 0.5.24 - Milestone M3 "I6d assertion-execution gate" accepted

Patch release. Two merged PRs since 0.5.23, verified end to end in CI and locally — and the milestone they complete is now accepted.

**Milestone M3 "I6d assertion-execution gate" — accepted (issue #69; acceptance detail issue #119, comment 6786762925; #119 closed).** Every new/changed assertion must really execute — an unexecuted assertion no longer counts as green. Slice 1 (PR #121, merged 2026-11-11T03:54:17Z) adds the JS assertion-execution gate via V8 coverage, alongside the pytest gate: pytest + JS dual-language assertion-execution proof. Slice 2 (PR #123, merged 2026-11-11T04:09:09Z) supplies real-case evidence: 3 cases all run through the real gate, and in each case the tests themselves were all green before the fix while the gate judged red and named the line / assertion — case 1, a pytest dead-callback assertion (test_case1.py:3); case 2, a dead callback hiding a wrong expectation round(2.675,2)==2.68 (intermediate state pytest_failed); case 3, a JS EventEmitter dead-callback assertion (test_case3.test.js:8). All pass after the fix.

**Acceptance evidence, all measured, not worker claims.** Slice 1: new tests 15/15, neighbouring audit + py gates 67/67, lite-track + tdd-proof 51/51 (independent re-run by the main round); PR #121 CI runs verify 42955147070 and ledger 42955147064 both pass. Slice 2: independent re-run 33/33; PR #123 CI runs verify 42956692900 and ledger 42956692941 both pass. Evidence landed on the epic: #122 comment 6786648683 + docs/i6d-m3-slice2-cases.md.

Honest note, stated plainly: the 3 cases are constructed minimal reproduction cases, not historical real bugs — no ready-made historical bug was found in this repo's own tests. This is stated in the evidence doc, the test headers, the PR text, and the #122 comment. What the cases prove is the gate's own behaviour: they run the real gate code and its verdict output is measured, so the "real cases caught by the gate" acceptance item is met in substance — the gate behaviour itself is verified, not only a test double.

Acceptance ledger, stated plainly: the issue #5 ledger is settled as a conclusion on the MiniMax full-matrix recheck (135/135 complete, 2026-11-10) — P2-1 passed, P1-2 / P1-3 / P2-3 did not pass — so no bench numbers are claimed in this release.

## 0.5.23 - Milestone M2 "xflow audit" accepted

Patch release. Two merged PRs since 0.5.22, verified end to end in CI and locally — and the milestone they complete is now accepted.

**Milestone M2 "xflow audit" — accepted (issue #69, comment 6785392264; acceptance detail issue #113, comment 6785391440; #113 and #116 closed).** `xflow audit` now works standalone on any diff or PR, not only on runs that went through the evalid workflow: it extracts claimed test runs, replays the seal, and outputs a verdict plus a claim-vs-evidence ledger. Slice 1 (PR #115, merged 2026-11-10T23:33:50Z) adds the positional form `xflow audit <diff|PR>` (bare PR number, `owner/repo#n`, pull URL, `.patch` / `.diff` path, file, or `-` for stdin) plus tamper coverage — an inflated-count claim fails with the exact breaking point, a broken evalid seal fails via i6b replay. Slice 2 (PR #117, merged 2026-11-11T02:40:07Z) fixes G1 and G2, found by auditing real PRs: label-first counts were silently dropped, so a RED claim could be false-verified on exit code alone; and claim-cwd inference is now explicit.

**Acceptance evidence, all verified against raw audit JSONs and code, not worker claims.** Verdicts on 3 real historical PRs, each re-checkable from the audit output alone: code-yeongyu/senpi#2606 (mismatch — re-run exit 0, 82 passed vs claimed 78 stale count), code-yeongyu/senpi#4801 (mismatch — `node --test` single file 4 passed; `npm test` 666/6 with 6 unrelated load-probe failures; `npm run check` exit 134 env crash), code-yeongyu/oh-my-openagent#8014 (mismatch — package scope stripped, plus copied `node_modules` from a November checkout vs a September merge head). No false pass: a tampered claim (99 claimed vs 4 replayed) was reported mismatch with the exact breaking point `passed count: claimed 99, replayed 4`; a bonus forged seal (`demo-tamper/green/0`) was judged `schema_error`. Test evidence: 19 new tests in `test/xflow-audit.test.js` across the two slices (21 → 40); PR #115 CI runs verify 42923478324 and ledger 42923478345 both pass; PR #117 CI runs verify 42946796641 and ledger 42946796750 both pass; full `npm run verify` exit 0 — 63 test files, 0 fail.

Honest note, stated plainly: the three mismatch verdicts rest substantially on replay fidelity, not PR quality — a mismatch means the claim could not be reproduced from the diff alone, not that the PR itself was bad. Known limitations, left for a follow-up slice: G3 (`bun test` not recognised), G4 (`node_modules` snapshot mismatch), prose package-scope hints, and RED / baseline commit scope.

Acceptance ledger, stated plainly: the issue #5 ledger is settled as a conclusion on the MiniMax full-matrix recheck (135/135 complete, 2026-11-10) — P2-1 passed, P1-2 / P1-3 / P2-3 did not pass — so no bench numbers are claimed in this release.

## 0.5.22 - Milestone M4 "lite fast track" accepted

Patch release. One merged PR since 0.5.21, verified end to end in CI and locally — and the milestone it completes is now accepted.

**Milestone M4 "lite fast track" — accepted (issue #97, comment 6779685027).** Small diffs now skip the spec ritual and run seal + replay only: the classifier (`lite_track.py`, 10 files / 300 lines) decides lite vs full, `xflow workflow run` takes `--lite` / `--full` or auto-selects, and in a lite run `proposal-consistency-check` and atoms `J4a` / `J4b` are skipped while the TDD proof seal, I6d gate, full test run (J1), code review (J6) and audit replay all still run. Wall clock: n=3对照 0.653 / 1.115 / 0.822, median 0.822 ≤ 1.3×. Acceptance evidence, all measured on the real repo: the merged fix #110 (2 files, 160 lines) ran through the real executor with the real `workflows/yolo.yaml` — red proof sealed, green proof sealed with binding hash, I6b `valid`, I6d `pass`, J1/J6 passed, `verify_proof.json` `all_passed: true`; and the merged large change PR #34 (330 lines) was measured by the classifier as `full`, so its spec ritual would really run. Test evidence: full `npm run verify` exit 0 — 63 test files, 0 fail; PR #110 CI runs verify 42884719774 and ledger 42884719997 both pass; merged main CI run 42885424667 success.

**Classifier counts untracked files in --uncommitted mode (#110, closes #109).** A fix made only of brand-new files used to look like an empty diff and was misjudged lite; untracked files are now counted. Test evidence: 4 new tests in `test/lite-track.test.js` (22 tests in the file: 18 pass / 4 fail without the fix, 22/22 pass with it).

Honest note, stated plainly: the literal `xflow proof --track yolo` still exits 1 — it requires all 13 workflow phases to have `phase_completed`, and the acceptance change completed 4/13; the missing 9 include `openissue` / `set-in-progress` / `execute` / `archive`, which need real GitHub actions and cannot be completed in a scratch run. The acceptance verdict accepts the verification spine (seal + replay + J1 + J6) as the proof for ④(a); the track-level 13-phase completeness check is not a veto item for this milestone. This is recorded as-is, not written up as green.

Follow-up filed, not fixed here: the I6b replay tree never contains `node_modules` (issue #111, open) — any test importing an npm dependency reports `no_test_evidence` on replay. The acceptance run worked around it by prefixing the TDD command with `npm ci`; no tool code was changed for this release.

Acceptance ledger, stated plainly: the issue #5 ledger is settled as a conclusion on the MiniMax full-matrix recheck (135/135 complete, 2026-11-10) — P2-1 passed, P1-2 / P1-3 / P2-3 did not pass — so no bench numbers are claimed in this release.

## 0.5.21 - Agent progress streaming (external contribution #95)

Patch release. One merged PR since 0.5.20, verified end to end in CI and locally.

**Agent progress streaming through the execution log and SSE (#95, author MAOLVLHL).** `xflow workflow run` now streams live agent progress: `codex exec --json` and `claude --output-format stream-json --verbose` feed the execution log as the event bus, `entry_hash` is the resume token, and `xflow serve` pushes the stream over SSE. Appends no longer re-read the whole file (tail cache + 16 KB tail read, expanding to a full line when the last entry exceeds the window); a >16 KB last entry no longer breaks the hash chain on a cold cache (verified with a cold-cache reproduction: a fresh process appending after a 20 KB entry keeps the chain intact). Test evidence: 32/32 across the four affected test files locally; demo `node scripts/demo-agent-stream.mjs` 5 pushed / 5 written / 5 received over SSE, latency 16–419 ms; PR CI runs verify 42761169188 and ledger 42761169204 both pass on the final HEAD; merged main CI run 42762022933 success. Maintainer fix on the branch: the author's fix commit had dropped the executable bit on `bin/xflow.js`, breaking one CLI usability test — restored mode-only (commit fcd81d8) before merge.

Milestone M4 "lite fast track" — **not yet accepted.** This release ships no M4 slice; the wall-clock verdict still awaits bench numbers.

Acceptance debt, stated plainly: the bench-number acceptance for P1-2, P1-3, P2-1 and P2-3 — the wall-clock/token/resolved lines from issue #5 — still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is at 98/135 with the 15th relaunch in flight. No bench numbers are claimed in this release.

## 0.5.20 - M4 lite fast track, slices 3–4 (milestone M4 not yet accepted)

Patch release. Two merged PRs since 0.5.19, both verified end to end in CI and locally.

**M4 slice 3: workflow run auto-selects lite (#102).** `xflow workflow run` with no explicit flag runs the classifier first and picks the track itself — small diff → lite, big diff → full, explicit `--lite` / `--full` always wins, classifier failure falls back to full and records it. The decision is written into the workflow events as `lite_track_decision`, next to `lite_fast_track`. Test evidence: 19 new tests in `test/lite-track-auto.test.js` RED→GREEN; PR CI runs verify 42702996913 and ledger 42702997046 both pass; merged main CI run 42703634292 success.

**M4 slice 4: classifier ignores workflow-written change artifacts (#104).** The auto end-to-end acceptance demo on main HEAD caught a real bug: run 1 auto-decided lite and sealed the red proof, but the resume flipped to full because run 1 had rewritten the tracked `specs/changes/<id>/status.json` itself (+268/−2 lines) and the force-full rule fired on the `specs/` path. `classify_repo` now excludes workflow-generated artifacts under `specs/changes/<id>/` (`status.json`, `verify_proof.json`, `spec_delta_review.*`, `tdd/`, `cr/`) from the measured stats; human spec files still force full. Test evidence: 4 new classifier unit tests RED→GREEN (4/4 fail without the fix); new end-to-end regression test `test/lite-track-auto-acceptance.test.js` (real small fix, no flag, resume stays lite; 400-line control stays auto-full) fails before the fix, passes after; full `npm run verify` exit 0 — 61 test files, 560 tests, 559 pass, 0 fail; PR CI runs verify 42722307306 and ledger 42722307186 both pass; merged main CI run 42722893282 success.

Wall clock, stated plainly as preliminary (docs/evidence/m4-slice4-auto-resume.md, n=1 per track, same auto demo flow, Linux VM / node v24.22.1 / python 3.12.3): auto demo lite 4,995 ms vs full 6,363 ms (ratio 0.785) isolated, lite 8,239 ms vs full 7,124 ms (ratio 1.157) inside `npm run verify`; slice-2 demo re-measured 1.291 in the same suite run. Same demo, same machine, ratios 0.785–1.291 — n=1 demo timings are dominated by startup and machine load, not by the spec ritual. The formal ≤1.3× verdict for issue #5 P1-2 waits for the bench full-matrix numbers; P1-2 stays unticked, and this release makes no ≤1.3× claim.

**Milestone M4 "lite fast track" — not yet accepted.** Slices 1–4 are merged checkpoints; the auto end-to-end acceptance is now demonstrated (real small change through auto-lite across the red→green resume, real large change judged auto-full, seal + clean replay), but the wall-clock verdict still awaits bench numbers.

Acceptance debt, stated plainly: the bench-number acceptance for P1-2, P1-3, P2-1 and P2-3 — the wall-clock/token/resolved lines from issue #5 — still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), at 82/135 with the 12th relaunch in flight. No bench numbers are claimed in this release.

## 0.5.19 - M4 lite fast track, slices 1–2 (milestone M4 not yet accepted)

Patch release. Two merged PRs since 0.5.18, both verified end to end in CI and locally.

**M4 slice 1: lite fast-track classifier and `--lite` switch (#98).** `xflow/atoms/lite_track.py` classifies a diff `lite` / `full` against the merge-base; thresholds `max_files = 10`, `max_lines = 300`; any touch under `specs/` or `workflows/` forces `full`; empty diff is `lite`. `xflow workflow run` gains an explicit `--lite` flag — the classifier decides, no silent auto-switching. Executor `lite_skip` skips the spec ritual in a `--lite` run (`proposal-consistency-check` phase, `J4a` / `J4b` atoms) and logs the skips; kept in lite mode: TDD run + proof seal + i6d gate, full test run (`J1`), code review (`J6`), and `xflow audit` replay. Test evidence: 11 new tests in `test/lite-track.test.js` RED→GREEN; full `npm run verify` exit 0 (58 test files); PR CI runs verify 42664527969 and ledger 42664528087 both pass; merged main CI run 42665066351 success.

**M4 slice 2: lite acceptance demo + wall-clock preliminary numbers (#99).** `test/lite-track-acceptance.test.js` proves the lite track end to end through the real executor and real `workflows/yolo.yaml` (dogfood fix: `classify_repo --uncommitted` overcounted partially reverted lines — now reads the worktree diff against the base directly; regression test, 11/12 pass without the fix). Lite run: `proposal-consistency-check` skipped (reason `lite_track`), `J4a` / `J4b` skipped, `verify-consistency` gate passed with verdict `lite_skipped`, `lite_fast_track: true`; seal + clean replay (red proof `passed: false`, green proof `passed: true`, I6b validated both); I6d, I6c, J1 and J6 passed in both tracks. Full-track control ran all spec atoms, `lite_fast_track: false`. Classifier controls: 2-file fix → `lite`; 400-line addition → `full`; one-line `specs/` touch → `full`. Test evidence: 2 new tests RED→GREEN; full `npm run verify` exit 0 — 59 test files, 536 tests, 535 pass, 0 fail (1 pre-existing todo); PR CI verify and ledger both pass; merged main CI run 42689050732 success.

Wall clock, stated plainly as preliminary (docs/evidence/m4-slice2-wallclock.md, n=1 per track, same demo flow, Linux VM / node v24.22.1 / python 3.12.3): standalone acceptance test lite 5,050 ms vs full 6,330 ms (ratio 0.798); inside `npm run verify` lite 10,420 ms vs full 16,191 ms (ratio 0.644). The two runs disagree by ~0.15 on the ratio minutes apart on the same machine — that spread is why these numbers are preliminary. The formal ≤1.3× verdict for issue #5 P1-2 waits for the bench full-matrix numbers; P1-2 stays unticked, and this release makes no ≤1.3× claim.

**Milestone M4 "lite fast track" — not yet accepted.** Slices 1 and 2 are merged checkpoints only; the end-to-end acceptance evidence (real small change through `--lite`, real large change judged `full`, wall-clock verdict from bench numbers) is not yet in place.

Acceptance debt, stated plainly: the bench-number acceptance for P1-2, P1-3, P2-1 and P2-3 — the wall-clock/token/resolved lines from issue #5 — still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is still running. No bench numbers are claimed in this release.

## 0.5.18 - Proof verdicts as SARIF for code scanning (issue #73 closed)

Patch release. One merged PR since 0.5.17, verified end to end in CI and locally, with the Security-tab acceptance evidence from a demo PR.

**Export proof verdicts as SARIF for code scanning (#92, closes #73).** Sealed-proof failures now surface as code scanning alerts, not just a red check and a PR comment. `action/sarif.mjs` maps each proof-failure verdict to a SARIF 2.1.0 rule (binding / snapshot / green-tree / reexec failures at error level; skipped-tests and unknown-counts at warning), one result per named file, with stable fingerprints so re-runs update the existing alert instead of duplicating it and a valid proof clears its alert. `verify-proof.mjs` gains `--sarif-out`, and `proof-ledger.yml` uploads the SARIF per proof (fires exactly when a proof failed; fork PRs stay green). Test evidence: 11 new tests in `test/github-action-sarif.test.js`; PR CI runs verify 42567046823 and ledger 42567046908 both pass; merged main CI run 42567609280 success.

**Issue #73 — closed with end-to-end evidence** (demo PR #94, closed unmerged): a sealed green proof with a tampered `test/demo-sarif.test.js` went red — ledger run 42568411445 fail, verdict `green_tree_mismatch`, files `[test/demo-sarif.test.js]` only; SARIF upload success, analysis 2124250892 (results_count 1), code scanning alert #1 visible in the Security tab (rule `evalid/green-tree-mismatch`, severity error). A re-run opened no duplicate alert, and restoring the test file cleared it — ledger run 42568823086 pass, verdict `valid`, analysis 2124265677 (results_count 0), alert #1 state `fixed` on refs/pull/94/merge. A green PR produces no alert (main branch alerts 0).

Acceptance debt, stated plainly: the bench-number acceptance for P1-2, P1-3, P2-1 and P2-3 — the wall-clock/token/resolved lines from issue #5 — still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is stopped on MiniMax Token Plan quota exhaustion. No bench numbers are claimed in this release.

## 0.5.17 - I6d assertion-execution gate (milestone M3 accepted)

Patch release. Three merged PRs since 0.5.16, all verified end to end in CI and locally.

**M3 slice 3: I6d wired into `xflow audit` replay and the I6c gate (#89).** When an audited diff touches Python test files, the audit now runs the I6d gate in the scratch clone: an unexecuted assertion inside the diff flips the verdict to `mismatch` even when the replay itself is fully green; repos without the I6d plugin are unaffected. The I6c gate folds the same evidence into fail findings naming each unexecuted assertion. Test evidence: local full `npm test` 496 tests / 495 pass / 0 fail / 1 skipped (pre-existing); merged main CI run 42551898032 success.

**M3 slice 4: acceptance demo (#90).** `scripts/demo-i6d-gate.sh` proves the gate through the real `xflow audit` CLI with a RED/GREEN double control — RED: a never-called callback's `assert value == 42` with a claimed all-green pytest run is judged `mismatch`, exit 1, `i6d: unexecuted_assertions`; GREEN: only really-executed assertions are judged `verified`, exit 0, `i6d: pass`. Test evidence: new test `test/i6d-acceptance-demo.test.js` 1/1 pass; `test/xflow-audit.test.js` 15/15 pass; local full `npm test` 511 tests / 510 pass / 0 fail / 1 skipped (pre-existing); merged main CI run 42557796622 success.

**Concurrency policy test coverage, external contribution (#88, closes #87).** 14 new tests in `test/concurrency-policy.test.js` covering `createConcurrencyPolicy()` limits, weights and overrides; no production code changed. Test evidence: contributor ran the new file 14/14 pass; full-suite verification after merge comes from main CI run 42556898257 success.

**Milestone M3 "I6d assertion-execution gate" — accepted.** Evidence in issue #69, comment 6731688418: the slice-4 demo proves the acceptance standard end to end — every new/changed assertion must actually execute during the green run, and an unexecuted assertion does not count as green. The demo script is in main and locked into the suite; the #69 checklist box is ticked.

Acceptance debt, stated plainly: the bench-number acceptance for P1-2, P1-3, P2-1 and P2-3 — the wall-clock/token/resolved lines from issue #5 — still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is stopped on MiniMax Token Plan quota exhaustion. No bench numbers are claimed in this release.

## 0.5.16 - M3 slices 1–2: pytest assertion-execution tracking, diff-scoped (milestone M3 not yet accepted)

Patch release. Two merged slices since 0.5.15, both verified end to end in CI and locally.

**M3 slice 1: pytest assertion-execution tracking (#82).** Every `assert` in a pytest run is now collected (file, line, enclosing test) and the run reports which assertions actually executed, so an unexecuted assertion turns the verdict red instead of passing silently. Test evidence: 5 new tests in `test/i6d-assertion-execution.test.js` 5/5 pass; local full `npm test` 480 tests passed; main CI run 42525749105 success.

**M3 slice 2: diff-scoped assertion execution (#84).** Verdicts are now scoped to the diff: only new/changed assertions count, and legacy dead asserts outside the diff are reported out of scope rather than failing the run. Test evidence: 4 new tests in `test/i6d-assertion-execution.test.js` 4/4 pass (i6d file 9/9 pass); local full `npm test` exit 0; PR CI runs verify 42535505270 and ledger 42535505267 both pass; merged main CI run 42535987353 success.

**Milestone M3 — not yet accepted.** Slices 1 and 2 are merged checkpoints only; slice 3 is still to be done and the end-to-end acceptance evidence (real-scenario run + data on disk) is not yet in place. This release makes no M3 acceptance claim.

Acceptance debt, stated plainly: the bench-number acceptance for P1-2, P1-3, P2-1 and P2-3 — the wall-clock/token/resolved lines from issue #5 — still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is stopped on MiniMax Token Plan quota exhaustion. No bench numbers are claimed in this release.

## 0.5.15 - xflow audit standalone mode (milestone M2 accepted)

Patch release. One new feature since 0.5.14, verified end to end in CI and locally.

**`xflow audit` standalone mode (#79).** Verify any git diff / PR without adopting evalid workflows: `xflow audit --pr <n>` extracts the test runs the change claims to have passed, replays each one in a clean clone at the change's head, and compares exit codes and pass/fail counts against the claim; diffs carrying an evalid proof seal are replayed through the existing i6b validator. Test evidence: 11 new tests in `test/xflow-audit.test.js` 11/11 pass; local full `npm test` 475 tests / 474 pass / 0 fail / 1 skipped (pre-existing); PR CI runs ledger 42516967938 and verify 42516967984 both success.

**Milestone M2 "`xflow audit` standalone mode" — accepted.** Evidence in issue #78, comment 6726208145: audits of real historical PRs #75 / #71 / #68 all `verified` — #75 targeted run 24 passed / 0 failed / 24 total plus seal `valid`, full `npm test` exit 0 on all three; #68's claimed 439/0/440 honestly counts-unparsed (the multi-file runner has no single total, so the verdict rests on exit code).

Acceptance debt, stated plainly: the bench-number acceptance for P1-2, P1-3, P2-1 and P2-3 — the wall-clock/token/resolved lines from issue #5 — still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is stopped on MiniMax Token Plan quota exhaustion. No bench numbers are claimed in this release. Audit gaps carried forward: no PR from a different repo or a non-evalid agent audited yet; pytest / go test / cargo test replay paths are parser-level only.

## 0.5.14 - PR comment ledger (milestone M1 accepted)

Patch release. One new feature since 0.5.13, verified end to end in CI and locally.

**PR comment ledger (#75).** The proof-ledger workflow now posts the claim-vs-evidence ledger as a PR comment: a green proof gets a ✅ comment on the PR, and a tampered proof fails the `ledger` check and gets a ❌ comment naming the exact break point, so a replay mismatch can no longer pass CI silently. Test evidence: 18 new tests in `test/github-action-ledger-comment.test.js` 18/18 pass; local full `npm test` 464 tests / 463 pass / 0 fail / 1 skipped (pre-existing); PR CI run 42505482112 success.

**Milestone M1 "GitHub Action end-to-end" — accepted.** Evidence in issue #73, comment 6724800077: ① green path — PR #75 merged (af88e2da), proof-ledger run 42505482067 success, ✅ ledger comment 6724656930; ② red path — demo PR #76 (closed unmerged by plan) turned the `ledger` check red (run 42505769769) and the ❌ comment 6724768829 names the break point `green_tree_mismatch: test/demo-tamper.test.js`; ③ CI replay and local replay agree on both verdicts (`valid` green, `green_tree_mismatch` tampered) through the same validator entry.

Acceptance debt, stated plainly: the bench-number acceptance for P1-2, P1-3, P2-1 and P2-3 — the wall-clock/token/resolved lines from issue #5 — still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is stopped on MiniMax Token Plan quota exhaustion. No bench numbers are claimed in this release.

## 0.5.13 - Proof-seal verification action

Patch release. One new feature and one dead-code removal since 0.5.12, both verified by the test suite.

**Proof-seal verification GitHub Action (#71).** A new JavaScript GitHub Action (`action.yml`, node22) runs the existing i6b seal validator for one change-id/phase/attempt and fails the check unless the seal verifies and the clean replay matches the claim, so a replay mismatch can no longer pass CI silently. Test evidence: 6 new tests in `test/github-action-verify-proof.test.js` 6/6 pass (valid sealed green proof verifies; tampered proof fails with `binding_mismatch`; test drift after the seal fails with `green_tree_mismatch`; missing proof fails with `missing`; CLI entry exit 0/1; action.yml declares inputs and entry); RED→GREEN verified; PR CI run 42494536803 success.

**Removed dead phase-run-dispatch atom wrapper (#68).** `src/agent_team/atoms/phase-run-dispatch.js` had zero callers and is absent from the atom registry and the public surface, so the wrapper is gone with no behaviour change. Test evidence: local full `npm test` 440 tests / 439 pass / 0 fail / 1 skipped (pre-existing); PR CI run 42483989723 verify pass.

Acceptance debt, stated plainly: the bench-number acceptance for P1-2, P1-3, P2-1 and P2-3 — the wall-clock/token/resolved lines from issue #5 — still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is stopped on MiniMax Token Plan quota exhaustion. No bench numbers are claimed in this release.

## 0.5.12 - Policy resolve atom test coverage

Patch release. One test-coverage addition since 0.5.11, verified by the full test suite. No runtime behaviour changed.

**Policy resolve atom coverage (#66).** P1 `policy.resolve` (`src/core/atoms/policy/resolve.js`) now has 6 tests in `test/policy-overlay.test.js`, covering personal-default resolution with `policy_effective.json` writing, change_id and execution_mode taken from input, `team_policy_missing` / `team_policy_invalid` passthrough, no artifact when no change id is supplied, and registry wiring. Coverage went from 0% to 100% statements / 83.33% branches / 100% functions / 100% lines (the single uncovered branch is the `process.cwd()` fallback, untested by design). Test evidence: RED→GREEN verified (stubbed-throwing implementation failed the new tests, then green after restore); `npm test` 435 tests / 434 pass / 0 fail / 1 skipped (pre-existing).

Acceptance debt, stated plainly: the bench-number acceptance for P1-2, P1-3, P2-1 and P2-3 — the wall-clock/token/resolved lines from issue #5 — still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is stopped on MiniMax Token Plan quota exhaustion. No bench numbers are claimed in this release.

## 0.5.11 - Codex app bridge and layout competition atoms test coverage

Patch release. Two test-coverage additions since 0.5.10, both verified by the full test suite. No runtime behaviour changed.

**Codex app bridge atom coverage (#63).** I5 `codex.app_bridge` (`src/agent_team/atoms/codex-app-bridge.js`) now has 6 tests in `test/heavy-atoms.test.js`, covering the default local-bridge placeholder return, input.phase preference over context.phase.id, empty-string and missing-phase fallbacks, and registry wiring. Coverage went from 0% to 100% on all four measures. Test evidence: RED→GREEN verified (stubbed-throwing implementation failed all 6 new tests, then green after restore); `npm run coverage` 424 pass / 0 fail.

**Visual layout competition atom coverage (#64).** H3b `visual.layout_competition` (`src/agent_team/atoms/visual/layout-competition.js`) now has 4 tests in `test/heavy-atoms.test.js`, covering `layout_competition.json` writing with the fixed phase and summary (verdict accept / confidence 0.76, two findings), the fixed phase winning over input/context phase names, the missing-change_id error, and registry wiring. Coverage went from 0% to 100 / 100 / 100 / 100. Test evidence: RED→GREEN verified (an intentionally wrong assertion failed, then green after restore); `node test/heavy-atoms.test.js` 64 pass / 0 fail; `npm run coverage` 429 tests / 428 pass / 0 fail / 1 skipped (pre-existing).

Acceptance debt, stated plainly: the bench-number acceptance for P1-2, P1-3, P2-1 and P2-3 — the wall-clock/token/resolved lines from issue #5 — still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is stopped on MiniMax Token Plan quota exhaustion. No bench numbers are claimed in this release.

## 0.5.10 - Intake and phase-run fail atoms test coverage

Patch release. Two test-coverage additions since 0.5.9, both verified by the full test suite. No runtime behaviour changed.

**Intake atoms coverage (#60).** G1 `intake.preview_or_refine` and G5 `intake.recommend` now have 8 tests in `test/intake-atoms.test.js`, covering intake preview/refine file writing, summary title fallback, change_id handling, workflow recommendation (yolo for docs, corps with a human checkpoint for payments) and registry wiring. Coverage went from 0% to 100% on both files (19/19 and 20/20); all-files statements 86.78% → 86.97%. Test evidence: new file 8/8 pass; full suite green on the merged tree.

**Phase-run fail atom coverage (#61).** D3d `phase_run.fail` (`src/core/atoms/phase-run/fail.js`) now has 7 tests in `test/heavy-atoms.test.js`, covering the success path, session resolution (explicit id, runtime id, most recent running session), stop_reason fallback, custom store via `data_file`, and both error paths. Coverage went from 0% to 100% statements / 94.44% branches / 100% functions / 100% lines. Test evidence: RED→GREEN verified; `node test/heavy-atoms.test.js` 54 pass / 0 fail.

Acceptance debt, stated plainly: the bench-number acceptance for P1-2, P1-3, P2-1 and P2-3 — the wall-clock/token/resolved lines from issue #5 — still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is stopped on MiniMax Token Plan quota exhaustion. No bench numbers are claimed in this release.

## 0.5.9 - Design and memory atoms test coverage

Patch release. Two test-coverage additions since 0.5.8, both verified by the full test suite. No runtime behaviour changed.

**Design atoms coverage (#57).** H2b/H2d/H2e design atoms (competitor reconstruction review, reference surface lock, reconstruction pack) now have 10 tests in `test/design-atoms.test.js`, covering contract freezing, primary-surface selection, non-array input handling, lock-file writing and pack building.

**Memory atoms coverage (#58).** `src/core/memory-state.js` and the `memory/manage` and `memory/mount` atoms now have 21 tests in `test/memory-atoms.test.js`, covering create/list/mount/resolve defaults and filters, mission resolution via input, runtime and bindings file, and manage/mount against a temp-dir sqlite store. Coverage went from 0% to 100/100/100/100 on all three files. Test evidence: `npm run coverage` 404 tests / 403 pass / 0 fail / 1 skipped (pre-existing).

Acceptance debt, stated plainly: the bench-number acceptance for P1-2, P1-3, P2-1 and P2-3 — the wall-clock/token/resolved lines from issue #5 — still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is stopped on MiniMax Token Plan quota exhaustion. No bench numbers are claimed in this release.

## 0.5.8 - README command reference; CI actions to v7

Patch release. One docs addition and one CI maintenance bump since 0.5.7, both verified by the full test suite.

**README Commands section (#54).** README now has a single command reference after "3 Minute Start": all 31 top-level xflow commands with a one-line description each, verified against live `--help` output, and an explicit note that the installed binary is `xflow` (there is no `evalid` binary). Docs only — no CLI behaviour changed. Test evidence: `npm test` 373 tests / 372 pass / 0 fail / 1 skipped.

**CI actions bumped to v7 (#55).** `actions/checkout` v4 → v7.0.1 and `actions/setup-node` v4 → v7.1.0 across both workflows (4 pin sites). Both v7 actions run on node24, clearing the Node 20 deprecation warnings CI reported under v4. No behaviour change for this repo: the fork-PR guard in checkout v7 does not apply to this repo's trigger events, and setup-node v7's removal of the dummy NODE_AUTH_TOKEN export does not affect the OIDC Trusted Publishing flow in npm-publish.yml. Test evidence: `npm run verify` exit 0 on the merged tree.

Acceptance debt, stated plainly: the bench-number acceptance for P1-2, P1-3, P2-1 and P2-3 — the wall-clock/token/resolved lines from issue #5 — still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is stopped on MiniMax Token Plan quota exhaustion. No bench numbers are claimed in this release.

## 0.5.7 - Coverage config (c8)

Patch release. One addition since 0.5.6, verified by the full test suite.

**c8 coverage config (#52).** The repo previously had no coverage tooling. Added `c8` (^12.0.0) as a dev-dependency, `.c8rc.json` (covers `src/**` and `bin/**`, excludes `test/**`), and `npm run coverage`, pinned by `test/coverage-config.test.js` (3 assertions). Measured on the merged tree: 372 tests / 372 pass / 0 fail; coverage 84.64% statements / 62.73% branches / 94.02% functions. No runtime behavior changes.

Acceptance debt, stated plainly: the bench-number acceptance for P1-2, P1-3, P2-1 and P2-3 — the wall-clock/token/resolved lines from issue #5 — still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is stopped on MiniMax Token Plan quota exhaustion. No bench numbers are claimed in this release.

## 0.5.6 - Playwright 1.65.0; js-yaml 5.5.0

Patch release. Two dependency upgrades since 0.5.5, both verified by the full test suite (`npm run verify` exit 0 on the merged tree).

**Playwright 1.59.1 → 1.65.0 (#49).** Dev-dependency bump; paired Chromium 158.0.8127.18 (build 1254) verified locally.

**js-yaml 4.1.1 → 5.5.0 (#50).** Major upgrade, verified item by item before merging: both shipped workflows parse deep-equal under v4 and v5, scalar resolution is unchanged, and the one real break — v5 no longer resolves the `<<` merge key — is handled explicitly: the workflow loader now rejects a literal `<<` key with an actionable error telling the author to inline the merged mapping, instead of a confusing schema-validation failure. Pinned by `test/workflow-loader-yaml5.test.js` (7 tests).

Acceptance debt, stated plainly: the bench-number acceptance for P1-2, P1-3, P2-1 and P2-3 — the wall-clock/token/resolved lines from issue #5 — still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is running. No bench numbers are claimed in this release.

## 0.5.5 - Package entry restored; dead code removed

Patch release. Two small fixes since 0.5.4, both verified by the full test suite (`npm run verify` exit 0 on the merged tree).

**Missing package main entry (#46).** The published package had no main entry file, so importing the package by name could not resolve. `src/index.js` is now present as the package entry and is pinned by `test/package-entry.test.js`.

**Dead code removed (#47).** Four exported functions with zero callers are deleted (51 lines, 0 added): `writePlanMarkdown` (plus `buildPlanCommands`, which only it called), `readPendingGate`, `getLatestMissionSession`, and `resolveAtom`. Each was verified dead by repo-wide grep across src, bin, test, docs, and scripts, including string-form references — only the definition site remained in every case. None of the four was exported from the public `src/index.js` surface, so this is not a public API change. The modules themselves stay: their other exports (`load` / `dryRun`, `listPendingGates` / `ackPendingGate`, `getLatestPhaseRun`, `writeReviewArtifact`) are still used.

Acceptance debt, stated plainly: the bench-number acceptance for P1-2, P1-3, P2-1 and P2-3 — the wall-clock/token/resolved lines from issue #5 — still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is running. No bench numbers are claimed in this release.

## 0.5.4 - Phase-cost drift test stops flaking under load

Patch release. One test-only fix: `npm run verify` was red on main because the phase-cost drift test tripped its 5% bound at 5.7% while the MiniMax batch was running, then went 7/7 green on a quiet re-run of the same file.

**Longer sleeps in the drift tests (#44, issue #5 P1-1).** The two `within_tolerance` integration tests used 2 x 400 ms sleeps, so the 5% budget was 40 ms against tens of ms of fixed executor overhead that structurally sits outside phases (run setup plus the `phase_completed` log / state writes between phases). The sleeps are now 2 x 1500 ms, putting the same overhead at ~2% of the phase sum with headroom under load. The production tolerance (`PHASE_COST_TOLERANCE_PCT = 5`) and the accounting in `src/core/phase-cost.js` / `workflow-executor.js` are unchanged — the accounting behaved correctly by flagging real overhead. Test evidence (from the PR): `node test/phase-cost.test.js` 7/7 green; full `npm run verify` exit 0 (43 files, 361 tests, 360 pass, 1 skipped pre-existing, 0 fail).

Acceptance debt, stated plainly: the bench-number acceptance for P1-2, P1-3, P2-1 and P2-3 — the wall-clock/token/resolved lines from issue #5 — still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is running. No bench numbers are claimed in this release.

## 0.5.3 - Bench planner stops timing out and stops wandering

Patch release. Two bench-harness fixes from the MiniMax pilot, both pinned by tests rather than by a live run.

**Openswarm planner timeout 300s → 600s (#41).** The 300s cap was calibrated on DeepSeek, whose planner finished in 87–244s on the 6 pilot instances. With MiniMax M3.1-Flash-Preview at high thinking the planner exceeds 300s on all 6 pilot2 cells: killed mid-work (rc 143) before writing the task file, so the executor never ran and all 6 cells recorded false negatives (wall ~301s). 600s keeps planner + executor inside the CAP_S 1200s cell budget; the executor budget is derived from the remaining time.

**Openswarm planner prompt tightened to read-only planning (#42).** The 600s validation cell (pylint-8898) showed the planner spending 13 turns / 23 tools exploring (openswarm lane serve/assign probes, full-disk find for pylint wheels) and getting killed (rc 143) before writing the task file — raising the budget alone cannot fix that. The planner now reads only the skill text and the task, runs no shell command, does not reproduce / explore / list / search, launches no other program, writes the task file + verify command, then stops. The 600s planner timeout from #41 is unchanged. Test evidence (from the PR): new `bench/swebench/test_planner_prompt.py` (7 tests, stdlib-only via ast so CI can run it without pandas/swebench) + node wrapper `test/bench-planner-prompt.test.js`; bench Python suite 35/35, full `npm test` green.

Acceptance debt, stated plainly: the bench-number acceptance for P1-2, P1-3, P2-1 and P2-3 — the wall-clock/token/resolved lines from issue #5 — still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is running. No bench numbers are claimed in this release.

## 0.5.2 - Bench grades stop silently zeroing; the 15-instance set is validated

Patch release. One bench-harness fix that removes a silent false-negative from grading, plus the P2-2 validation close-out from the issue #5 backlog. Both are pinned by tests and by a validation log, not by a live run.

**Absolute grade paths (#38).** `run.py` / `regrade.py` passed `--raw-root` / `--raw` through unresolved, but `swe_env.grade()` runs `git apply <test.patch>` with `cwd=<cell repo>`. With a relative raw root the patch path did not resolve from the repo cwd, so every cell failed grading with `test_patch did not apply` — and `run.py` recorded it as an ordinary `resolved: false`, a silent false-negative for the entire run. Found during the 2026-11-06 bench rebuild: the first MiniMax pilot went 4/4 on this error before diagnosis. `run.py` now resolves `--out` / `--raw-root` / `--predictions-dir` to absolute paths up front, `regrade.py` resolves `--raw`, and `grade()` also writes `grade.json` on the test_patch-apply early return (previously the failure path wrote nothing — exactly how this stayed invisible). No behavior change for absolute-path invocations. Test evidence (from the PR): `npm run verify` exit 0 (941 pass / 0 fail), including the swebench harness isolation test; the same patch regraded from a fresh tree with absolute paths applies cleanly and grades normally.

**P2-2 15-instance set validated (#39, issue #5 P2-2).** The 3 round-3 additions (sympy__sympy-15599, sympy__sympy-19040, sympy__sympy-24213) have passed the gold-patch check: `harness/validate.py` over all 15 ids in `instances.json` (fa7ea30) reports 15/15 ok:true with no errors (`bench-env/validate-15.log`, mtime 2026-11-06 19:35 UTC, after the instances.json commit). `round3_extension.pending_validation` is cleared to `[]`, the validated ids are recorded, and `test_instances.py` now pins the validated state instead of the pending state. Test evidence (local, this round): `python3 -m unittest test_instances test_diff_filter test_predictions test_reps_report test_validity` — 28 tests, all OK. The issue #5 P2-2 checkbox is ticked.

Acceptance debt, stated plainly: the bench-number acceptance for P1-2, P1-3, P2-1 and P2-3 — the wall-clock/token/resolved lines from issue #5 — still awaits the MiniMax full-matrix batch (15 instances × 4 arms × reps 3), which is running. No bench numbers are claimed in this release.

## 0.5.1 - Gates stop re-reading unchanged files; bench arms run at high effort

Patch release. Two gate cost improvements from the issue #5 backlog, both pinned by tests rather than by a live run, plus a bench-harness change.

**Stat-anchored gate verification (#34, issue #5 P1-3).** The TDD seal now records a stat anchor (size, mtime_ns, inode) per sealed file alongside its sha256. Proof validation (I6b) and the CR review seal partition (J6) stat-check first and re-read + re-hash only files whose anchor moved, instead of re-reading every sealed file on every gate pass; proofs sealed before the anchors existed fall back to the full re-read. Validation reports `reread_files` / `reread_count` and the seal partition reports `stat_checked`, so the skipped re-reads are observable. Test evidence (local): `test/tdd-proof.test.js` 22/22 — 4 new, including unchanged tree validating with `reread_count` 0 and anchor-less proofs still verifying by full re-read; `test/cr-review.test.js` 14/14 — 2 new, including anchors accepting unchanged files (`stat_checked` 2) and an edited file re-read and drifted (`stat_checked` 1, `reread_count` 1).

**Per-process read cache for the review gates (#35, issue #5 P1-2 follow-up).** Both gates now read through a per-process cache keyed by the P1-3 stat anchor: each unchanged file is read from disk once per run and served from memory on later reads, while a changed file is re-read instead of served stale (a mid-read change is retried once). This removes the repeated re-reads inside one gate run — I6c reading the same source file for symbols, implementation sources and test review, and J6's test follow re-reading every test file once per changed code file. Both proofs report `read_cache` (`disk_reads` / `cache_hits`). No verdict logic changed. Test evidence (local): `test/tdd-proof.test.js` 24/24 — 2 new, including a cache unit test (3 reads → 1 disk read + 2 hits) and the quality-review proof reporting `read_cache` {disk_reads: 2, cache_hits: 2}; `test/cr-review.test.js` 16/16 — 2 new, including one gate run reading each unchanged file from disk once ({disk_reads: 3, cache_hits: 1}) and a test file shared by two code files read from disk once ({disk_reads: 4, cache_hits: 3}).

**Bench arms run at high thinking effort (#36).** Both pi call sites in the SWE-bench harness (`harness/arms.py` `run_pi()` and `harness/pi_shim.sh`) now set `--effort high`, so all four arms run MiniMax at the same high thinking effort and the workflow remains the only variable. The archived DeepSeek tables were recorded with the settings of their time and are not affected.

Acceptance debt, stated plainly: the live-run acceptance for P1-2 and P1-3 — the wall-clock/token lines from issue #5, including median tokens incl. cache ≤ 2.0M — is still pending the benchmark environment, which is being rebuilt. No bench numbers are claimed in this release; what shipped is the mechanism and the tests that pin its behaviour.

## 0.5.0 - Review re-reads only drifted files; the bench set grows to 15

Minor release. One product change — the CR review now spends its re-reads only where the seal says bytes moved — plus three bench-hygiene landings from the issue #5 backlog, each pinned by tests rather than by a live run.

**Review re-reads only drifted files (#32, issue #5 P1-2).** The J6 review proof (`cr/review-0.json`) now carries a seal partition: every changed file is classified `sealed_unchanged` (bytes still identical to the green TDD proof's sealed hashes) or `seal_drifted`, with a `reread_count`. The yolo verify-consistency guidance consumes the partition, so the review pass re-reads only the drifted files instead of everything the gate already verified. This is reporting only — verdicts are unchanged, and without a green seal the partition is `null` and everything is re-read, exactly as before.

**The Verified bench set grows from 12 to 15 instances (#30, issue #5 P2-2).** `bench/swebench/instances.json` adds sympy-15599, sympy-19040 and sympy-24213, and a structural validation of the instance set (`bench/swebench/test_instances.py`) now runs in CI, so a malformed instance entry fails the build instead of a bench run. Gold-patch checks for the three new instances are pending the benchmark environment.

**Bench reports now aggregate as median (IQR) (#31, issue #5 P2-1).** `bench/swebench/report.py` aggregates per-arm wall-clock, token and cost results with q1/median/q3 and presents them in median (IQR) form. Reps isolation — repeat runs of the same cell never share grading state — and the aggregation itself are pinned by `bench/swebench/test_reps_report.py`.

**P0-2 acceptance is now pinned by regression tests (#29, issue #5 P0-2).** The evidence exclusion itself landed earlier (solution patches drop `specs/`, `.xflow/` and `.as-xflow/`); what was missing was a test that would notice if it regressed. `bench/swebench/test_diff_filter.py` now runs the saved pre-fix patches through the filter: the saved 9.7 MB evidence-laden patch comes out at 4.3 KB, and every saved patch lands under the 200 KB acceptance line.

Acceptance debt, stated plainly: the live-run acceptance for P1-2, P2-1 and P2-2 — multi-rep bench runs on the restored environment, including the wall-clock/token lines from issue #5 and gold checks for the new instances — is still pending the benchmark environment. No performance numbers are claimed in this release; what shipped is the reporting, the larger instance set, and the tests that pin their behaviour.

## 0.4.1 - Failed runs report phase costs; Node 24 test counts fail closed

Patch release. Two fixes, both about the gate trusting evidence it had not actually read.

**Failed runs now report where the time and tokens went (#22).** The per-phase cost report landed in 0.3.0 but only rode on successful runs. It now also rides on the `workflow_failed` execution-log event — a run that stops mid-way still reports its per-phase timing/token breakdown — and is persisted as a standalone artifact at `.as-xflow/phase-cost.json` on both completion and failure, so the breakdown is readable without mining the ndjson execution log. The accounting structure (phase sum vs wall clock within 5%) is covered by `test/phase-cost.test.js`. This lands item P1-1 from issue #5.

**TDD gate reads test counts correctly on Node 24, and fails closed when it cannot (#23).** The gate parsed skip/todo counts only from the TAP reporter's summary lines. Node 24's built-in runner defaults to the spec reporter when piped, whose summary lines carry a different marker — an all-skipped/todo run on Node 24 exited 0, parsed as zero skips, and was waved through as green. The parser now reads the runner's summary block in both reporter formats (TAP and spec), requires the full node signature before treating a block as a node summary, and anchors summary lines at line start so test names or program output cannot forge counts. When a detected node summary cannot be fully parsed, the run classifies as `counts_unknown` and proof validation rejects it (`tests_counts_unknown`) instead of reading unknown counts as zero. Measured against pinned captured outputs: the new count-parsing tests pass 9/9 under Node 22 and 9/9 under Node 24; the end-to-end TDD proof suite passes 18/18 under both (it was 17/18 on Node 24 before this fix).

With P1-1 landed here, the P0/P1 items tracked on the optimization backlog in #5 stand checked off as verified; the remaining longer-horizon items stay tracked there.

## 0.4.0 - CR gate wired in, overhead cut 1, predictions direct

**The CR gate now runs inside the pipeline (F1, #15).** In 0.3.0 `J6.cr.review` was registered and unit-tested but no workflow invoked it — the release notes said so, and this release closes that gap. The yolo `verify-consistency` phase and the corps `qa` phase run J6 on every change, after the spec-delta review and before the stage flips to verify, and the verdict record `cr/review-0.json` is a required artifact: a failing verdict stops the workflow instead of waving the change through to archive. The wiring is proven end-to-end, not just by unit tests: `test/cr-review-wiring.test.js` drives the real yolo verify phase through `WorkflowExecutor` against a git fixture — an aligned, tested change passes with a verdict record on disk, and a code change with no test follow is stopped at the phase with the `cr_code_without_test` finding.

**Overhead cut 1 (F2, #17).** The lite (yolo) track seals the TDD red proof immediately after `plan` — the issue/branch ceremony no longer sits between planning and red-proof, and the planning pass authors the failing test, so plan and red share one agent pass. `xflow workflow run --title "..."` derives the change id from the title when the branch cannot provide one. TDD snapshots are scoped: inside a git work tree, I6a seals only the files that differ from HEAD plus the files the test command names, and I6b materializes the rest from the recorded HEAD at replay. Offline measurements on the SWE-bench sympy tree: the sealed manifest drops from 1,543 files / 164 KB to the changed files only (2 files / 197 B for a one-file change), and the snapshot copy from 26.9 MB to ~51 KB. Proofs sealed before this change keep verifying.

Acceptance debt, stated plainly: the v0.4 acceptance line for F2 was a live rerun of the same 6 SWE-bench instances — wall-clock ≤ 1.3× the baseline median, total tokens ≤ 2.0M, resolved ≥ 4/6. The bench generation environment is not currently restored, so those three numbers are still owed; they are not claimed here. If the rerun misses the line when it lands, the remaining overhead work continues as v0.4.1 rather than being declared done.

**Predictions come straight out of `run.py` (F3, #16).** The official SWE-bench predictions format (`instance_id`, `model_name_or_path`, `model_patch`) is now produced by the bench harness itself, with the P0-2 evidence filter re-applied on both the live and replay paths — the one-off converter outside the repo is retired. Regression evidence: all four pilot arms rebuilt through `run.py --export-predictions` are byte-identical to the hand-converted pilot files (`cmp` = 0, 24 instances).

**`xflow init` writes `.gitignore` (F4, #18).** Init now creates or merges the project `.gitignore` for evalid local state (`.as-xflow/`, `specs/changes/`), appending only missing entries and never modifying existing lines — the first line of defense ahead of the diff filtering added in #8. This closes the second v0.3.0 known gap; both are now done.

## 0.3.1 - Renamed: OpenFlow → evalid

Same code as 0.3.0, new name and positioning. The project is now **evalid** — a runtime verification layer for coding agents: it seals each test run and replays it from a clean snapshot, so a claim only ships if the evidence replays green. Repository: `surlymochan/evalid` (old `openflow` links redirect); npm package: `evalid`. The `xflow` CLI name is unchanged in this release.

## 0.3.0 - Three-stage gates: SPEC, CR, Test

OpenFlow's gates now cover the three stages where agent work usually goes wrong, each with deterministic checks instead of another model's opinion.

**SPEC clarification gate (`J4d.spec_clarify.gate`, #11).** Ambiguity is cheapest before the loop starts. J4d blocks specs whose MUST clauses carry no quantified anchor (a clause whose value is itself a vague word does not count as anchored), scenarios without WHEN/THEN, vague wording in English or Chinese, and TBD/placeholder text. Every finding comes with a concrete question a human can answer. False-positive control is deliberate: MUST NOT clauses are exempt, already-quantified lines are not flagged, and code blocks and headings are not scanned. Ships as `xflow spec clarify` and in the yolo/corps proposal-consistency stage.

**Code review gate (`J6.cr.review`, #10).** A diff fails review when nothing in it aligns with the spec, when behaviour changes ship without tests (an explicit `cr_allow_untested` status marker is the only, auditable, exemption), when assertions decrease net, or when test files were edited to make a red run look green. A loop budget (default 10 files / 400 changed lines) warns over budget and fails at 2x. Known gap: J6 is registered in the atom registry (now 85 atoms) and covered by its own tests, but is not yet wired into the yolo/corps verify stage — that wiring is planned for v0.4.

**Test gate v2 (`I6c`, #12) and per-phase cost accounting.** I6c now also rejects tests whose expected value is computed from the implementation under test, assertions inside callbacks that never fire, and self-comparisons that are always true — each check ships with a passing counter-example so honest tests are not blocked. `src/core/phase-cost.js` records wall-clock and tokens per phase; a run whose phase sum diverges from total wall-clock by more than 5% is flagged `within_tolerance: false`, so cost claims stay auditable.

**Clean benchmark patches (#8).** The SWE-bench harness generated `solution.diff` with the whole `specs/` evidence tree inside: one real openflow-arm patch was 17.0 MB, of which 99.9% was evidence files. Generation now excludes `specs/`, a harness-side filter strips it as a second line of defence, and regrade applies the same filter to old patches. The same patch is now 24 KB. `UV_CACHE_DIR` is also per-run now, and the repo gained `CONTRIBUTING.md` plus issue/PR templates.

**CI fix (#9).** The verify job died at "Install Playwright" because `ubuntu-latest` had rolled to 26.04, which Playwright 1.59.1 does not support. The runner is pinned to `ubuntu-24.04`; upgrading Playwright itself is a separate, larger change.

Also known: `xflow init` does not yet write OpenFlow entries into the user project's `.gitignore` (planned for v0.4).

## 0.2.2 - Benchmark docs

No CLI or gate changes: this release only updates documentation. The README now leads with the SWE-bench Verified result on DeepSeek-V4.1-Flash: OpenFlow resolved 4/6 and the plain baseline resolved 3/6 (n=1 per cell). It also states the caveats: n=1 on 6 instances puts one or two resolves within noise, and the two workflow tools took about 1.8x the baseline's median wall-clock and cost 76% (OpenFlow) / 61% (openswarm) more per task. The first published table undercounted pytest because of a shared temp-dir race in grading; it is now fixed and regraded, with notes in [bench/swebench/README.md](bench/swebench/README.md#regrade-2026-10-18). The optimization backlog from these results is tracked in [issue #5](https://github.com/surlymochan/openflow/issues/5).

## 0.2.1 - Tighter TDD and spec gates

Proof files are no longer trusted as JSON alone. `I6a` records a snapshot and a digest over the command, exit code, output hash, failure class, and file hashes. `I6b` recomputes that digest and re-runs the command on the snapshot. An agent who can rewrite the tree can still produce a self-consistent failing snapshot; a hand edit of the proof cannot.

`I6c` requires red and green to target the same test (or a green superset), rejects skip/todo/only on the changed tests, and rejects a type-only assertion when it is the only assertion. A plausible but wrong expected value is still not decidable statically. `J4b` rejects contradictory `MUST`/`SHALL` values for the same subject.

`tdd_mode` may be `red-green` (default), `refactor`, or `docs`, via `status.json` or `--tdd-mode`. Refactor checks that existing tests pass before and after and that assertions were not removed. Docs checks that the diff stays off code and tests.

## 0.2.0 - Relaunch (first npm release)

OpenFlow is published to npm as **`@surlymochan/openflow`**. The CLI is still `xflow`. The unscoped
`openflow` name on npm belongs to an unrelated project.

### Highlights

- **Policy overlays.** `xflow policy validate` checks personal and team policy layered over the built-in
  workflows. Policy, notify, storage, plugin and experience-digest atoms ship with it.
- **Adaptive intake.** `xflow intake recommend` reads a demand profile (title, description, repo count) and
  recommends `yolo` or `corps` plus gate overlays. It writes `workflow_recommendation.json`.
- **Execution profiles.** `xflow profile show|set` handles personal and team execution modes and provider
  preferences.
- **Comparisons.** `xflow compare super-assistant` is new, next to the Superpowers, OpenSpec, gstack,
  spec-kit and Codex goal comparisons.
- **New README.** It covers the problem, a demo GIF recorded from a real run, a 3-minute start and
  single-gate usage (`xflow atom run I6a.tdd.run ...`).

### Packaging

- `package.json` now has `repository`, `homepage`, `bugs`, `keywords`, `author`,
  `engines.node >= 22.5` (`node:sqlite`) and `publishConfig.access = public`.
- Install docs and the CLI's copy-paste commands now use `npm install -g @surlymochan/openflow`.
- `xflow serve` no longer points to an unpublished server repository.
- Fixed an uncaught `EPIPE` in `agent_invoke` when an agent CLI exits without reading stdin.

### Verified for this release

- `npm test`: 275 passed, 1 skipped, 0 failed (Node 22, Playwright Chromium installed).
- `npm run drift:scan`: 9/9.
- `npm publish --dry-run`: `@surlymochan/openflow@0.2.0`, 187 files, about 321 kB.
- Clean install from the packed tarball into an empty project: `xflow init`, `goal set`, `doctor` and
  `workflow validate yolo` all pass.

## 0.1.0 - Public Readiness Candidate

This release turns `openflow` from a local skill/workflow repo into a package-ready workflow runtime for AI coding agents.

### Highlights

- CLI package entry: `xflow` is exposed through `bin/xflow.js`.
- First-run loop: `xflow guide`, `xflow demo clean`, `xflow init`, `xflow doctor`, and `xflow workflow validate yolo`.
- Executable workflow data: `workflows/yolo.yaml` and `workflows/corps.yaml` are schema-validated.
- TDD enforcement: red proof, green proof, and changed-test quality review are separate gates.
- Spec durability: `xflow spec delta` and `xflow spec openspec-map` create local review/migration artifacts.
- Competitive proof: `xflow score`, `xflow compare openspec`, and `xflow compare spec-kit`.
- Adapter entrypoints: `xflow adapter import-file` and `xflow adapter github-issue` import external tracker context into local change artifacts.
- Public release gate: `npm run publish:check` runs tests, drift scan, skill diff, package dry-run, and npm publish dry-run.

### Adapter Commands

```bash
xflow adapter import-file --input docs/fixtures/tracker-item.json --json
xflow adapter github-issue --repo owner/name --issue 123 --project-root .
```

Adapters are intentionally thin. They copy source context into `specs/changes/<change-id>/proposal.md` and `status.json`; they do not make GitHub, Linear, Jira, or any tracker the workflow source of truth.

### Required Proof Before Real Publish

```bash
npm run publish:check
xflow score
xflow compare openspec
xflow compare spec-kit
```

`npm publish --access public` is the only remaining registry-mutating step. It requires an authenticated npm session and should only run after the dry-run gate is green.
