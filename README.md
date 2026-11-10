# evalid

[![CI](https://github.com/surlymochan/evalid/actions/workflows/ci.yml/badge.svg)](https://github.com/surlymochan/evalid/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@surlymochan/evalid?label=npm)](https://www.npmjs.com/package/@surlymochan/evalid)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node >= 22.5](https://img.shields.io/badge/node-%E2%89%A522.5-informational)
[![XERJ Corpus Hub contributor](https://hub.xerj.org/contributors/surlymochan/badge.svg)](https://hub.xerj.org/contributors/surlymochan)

**Claimed ≠ verified.**

evalid is a runtime verification layer for coding agents. Your agent says the tests pass — evalid seals the run, replays it from a clean snapshot, and shows you the gap between what was claimed and what actually passed.

- **Sealed evidence, replayed — not re-asked.** When tests run, the whole tree is hashed and sealed together with the command, exit code, and output. Verification copies the sealed snapshot to a clean directory and actually re-runs it, comparing exit codes and failure classes — and in the green phase, test files must hash-match the seal. If the agent edited the tests after the run, the seal breaks.
- **A zero-judge pipeline.** Spec clarification, code review, and test verification are plain deterministic code — no LLM judge anywhere in the chain, zero tokens spent on checking, every stage leaving an artifact you can inspect. Ambiguous specs are blocked before the loop starts; changes without test follow-through are blocked at review; unproven claims are blocked at replay.
- **The claim-vs-evidence ledger, with the cost attached.** Every delivery carries one record: what was claimed, what the replay showed, and what each phase cost in time and tokens — and when the phase ledger disagrees with wall-clock time by more than 5%, it flags itself as untrustworthy.

> An LLM judge can be persuaded, is non-deterministic, and bills you for every opinion. A replay can't be talked out of anything: same sealed snapshot, same commands, same exit codes — or the claim doesn't ship.

> **What the seal does and doesn't prove.** The seal is a content hash, not a cryptographic signature. A fully self-consistent forged snapshot could, in theory, still pass — we state this openly rather than oversell. What the seal does guarantee is narrower and real: the tests must actually have run at seal time, the test files at verification time are byte-identical to the ones that ran, and any tampering after the run breaks the hash and shows up. It is built to catch misreporting and test tampering — the failure modes agents actually exhibit — not to defeat a determined forger.

Underneath, a workflow engine (spec → implement → verify loops with per-phase budgets) produces the work that gets verified. It's the chassis, not the headline: verification is the product. The `xflow` CLI runs the same workflows from Codex, Claude Code, Cursor, OpenCode, Gemini or a plain terminal.

_Renamed from OpenFlow in v0.3.1 (2026-11-04); old repository and package links redirect._

## Benchmarks: evalid vs superpowers (2026-10-17)

_These results were measured before the rename, when the project was named OpenFlow; product names in this section have been unified to the current names (evalid, swrm), and all versions and figures are the original measurements._

For the synthetic and evidence-check results below, the same model (`grok-4.7-high` via local `cursor-agent`) and same
harness are used for every arm; the SWE-bench block uses DeepSeek via Pi. Pinned: evalid 0.2.1,
[superpowers](https://github.com/obra/superpowers) v7.0.0 (`bb92a77`). Scripts, raw results and methodology:
[`bench/`](bench/README.md) and [`bench/e2e/`](bench/e2e/README.md). Losses are shown as measured.

**Real GitHub issues (SWE-bench Verified), 2026-10-18.** Six hard instances from sympy, pytest and pylint; success
means the official FAIL_TO_PASS and PASS_TO_PASS tests all pass. Every arm runs on the Pi coding agent with
DeepSeek-V4.1-Flash (`deepseek-flash`), n=1 per cell, 20-minute cap; details and commands are in
[`bench/swebench/`](bench/swebench/README.md).

| Arm | Resolved (official tests) | Median wall-clock (IQR) | Median $ per task (DeepSeek list price) | Total $ (all runs) | n |
| --- | --- | --- | --- | --- | --- |
| Plain agent (baseline) | 3/6 (50%) | 124 s (110–175) | $0.0234 | $0.16 | 6 |
| superpowers v7.0.0 | 2/6 (33%) | 154 s (136–340) | $0.0285 | $0.31 | 6 |
| evalid 0.2.1 | 4/6 (67%) | 230 s (200–266) | $0.0412 | $0.23 | 6 |
| swrm (Pi executor) | 5/6 (83%) | 228 s (187–254) | $0.0377 | $0.21 | 6 |

**Caveats:** n=1 on 6 instances, so one or two resolves are within noise. The two workflow tools took about 1.8x the
baseline's median wall-clock and cost 76% (evalid) / 61% (swrm) more per task. The first published table undercounted
pytest because of a shared temp-dir race in grading; it is now fixed and regraded
([regrade notes](bench/swebench/README.md#regrade-2026-10-18)). On the MiniMax-M3.1-Flash-Preview subset, baseline
resolved 3/4 and superpowers 2/4; evalid had no clean MiniMax run because the plan's usage cap was hit.

Raw per-run records and logs: [`bench/swebench/results/`](bench/swebench/results/). Optimization backlog from these
results: [#5](https://github.com/surlymochan/evalid/issues/5).

**Synthetic end-to-end tasks.** 8 small real tasks (4 JS, 4 Python), hidden acceptance tests applied only after the agent exits, 20-minute cap per run.

| Arm | Success (hidden tests) | Median wall time (IQR) | Median tokens: total / input+output | n |
| --- | --- | --- | --- | --- |
| Plain agent (baseline) | 24/24 (100%) | 55 s (46–132) | 105k / 28k | 24 |
| superpowers v7.0.0 | 24/24 (100%) | 187 s (121–299) | 312k / 59k | 24 |
| evalid 0.2.1 | 11/12 (92%) | 985 s (920–1195) | 5.29M / 233k ¹ | 12 ² |

On tasks this small the plain agent already succeeds every time, and evalid's full ceremony is the slowest and most
token-hungry arm. 3 of 12 evalid runs hit the 20-minute cap while still running the workflow; their code already passed.
¹ Tokens counted only for runs that reported usage (not the 3 capped runs). Most of "total" is cache reads.
² 3 repeats on 2 tasks, 1 on the other 6, to save quota. Matched repeat-1 view (n=8 each): baseline 8/8, 57 s, 104k; superpowers 8/8, 154 s, 289k; evalid 8/8, 1008 s, 5.32M.

**Catching fake TDD / verification evidence.** 36 scripted episodes: 25 faulty (red proof recorded after the fix, forged
proofs, skipped tests, weak or wrong assertions, contradictory specs, …) and 11 honest ones. Of these, 12 are a held-out set written after the fixes.

| Checker | Faulty caught | Honest wrongly rejected | Cost per check |
| --- | --- | --- | --- |
| evalid 0.2.1 gates (deterministic code) | 22/25 (88%): original 16/17, held-out 6/8 | 0/11 | ~0.1–0.2 s, no model tokens |
| superpowers v7.0.0 skills + LLM judge | 25/25 (100%) | 1/11 | one agent call per check |
| LLM judge, no skills | 25/25 (100%) ³ | 0/11 | one agent call per check |
| evalid 0.2.0 (before this benchmark, original 24 only) | 10/17 (59%) | 3/7 | – |

An LLM reviewer that is explicitly asked to audit an episode, and is allowed to rerun the tests, caught more than evalid's static gates did.
evalid's gates are deterministic and cost no model calls, but they still miss plausible-but-wrong expected values,
assertions in callbacks that never run, and behavior changes hidden inside a declared refactor.
³ 1 of the 11 honest runs timed out and counts as incorrect. LLM arms used 1 run per scenario.

Prompt-based workflows *ask* an agent to write the failing test first, run the suite and keep notes. evalid
*checks* that it did. Workflows are YAML phases made of small deterministic "atoms". Gates are code: a
red/green TDD proof, a test-quality review, artifact checks, and archive ordering. The `xflow` CLI runs the
same workflows from Codex, Claude Code, Cursor, OpenCode, Gemini or a plain terminal.

![evalid demo: a red proof must fail, a green proof must pass, and a faked red proof is rejected](docs/assets/demo.gif)

<sub>Recorded from a real run of the CLI in an empty project. The last two commands show an agent "recording" a
red proof after the fix, and the gate rejecting it.</sub>

## Why

Agent workflow kits are good at shaping behaviour, but the checks only live in prose. Agents skip the red
step, write tests that assert nothing, lose context between sessions, and open PRs before verification has
finished. evalid adds a harder layer underneath:

- **Workflow as data.** `workflows/yolo.yaml` and `workflows/corps.yaml` are validated against an atom registry before they run.
- **TDD proof checked by code.**
  - `I6a` snapshots the tree and binds the command, exit code, output hash, and failure class. `I6b` recomputes that binding and re-runs the command on the snapshot. A hand-edited proof does not pass unless that snapshot really exits as claimed.
  - Red and green must target the same test, or green must be a superset of the red test. Skipped, todo, and focused tests do not count as red or green.
  - `I6c.tdd.quality_review` rejects code changes that have:
    - no meaningful test changes,
    - empty assertions,
    - snapshot-only tests,
    - mock-heavy tests without real assertions,
    - only a type or existence assertion (`typeof`, `!== undefined`).
  - `tdd_mode` in `status.json` (or `--tdd-mode`) may be `red-green` (default), `refactor`, or `docs`. Refactor requires the existing tests to pass before and after, with no assertion removed. Docs allows a non-code diff and does not require a red proof. Declaring docs while changing code, or refactor while deleting assertions, fails.
- **Context that survives sessions.**
  - The `.xflow/GOAL.md` project anchor.
  - `HANDOFF.md` and `AHA.md`.
  - Per-change `status.json` and proof files under `specs/changes/<id>/`.
- **Executable finish.** Verify → archive → commit/push → PR ordering is a tested atom, not a checklist.

## Features

- **YAML workflows, validated before they run** — phases are data (`workflows/*.yaml`), checked against an atom registry before execution.
- **Red/green TDD proof gates enforced by code** — proofs bind the command, exit code and output hash, and are re-verified on a snapshot; hand-edited or faked proofs are rejected, and skipped, todo or focused tests do not count.
- **Automatic test-quality review** — changes with no meaningful test changes, empty assertions, snapshot-only tests or mock-heavy tests without real assertions are rejected.
- **Context that survives sessions** — `.xflow/GOAL.md`, `HANDOFF.md` and per-change `status.json` carry state across sessions and agents.
- **Executable finish line** — verify → archive → commit/push → PR ordering is a tested workflow atom, not a prose checklist.
- **One CLI for multiple agents** — the `xflow` CLI drives Codex, Claude Code and Cursor from the same workflow files.

## 3 Minute Start

Requires Node.js ≥ 22.5 (for `node:sqlite`) and Python 3 (atoms are small Python scripts).

```bash
npm install -g evalid     # installs the `xflow` CLI
cd your-project
xflow init --project-root .               # writes .as-xflow/config.json
xflow goal set "Ship the next verified change" --project-root .
xflow goal audit --project-root . --json
xflow doctor --project-root .
xflow workflow validate yolo --project-root .
xflow guide                               # the delivery loop in one screen
```

For a source checkout:

```bash
git clone https://github.com/surlymochan/evalid.git
cd evalid
npm ci && npm test
node bin/xflow.js quickstart
node bin/xflow.js evaluate
node bin/xflow.js compare codex-goal
node bin/xflow.js launch copy
```

## GitHub Action: verify proofs in CI

evalid ships as a GitHub Action (`action.yml` at the repo root). Add it to a
workflow to verify a sealed TDD proof on every PR: a valid proof keeps the
check green, a broken seal (or a test edited after the seal) turns it red —
and the claim-vs-evidence ledger is posted as a PR comment either way, so
the reviewer sees the claim next to the replay evidence without opening
the workflow log.

```yaml
name: Proof ledger
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
jobs:
  ledger:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7.0.1
        with:
          fetch-depth: 0  # replay materializes files from the recorded HEAD
      - uses: actions/setup-node@v7.1.0
        with:
          node-version: '22'
      - uses: surlymochan/evalid@main  # or a release tag (see CHANGELOG)
        with:
          change-id: my-change
          phase: green
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

Inputs: `change-id` (required), `phase` (`green`, default), `attempt` (`0`,
default), `project-root` (`.`, default), `tdd-mode` (auto-detect, default),
`post-comment` (`true`, default — set `false` to skip the comment),
`github-token` (defaults to `$GITHUB_TOKEN`), `pr-number` (auto-detects
from the event payload or ref when empty).

The comment is upserted on a stable marker
(`<!-- evalid-ledger: <change-id>/<phase>/<attempt> -->`), so re-runs
update the same comment instead of posting a new one per push. A failed
comment post never masks the verdict: the step still exits on the proof
result, and `comment_posted` / `comment_url` are exposed as outputs.
The check fails (exit 1) on `binding_mismatch`, `snapshot_mismatch`,
`green_tree_mismatch`, replay mismatches, or a missing proof; the comment
names the breakage point (for example the test files that drifted after
the seal).

Local equivalent of the CI replay — same validator, same entry:

```bash
node action/verify-proof.mjs --project-root . --change-id my-change --phase green
```

This repo dogfoods the Action on its own PRs via
`.github/workflows/proof-ledger.yml`: it discovers every sealed proof
added or changed by the PR (`specs/changes/*/tdd/*.json`) and verifies
each one.

## `xflow audit`: verify any PR, no evalid workflow required

`xflow audit` checks a change you did *not* produce with evalid: point it
at any git diff or PR — Claude Code, Codex, or any other agent's output —
and it extracts the test runs the change claims to have passed, replays
each one in a clean clone at the change's head, and compares exit codes
and pass/fail counts against the claim. If the diff carries an evalid
proof seal, the seal is replayed through the existing i6b validator.

```bash
xflow audit change.patch --base HEAD~1 --claims-file claims.txt
xflow audit 75                        # audit a GitHub PR (body = claims)
xflow audit surlymochan/evalid#75     # same, naming the repo
xflow audit --pr 75                   # flag form of the same
xflow audit --diff change.patch --base HEAD~1 --claims-file claims.txt
xflow audit --base main --head feature/x --claims "npm test: exit 0"
```

Verdicts: `verified` (every claim replayed as claimed), `mismatch` (a
replay contradicts a claim, or a seal is invalid), `no_claims` (no test
claims found in the supplied text), `unverifiable` (a claimed command
could not run). Exit codes are 0 / 1 / 3 / 1 respectively (2 = misuse).
`--json` prints the machine-readable report; `--out <file>` writes it.

When the diff touches Python test files and the audited repo carries the
I6d plugin (`xflow/atoms/i6d_assertion_execution.py`), the audit also runs
the assertion-execution gate: an added or changed assertion that never
executes during the green replay flips the verdict to `mismatch`, even
when every claimed run replays green. `scripts/demo-i6d-gate.sh` is a
self-contained red/green demonstration of that gate (M3).

## Commands

The installed binary is `xflow` (`npm install -g evalid` installs the `xflow` CLI). Every
top-level command below was verified against `xflow <command> --help` at v0.5.7; run
`xflow --help` for the full list with examples, or `xflow <command> --help` for one command.

| Command | What it does |
| --- | --- |
| `xflow workflow run \| validate <yaml>` | Run a workflow (`yolo` / `corps` / a YAML path), or validate its YAML as preflight |
| `xflow corps` | Run the heavy product/multi-agent workflow through its governed entry point |
| `xflow proof` | Verify workflow completion evidence and write the proof file |
| `xflow audit` | Audit any git diff / PR: replay claimed test runs, verdict |
| `xflow doctor` | Check local xflow readiness: package scripts, workflow YAMLs, skill topology |
| `xflow init` | Create project-local `.as-xflow/config.json` with portable defaults |
| `xflow goal show \| set \| audit \| clear` | Manage the project-level `.xflow/GOAL.md` anchor |
| `xflow profile show \| set` | Manage the personal/team execution profile |
| `xflow policy validate` | Validate the effective policy overlay |
| `xflow intake recommend` | Recommend a workflow track and gate overlays from a demand profile |
| `xflow evaluate` | One-shot external evaluator brief: quality score, blockers, next actions |
| `xflow release status` | Release-owner publish status: current blocker, package evidence, next action |
| `xflow assess` | Public quality assessment for goal, yolo, corps and the skill family |
| `xflow demo launch \| clean` | Show launch demo paths, or run the clean-project adoption smoke |
| `xflow launch audit \| dossier \| claims \| copy` | Audit launch readiness, or print the dossier, claimable statements, or safe launch copy |
| `xflow adoption validate \| init \| kit \| trial \| brief \| status` | Validate real adoption evidence records, or guide an external trial |
| `xflow package audit \| preflight \| status` | Validate npm package evidence; preflight checks publish prerequisites without publishing |
| `xflow score` | Print the competitive readiness score |
| `xflow objective` | Audit the top-level product objective against proof from source checkout |
| `xflow compare <system>` | Evidence-backed comparison against `superpowers`, `codex-goal`, `super-assistant`, `openspec`, `gstack`, or `spec-kit` |
| `xflow adapter import-file` | Import a generic tracker item JSON into `specs/changes/<change-id>/` |
| `xflow spec start \| delta \| openspec-map` | Scaffold specs, generate a spec delta review, or map an OpenSpec layout |
| `xflow qa capture \| review \| ship \| benchmark` | Browser-QA capture with QA-focused defaults, packaged as review, ship-gate, or benchmark |
| `xflow host status \| sync \| diff` | Show or maintain installed xflow skill copies across host roots |
| `xflow coach <topic>` | Concise execution checklist (`bugfix`, `feature`, `review`, `qa`, `ship`, `tdd`, `debug`, `red`, `green`, `verify`) |
| `xflow role <role>` | Named specialist operator surface (`developer`, `reviewer`, `qa`, `release`, `product`) |
| `xflow visual capture-page-evidence \| export-dom-rects \| export-visual-tokens \| diff-images \| render-report` | Screenshot/DOM capture and visual-token / image-diff tooling |
| `xflow quickstart` | Copy-paste-safe first-run commands |
| `xflow guide` | The human-facing delivery loop in one screen |
| `xflow gate ack <phase>` | Approve a pending human gate so a run can resume |
| `xflow atom list \| show \| run` | List, inspect, or run a single registered atom directly |
| `xflow serve` | Start the HTTP control plane for heavy-track workflows |

## Run a change

```bash
git checkout -b feat/example-change
xflow workflow run yolo \
  --title "Example change" --change-type backend \
  --tdd-red-command  "npm test -- --grep new-behavior" \
  --tdd-green-command "npm test"
```

The lite track runs `tdd-red -> execute -> tdd-green -> verify -> archive` and stops at human or LLM gates. Every
phase leaves evidence in `specs/changes/<change-id>/`. Add `--dry-run` to print the phases, atoms and gates
first.

You can also run a single gate directly, as in the demo:

```bash
xflow atom run I6a.tdd.run --change-id my-change --phase red   --test-command "npm test"
xflow atom run I6a.tdd.run --change-id my-change --phase green --test-command "npm test"
xflow atom run I6b.tdd.proof_validate --change-id my-change --phase red
```

## Evaluate it

```bash
xflow quickstart        # copy-paste-safe first-run commands
xflow evaluate          # one-shot brief: quality score, comparisons, blockers, next actions
xflow assess            # scorecard for goal, yolo, corps and the skill family
xflow score             # competitive readiness score with evidence per dimension
xflow demo launch       # goal -> yolo and goal -> corps proof paths
xflow launch dossier    # one-page narrative backed by the same audit
xflow launch copy       # claim-safe announcement copy plus forbidden phrases
xflow release status    # the single next release blocker
```

<details>
<summary>Release-owner gates (fail until real adoption / npm evidence exists)</summary>

```bash
xflow adoption trial --name <team-or-project> --source <tracker-or-pr> --track yolo
xflow adoption status --json
xflow package preflight --check-registry --check-auth --json
xflow package audit --check-registry --json
xflow launch audit --pre-publish --strict --json
```

</details>

## Choose a track

| Track | Use when | Entry |
| --- | --- | --- |
| `goal` | You want a project-level direction anchor that later work reads and audits | `xflow goal set`, `xflow goal audit` |
| `plan` | You only need a reusable implementation plan | `xflow:plan` skill |
| `yolo` | Backend, docs, infra, small UI; low ceremony | `xflow workflow run yolo` |
| `corps` | Product/UI-heavy or multi-agent work with governed proof | `xflow corps --explain`, then `xflow corps` and `xflow proof --track corps` |
| `ralph` | Keep implementing, verifying and repairing until the completion evidence is clean | `xflow:ralph` skill |

Not sure which one fits? Run `xflow intake recommend --change-id <id> --title "<title>" --description "<text>"`.

## How it fits together

```
workflows/*.yaml ──validate──► atoms/registry.json ──► xflow/atoms/*.py   (deterministic steps)
        │                                                    │
        ▼                                                    ▼
  xflow workflow run ──► gates: deterministic | artifact-verify | human | llm
        │
        ▼
  specs/changes/<id>/   status.json · tdd/red-0.json · tdd/green-0.json · quality-0.json · logs/*.ndjson
```

- `bin/xflow.js`: the CLI. `src/`: workflow loader, runner, policy overlays, scoring.
- `xflow/`: the portable skill family (`xflow:plan`, `xflow:yolo`, `xflow:corps`, `xflow:ralph`, …) for agent hosts.
- `schemas/`: JSON schemas for workflows, proofs and policy overlays.

## Compared with other tools

evalid aims to complement prompt-level workflow kits and spec tools, not replace them. `xflow compare
<superpowers|openspec|gstack|spec-kit|codex-goal>` prints a side-by-side with sources.

<details>
<summary>Full capability table</summary>

| Surface | evalid Position |
| --- | --- |
| Goal alignment | Project-level `.xflow/GOAL.md` that yolo, corps, Ralph, handoff, and takein consume |
| One-shot evaluation | `xflow evaluate` combines quality score, Codex goal / Superpowers / Super-Assistant comparison, ordinary and splash launch blockers, release-owner status, claim boundaries, next actions, and first-run path |
| Quality assessment | `xflow assess` gives a public scorecard for goal, yolo, corps, and the skill family |
| Launch demo | `xflow demo launch` shows goal -> yolo and goal -> corps proof paths |
| Launch audit | `xflow launch audit` separates ready engine and adoption evidence from missing registry proof |
| Launch dossier | `xflow launch dossier` prints the one-page public narrative backed by the same audit payload |
| Launch claims | `xflow launch claims` separates what can be said publicly now from claims blocked by missing evidence |
| Launch copy | `xflow launch copy` generates claim-safe announcement copy and forbidden phrases from the same evidence |
| Package status | `xflow package status` gives a non-failing publish/install status summary |
| Package audit | `xflow package audit` validates public npm registry evidence before splash-launch claims |
| Release status | `xflow release status` gives the release owner one focused blocker, next action, package status, and handoff doc |
| Adoption status | `xflow adoption status` gives a non-failing ordinary/splash adoption blocker summary |
| Adoption trial | `xflow adoption trial` gives external teams the exact commands and evidence checklist before a trial packet is written |
| Publish handoff | `docs/npm-publish-handoff.md` records the exact auth, preflight, publish, and post-publish gates |
| TDD | Executable red/green proof plus quality review |
| Workflow | YAML phases validated against atom registry |
| Spec migration | OpenSpec mapping report plus deterministic `spec_delta_review.json` |
| Local closure | Doctor, drift scan, release pack, archive ordering |
| Team handoff | `HANDOFF.md`, `AHA.md`, reviewer guide |
| Team adoption | Role model, CI boundary, PR acceptance, release ownership |
| Cross-tool use | Plain CLI and skill docs for Codex, Claude Code, Cursor, OpenCode, Gemini |
| Competitive proof | `xflow compare codex-goal`, `xflow compare superpowers`, `xflow compare super-assistant`, `xflow compare openspec`, `xflow compare gstack`, `xflow compare spec-kit`, benchmark docs |
| Adoption proof | Minimal clean project runs in CI, plus public adoption-record templates |

</details>

## Docs

<details>
<summary>All guides</summary>

- [Quickstart](docs/quickstart.md)
- [Install and upgrade](docs/install-upgrade.md)
- [Tooling matrix](docs/tooling-matrix.md)
- [Compatibility notes](docs/compatibility.md)
- [Demo proof](docs/demo-proof.md)
- [Examples gallery](docs/examples-gallery.md)
- [Public benchmark](docs/public-benchmark.md)
- [Quality assessment](docs/quality-assessment.md)
- [Launch demo](docs/launch-demo.md)
- [Launch dossier](docs/launch-dossier.md)
- [Corps operator guide](docs/corps-operator-guide.md)
- [Superpowers comparison](docs/superpowers-comparison.md)
- [Super-Assistant comparison](docs/super-assistant-comparison.md)
- [Adoption evidence template](docs/adoption/README.md)
- [Maintainer adoption record](docs/adoption/openflow-release-hardening.md)
- [xflow Goal vs Codex native goal](docs/goal-vs-codex.md)
- [Walkthrough](docs/walkthrough.md)
- [OpenSpec migration](docs/openspec-migration.md)
- [spec-kit benchmark](docs/spec-kit-benchmark.md)
- [Integration matrix](docs/integrations.md)
- [Public release gate](docs/public-release.md)
- [npm publish handoff](docs/npm-publish-handoff.md)
- [Release notes](RELEASE_NOTES.md)
- [Adapter fixture](docs/fixtures/tracker-item.json)
- [Methodology](docs/methodology.md)
- [Reviewer guide](docs/reviewer-guide.md)
- [Team adoption operating model](docs/team-adoption.md)
- [Competitive benchmark](docs/competitive-benchmark.md)
- [2026-05-25 benchmark report](docs/benchmark-evalid-vs-gstack-superpowers-openspec-2026-05-25.md)

</details>

## Development

```bash
npm ci
npx playwright install chromium   # browser-evidence tests
npm test                          # 270+ tests
npm run coverage                  # same suite with a c8 coverage report in coverage/
npm run drift:scan                # docs/skill/workflow drift checks
npm run pack:check                # what would be published
```

Contributions are welcome: open an issue describing the workflow problem first, then a PR with tests. Keep
claims in docs tied to a command that reproduces them.

## License

[MIT](LICENSE)
