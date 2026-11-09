/**
 * M4 slice 2 acceptance demo (evalid #97).
 *
 * Drives a real small fix through the real `--lite` path end to end: a
 * throwaway git repo holds a buggy copy of lite_track.py plus the
 * classifier's own deps; the real WorkflowExecutor runs the real
 * workflows/yolo.yaml phases (proposal-consistency-check, tdd-red,
 * tdd-green, verify-consistency) with the real atom registry. The red
 * run seals a failing proof, the fix is applied, and the green run
 * seals a passing proof and replays it clean. Wall-clock numbers are
 * printed, never asserted: n=1 per track, preliminary until the bench
 * full-matrix run lands (issue #5 P1-2 stays unticked).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { load } from '../src/core/workflow-loader.js';
import { WorkflowExecutor } from '../src/core/workflow-executor.js';

const repoRoot = resolve(import.meta.dirname, '..');
const python = process.env.PYTHON || 'python3';
const CHANGE_ID = 'chg-m4-slice2-demo';
const DEMO_PHASES = ['proposal-consistency-check', 'tdd-red', 'tdd-green', 'verify-consistency'];

// The fixed block in the checkout's lite_track.py (must match byte for
// byte; the guard in buildDemoRepo fails loudly if the fix moves).
const FIXED_BLOCK = String.raw`    if uncommitted:
        # changed_lines(..., uncommitted=True) unions the working tree, so
        # the numstat side must measure that same union: the worktree diff
        # against the base. Merging the committed and worktree numstats
        # with max() overcounts whenever the worktree partially reverts
        # committed lines (a branch that added 10 lines, cut back by 5 in
        # the worktree, read as 15 changed lines instead of the true 5).
        stats = _numstat_worktree(repo, base_sha)`;

// The pre-fix block, rebuilt verbatim so the demo repo starts buggy.
const BUGGY_BLOCK = String.raw`    if uncommitted:
        # changed_lines(..., uncommitted=True) unions the working tree; the
        # numstat side must match it or deletion-only worktree edits vanish.
        raw_wt = _git(repo, "diff", "--numstat", "HEAD", "--")
        for line in raw_wt.splitlines():
            if not line.strip():
                continue
            added_s, removed_s, path = line.split("\t", 2)
            a = 0 if added_s == "-" else int(added_s)
            r = 0 if removed_s == "-" else int(removed_s)
            prev_a, prev_r = stats.get(path, (0, 0))
            stats[path] = (max(prev_a, a), max(prev_r, r))`;

// The demo test (v1) that ships in the demo repo's base commit: it fails
// against the buggy classifier and passes once the fix lands. v2 adds the
// added/removed pins as part of the fix itself.
const DEMO_TEST_V1 = String.raw`import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const demoRoot = join(import.meta.dirname, '..');

function git(dir, ...args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, 'git ' + args.join(' ') + ' failed: ' + result.stderr);
}

function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'lite-track-fixture-'));
  git(dir, 'init', '-b', 'main', '-q');
  git(dir, 'config', 'user.email', 'demo@test');
  git(dir, 'config', 'user.name', 'm4-demo');
  const ten = Array.from({ length: 10 }, (_, i) => 'line' + (i + 1)).join('\n') + '\n';
  writeFileSync(join(dir, 'f.txt'), ten);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'feature');
  const twenty = Array.from({ length: 20 }, (_, i) => 'line' + (i + 1)).join('\n') + '\n';
  writeFileSync(join(dir, 'f.txt'), twenty);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'add 10 lines');
  const fifteen = Array.from({ length: 15 }, (_, i) => 'line' + (i + 1)).join('\n') + '\n';
  writeFileSync(join(dir, 'f.txt'), fifteen);
  return dir;
}

// Exercises classify_repo in lite_track.py through the real CLI: the
// fixture branch adds 10 lines and the worktree cuts 5 back, so the true
// worktree-vs-base count is 5 lines.
test('classify_repo --uncommitted counts the worktree diff against the base', () => {
  const source = readFileSync(join(demoRoot, 'lite_track.py'), 'utf8');
  assert.ok(source.includes('def classify_repo('), 'lite_track.py should define classify_repo');
  const dir = fixtureRepo();
  try {
    const result = spawnSync('python3', [join(demoRoot, 'lite_track.py'), '--repo', dir, '--uncommitted', '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, 'lite_track.py failed: ' + result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.total, 5, 'uncommitted total should be the true worktree-vs-base count, got ' + JSON.stringify(verdict));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
`;

const TOTAL_ASSERT = "    assert.equal(verdict.total, 5, 'uncommitted total should be the true worktree-vs-base count, got ' + JSON.stringify(verdict));";
const EXTRA_ASSERTS = [
  "    assert.equal(verdict.added, 5, 'added should be 5, got ' + JSON.stringify(verdict));",
  "    assert.equal(verdict.removed, 0, 'removed should be 0, got ' + JSON.stringify(verdict));",
].join('\n');
const DEMO_TEST_V2 = DEMO_TEST_V1.replace(TOTAL_ASSERT, `${TOTAL_ASSERT}\n${EXTRA_ASSERTS}`);
assert.ok(DEMO_TEST_V2 !== DEMO_TEST_V1, 'v2 demo test must extend v1');

// Specs seeded into the demo repo. Written to stay J4d-clean: no MUST /
// SHALL, no vague quality words, no TBD / TODO markers, no Scenario
// blocks — the full track runs J4a / J4d / J4b against these for real.
const PROPOSAL_MD = `# Proposal: correct lite_track uncommitted counting

## Problem
\`lite_track.py\` \`classify_repo\` with \`--uncommitted\` reports 15 changed lines for a worktree that holds 5 added lines against the base: the branch added 10 lines to \`f.txt\` and the worktree cut 5 of them, and the numstat merge takes the per-file max (10 added, 5 removed) instead of the worktree diff against the base (5 added, 0 removed). The reported numbers are wrong, and a larger revert could flip a small change to \`full\` on numbers that do not describe the tree.

## Scope
- Change \`classify_repo\` in \`lite_track.py\` so the \`--uncommitted\` numstat reads the worktree diff against the base directly.
- Add a regression test in \`test/demo.test.mjs\` that pins added 5, removed 0, total 5 for the fixture above.
- Keep the committed-diff path unchanged; keep thresholds (10 files, 300 lines) unchanged.
`;

const PLAN_MD = `# Plan: lite_track uncommitted count fix

## Steps
1. Reproduce the miscount in a scratch git repo: 10-line file, branch adds 10 lines, worktree cuts 5; classifier reports 15 lines where the worktree holds 5 added lines.
2. Change \`classify_repo\` in \`lite_track.py\` to read the worktree numstat against the base sha directly.
3. Extend \`test/demo.test.mjs\` with added/removed assertions for the same fixture.
4. Run the demo test file red (before the fix) and green (after the fix) through the lite track.

## Verification
\`\`\`bash
node --test test/demo.test.mjs
\`\`\`
`;

const TASKS_MD = `# Tasks
- [ ] Reproduce the uncommitted miscount (15 reported, 5 true)
- [ ] Fix the numstat merge in lite_track.py
- [ ] Extend test/demo.test.mjs with added/removed assertions
- [ ] Run the lite-track demo red then green
`;

function git(dir, ...args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

function buildDemoRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'evalid-m4-demo-'));
  git(dir, 'init', '-b', 'main', '-q');
  git(dir, 'config', 'user.email', 'demo@test');
  git(dir, 'config', 'user.name', 'm4-demo');
  const checkout = readFileSync(join(repoRoot, 'xflow', 'atoms', 'lite_track.py'), 'utf8');
  assert.ok(checkout.includes(FIXED_BLOCK), 'checkout lite_track.py must contain the fixed uncommitted block');
  assert.ok(!checkout.includes('max(prev_a, a)'), 'checkout lite_track.py must not contain the old max() merge');
  const buggy = checkout.replace(FIXED_BLOCK, BUGGY_BLOCK);
  assert.notEqual(buggy, checkout, 'buggy rebuild must differ from the checkout file');
  for (const name of ['i6d_assertion_execution.py', 'tdd_lib.py']) {
    writeFileSync(join(dir, name), readFileSync(join(repoRoot, 'xflow', 'atoms', name), 'utf8'));
  }
  writeFileSync(join(dir, 'lite_track.py'), buggy);
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'test', 'demo.test.mjs'), DEMO_TEST_V1);
  // Runtime-generated paths the workflow itself writes (.as-xflow state
  // and logs, python bytecode) must not count as changed files: the real
  // repo's .gitignore excludes them too, and J6 unions untracked files
  // into its loop budget. Without this the execution log alone blows the
  // 400-line budget.
  writeFileSync(join(dir, '.gitignore'), '.as-xflow/\n__pycache__/\n*.pyc\n');
  const changeDir = join(dir, 'specs', 'changes', CHANGE_ID);
  mkdirSync(changeDir, { recursive: true });
  writeFileSync(join(changeDir, 'status.json'), JSON.stringify({
    change_id: CHANGE_ID,
    title: 'M4 slice 2 acceptance demo: lite_track uncommitted count fix',
    change_type: 'backend',
    status: 'active',
    current_stage: 'change-init',
    tdd_mode: 'red-green',
  }, null, 2));
  writeFileSync(join(changeDir, 'proposal.md'), PROPOSAL_MD);
  writeFileSync(join(changeDir, 'plan.md'), PLAN_MD);
  writeFileSync(join(changeDir, 'tasks.md'), TASKS_MD);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'demo base: buggy lite_track classifier, failing test, specs');
  return dir;
}

function applyFix(dir) {
  writeFileSync(join(dir, 'lite_track.py'), readFileSync(join(repoRoot, 'xflow', 'atoms', 'lite_track.py'), 'utf8'));
  const testPath = join(dir, 'test', 'demo.test.mjs');
  const v1 = readFileSync(testPath, 'utf8');
  assert.ok(v1.includes(TOTAL_ASSERT), 'demo test must contain the total assertion to extend');
  writeFileSync(testPath, v1.replace(TOTAL_ASSERT, `${TOTAL_ASSERT}\n${EXTRA_ASSERTS}`));
}

function classifyDemo(dir, extraArgs = []) {
  const result = spawnSync(python, [join(dir, 'lite_track.py'), '--repo', dir, '--uncommitted', '--json', ...extraArgs], { encoding: 'utf8' });
  assert.equal(result.status, 0, `lite_track.py failed: ${result.stderr}${result.stdout}`);
  return JSON.parse(result.stdout);
}

function readExecutionLog(dir) {
  const logPath = join(dir, '.as-xflow', 'logs', 'execution.ndjson');
  assert.ok(existsSync(logPath), 'execution log should exist');
  return readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function readProof(dir, name) {
  const proofPath = join(dir, 'specs', 'changes', CHANGE_ID, 'tdd', name);
  assert.ok(existsSync(proofPath), `proof ${name} should exist`);
  return JSON.parse(readFileSync(proofPath, 'utf8'));
}

function demoPhases() {
  const loaded = load(join(repoRoot, 'workflows', 'yolo.yaml'), { skipRuntimeChecks: true });
  return {
    workflow: loaded.workflow,
    registry: loaded.registry,
    phases: loaded.phases.filter((phase) => DEMO_PHASES.includes(phase.id)),
  };
}

function demoExecutor({ dir, lite }) {
  const { workflow, registry, phases } = demoPhases();
  assert.deepEqual(
    phases.map((phase) => phase.id),
    DEMO_PHASES,
    'demo phases must come from the real yolo.yaml in order',
  );
  return new WorkflowExecutor({
    workflow,
    phases,
    registry,
    workflowPath: join(repoRoot, 'workflows', 'yolo.yaml'),
    projectRoot: dir,
    changeId: CHANGE_ID,
    exitOnFailure: false,
    input: {
      lite,
      change_type: 'backend',
      title: 'M4 slice 2 acceptance demo: lite_track uncommitted count fix',
      tdd_red_command: 'node --test test/demo.test.mjs',
      tdd_green_command: 'node --test test/demo.test.mjs',
      tdd_mode: 'red-green',
    },
  });
}

// One run over all four demo phases. Before the fix the run must stop at
// the green phase (the test still fails); the second run over the same
// phase list resumes from tdd-red via the executor's own state — the two
// runs share one workflow manifest digest, so the integrity check holds.
async function runDemo({ dir, lite }) {
  const executor = demoExecutor({ dir, lite });
  const started = Date.now();
  await executor.run();
  return { executor, ms: Date.now() - started };
}

async function runDemoExpectStop({ dir, lite, stopPhase }) {
  const executor = demoExecutor({ dir, lite });
  const started = Date.now();
  let error = null;
  try {
    await executor.run();
  } catch (caught) {
    error = caught;
  }
  const ms = Date.now() - started;
  assert.ok(error, `run must stop before the fix (expected stop at ${stopPhase})`);
  assert.match(error.message, new RegExp(`stopped at phase "${stopPhase}"`),
    `run must stop at ${stopPhase}, got: ${error?.message}`);
  return { executor, ms };
}

describe('M4 slice 2 acceptance demo (evalid #97)', () => {
  test('the real fix classifies lite; a large change and a specs touch classify full', () => {
    const dir = buildDemoRepo();
    try {
      applyFix(dir);
      const verdict = classifyDemo(dir);
      assert.equal(verdict.track, 'lite');
      assert.equal(verdict.files, 2);
      assert.ok(verdict.total <= 300, `fix total ${verdict.total} should be within the lite budget`);

      // Large-change control: 400 added lines stay on the full track.
      // The file must be staged: `git diff` (which the classifier reads)
      // ignores untracked files.
      const big = Array.from({ length: 400 }, (_, i) => `added line ${i}`).join('\n') + '\n';
      writeFileSync(join(dir, 'big.txt'), big);
      git(dir, 'add', 'big.txt');
      const fullVerdict = classifyDemo(dir);
      assert.equal(fullVerdict.track, 'full');
      assert.ok(fullVerdict.total > 300);
      spawnSync('git', ['rm', '-q', '--cached', 'big.txt'], { cwd: dir, encoding: 'utf8' });
      rmSync(join(dir, 'big.txt'));

      // Specs-touch control: a one-line edit under specs/ forces full.
      const proposalPath = join(dir, 'specs', 'changes', CHANGE_ID, 'proposal.md');
      writeFileSync(proposalPath, `${readFileSync(proposalPath, 'utf8')}\nExtra line.\n`);
      const specVerdict = classifyDemo(dir);
      assert.equal(specVerdict.track, 'full');
      assert.ok(specVerdict.force_full.length > 0);
    } finally {
      if (!process.env.M4_KEEP_DEMO) rmSync(dir, { recursive: true, force: true });
    }
  });

  test('lite run skips the spec ritual and seals green; full run keeps it', async () => {
    const liteDir = buildDemoRepo();
    const fullDir = buildDemoRepo();
    try {
      // ── lite track ──────────────────────────────────────────────────
      // First run (pre-fix): proposal skipped, red seals, green stops.
      const liteA = await runDemoExpectStop({ dir: liteDir, lite: true, stopPhase: 'tdd-green' });
      const liteRedProof = readProof(liteDir, 'red-0.json');
      assert.equal(liteRedProof.passed, false, 'red proof must record the failing test');
      assert.equal(liteA.executor.runtime.atomResults['I6b.tdd.proof_validate']?.ok, true, 'red seal (I6b) must validate');

      applyFix(liteDir);
      // Second run (post-fix): resumes after tdd-red, seals green.
      const liteB = await runDemo({ dir: liteDir, lite: true });
      const liteGreenProof = readProof(liteDir, 'green-0.json');
      assert.equal(liteGreenProof.passed, true, 'green proof must record the passing test');
      assert.equal(liteB.executor.runtime.atomResults['I6b.tdd.proof_validate']?.ok, true, 'green seal (I6b) must validate');
      assert.equal(liteB.executor.runtime.atomResults['I6d.tdd.assertion_execution']?.ok, true, 'I6d gate must pass');
      assert.equal(liteB.executor.runtime.atomResults['J1.tests.run']?.ok, true, 'J1 full test run must pass');
      assert.equal(liteB.executor.runtime.atomResults['J6.cr.review']?.ok, true, 'J6 review must pass');
      assert.equal(liteB.executor.runtime.atomResults['I6c.tdd.quality_review']?.ok, true, 'I6c quality review must pass');

      const liteLog = readExecutionLog(liteDir);
      const liteAEvents = liteLog.filter((entry) => entry.workflow_run_id === liteA.executor.runtime.workflowRunId);
      const liteBEvents = liteLog.filter((entry) => entry.workflow_run_id === liteB.executor.runtime.workflowRunId);
      const skippedPhase = liteAEvents.find(
        (entry) => entry.kind === 'phase_skipped' && entry.phase_id === 'proposal-consistency-check',
      );
      assert.ok(skippedPhase, 'proposal-consistency-check must be logged phase_skipped in the lite first run');
      assert.equal(skippedPhase.reason, 'lite_track');
      for (const atomId of ['J4a.spec_consistency.structural', 'J4b.spec_delta.review']) {
        const skippedAtom = liteBEvents.find(
          (entry) => entry.kind === 'atom_skipped' && entry.atom_id === atomId,
        );
        assert.ok(skippedAtom, `${atomId} must be logged atom_skipped in the lite resume run`);
        assert.equal(skippedAtom.reason, 'lite_track');
      }
      const liteStarted = liteBEvents.find((entry) => entry.kind === 'workflow_started');
      assert.equal(liteStarted?.resume_from_phase, 'tdd-red', 'resume run must record resuming after tdd-red');
      const liteCompleted = liteBEvents.find((entry) => entry.kind === 'workflow_completed');
      assert.ok(liteCompleted, 'lite resume run must log workflow_completed');
      assert.equal(liteCompleted.lite_fast_track, true, 'workflow_completed must record lite mode');
      assert.ok(!liteBEvents.some((entry) => entry.kind === 'atom_skipped' && entry.atom_id === 'J1.tests.run'),
        'J1 must not be skipped in lite mode');
      assert.ok(!liteBEvents.some((entry) => entry.kind === 'atom_skipped' && entry.atom_id === 'J6.cr.review'),
        'J6 must not be skipped in lite mode');

      // ── full track (same flow, spec ritual kept) ────────────────────
      const fullA = await runDemoExpectStop({ dir: fullDir, lite: false, stopPhase: 'tdd-green' });
      assert.equal(fullA.executor.runtime.atomResults['J4a.spec_consistency.structural']?.ok, true, 'J4a must run and pass in full mode');
      assert.equal(fullA.executor.runtime.atomResults['J4d.spec_clarify.gate']?.ok, true, 'J4d gate must run and pass in full mode');
      const fullRedProof = readProof(fullDir, 'red-0.json');
      assert.equal(fullRedProof.passed, false, 'red proof must record the failing test in full mode');

      applyFix(fullDir);
      const fullB = await runDemo({ dir: fullDir, lite: false });
      const fullGreenProof = readProof(fullDir, 'green-0.json');
      assert.equal(fullGreenProof.passed, true, 'green proof must record the passing test in full mode');
      assert.equal(fullB.executor.runtime.atomResults['J4a.spec_consistency.structural']?.ok, true, 'J4a must run in full mode verify');
      assert.equal(fullB.executor.runtime.atomResults['J4b.spec_delta.review']?.ok, true, 'J4b must run in full mode verify');
      assert.equal(fullB.executor.runtime.atomResults['J6.cr.review']?.ok, true, 'J6 must run in full mode verify');

      const fullLog = readExecutionLog(fullDir);
      const fullEvents = fullLog.filter(
        (entry) => entry.workflow_run_id === fullA.executor.runtime.workflowRunId
          || entry.workflow_run_id === fullB.executor.runtime.workflowRunId,
      );
      assert.ok(!fullEvents.some((entry) => entry.reason === 'lite_track'),
        'full mode must not skip anything for lite_track');
      const fullCompleted = fullLog
        .filter((entry) => entry.workflow_run_id === fullB.executor.runtime.workflowRunId)
        .find((entry) => entry.kind === 'workflow_completed');
      assert.ok(fullCompleted, 'full resume run must log workflow_completed');
      assert.equal(fullCompleted.lite_fast_track, false, 'workflow_completed must record full mode');

      // ── wall clock (measured, never asserted; n=1 per track) ───────
      // Each total is first run (red + stopped green attempt) + resume run
      // (green + verify); the shapes are identical across tracks, so the
      // delta is the spec ritual the lite track skips.
      const liteTotal = liteA.ms + liteB.ms;
      const fullTotal = fullA.ms + fullB.ms;
      console.log(`[m4-slice2-wallclock] lite first ${liteA.ms}ms + resume ${liteB.ms}ms = ${liteTotal}ms; full first ${fullA.ms}ms + resume ${fullB.ms}ms = ${fullTotal}ms; lite/full = ${(liteTotal / fullTotal).toFixed(3)} (n=1 each, preliminary)`);
    } finally {
      if (!process.env.M4_KEEP_DEMO) {
        rmSync(liteDir, { recursive: true, force: true });
        rmSync(fullDir, { recursive: true, force: true });
      } else {
        console.log(`[m4-slice2-demo-kept] lite=${liteDir} full=${fullDir}`);
      }
    }
  });
});
