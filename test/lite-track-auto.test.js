/**
 * M4 slice 3 auto-lite (evalid #101, parent #97).
 *
 * `xflow workflow run` with no explicit flag runs the slice-1 classifier
 * first and picks the track itself: small diff -> lite, big diff -> full.
 * Explicit `--lite` / `--full` always wins; a classifier failure falls
 * back to full and is recorded, never silently lite. The decision rides
 * in the workflow events as `lite_track_decision`, alongside slice 1's
 * `lite_fast_track` field.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { WorkflowExecutor } from '../src/core/workflow-executor.js';
import { decideLiteTrack, resolveLiteTrackAuto } from '../src/core/lite-track-auto.js';

const repoRoot = resolve(import.meta.dirname, '..');

// ─── git fixture helpers (same shape as test/lite-track.test.js) ─────────────

function git(dir, ...args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'evalid-autolite-'));
  git(dir, 'init', '-b', 'main', '-q');
  git(dir, 'config', 'user.email', 'autolite@test');
  git(dir, 'config', 'user.name', 'autolite-test');
  writeFileSync(join(dir, 'a.txt'), 'line1\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  return dir;
}

function commitOnBranch(dir, files) {
  git(dir, 'checkout', '-qb', 'feature');
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(dir, name.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
    writeFileSync(path, content);
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'feature work');
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// ─── resolver ───────────────────────────────────────────────────────────────

describe('resolveLiteTrackAuto (M4 slice 3)', () => {
  test('small diff auto-selects lite', () => {
    const dir = makeRepo();
    try {
      commitOnBranch(dir, { 'a.txt': 'line1\nline2\nline3\n', 'b.txt': 'new\n' });
      const decision = resolveLiteTrackAuto({ projectRoot: dir });
      assert.equal(decision.source, 'auto');
      assert.equal(decision.track, 'lite');
      assert.equal(decision.files, 2);
      assert.ok(decision.total <= 300, `total ${decision.total} should be within threshold`);
      assert.ok(decision.base, 'merge-base sha recorded');
      assert.match(decision.reason, /within thresholds/);
    } finally {
      cleanup(dir);
    }
  });

  test('big diff auto-selects full', () => {
    const dir = makeRepo();
    try {
      const big = Array.from({ length: 400 }, (_, i) => `added line ${i}`).join('\n') + '\n';
      commitOnBranch(dir, { 'big.txt': big });
      const decision = resolveLiteTrackAuto({ projectRoot: dir });
      assert.equal(decision.source, 'auto');
      assert.equal(decision.track, 'full');
      assert.ok(decision.total > 300);
      assert.match(decision.reason, /line/);
    } finally {
      cleanup(dir);
    }
  });

  test('small diff touching specs/ auto-selects full', () => {
    const dir = makeRepo();
    try {
      commitOnBranch(dir, { 'specs/changes/demo/proposal.md': '# proposal\n', 'a.txt': 'line1\nline2\n' });
      const decision = resolveLiteTrackAuto({ projectRoot: dir });
      assert.equal(decision.source, 'auto');
      assert.equal(decision.track, 'full');
      assert.ok(decision.force_full.length > 0);
      assert.match(decision.reason, /specs\//);
    } finally {
      cleanup(dir);
    }
  });

  test('uncommitted edits count toward the verdict', () => {
    const dir = makeRepo();
    try {
      // No branch, no commits beyond base: the worktree edit alone must be
      // measured (slice 2 --uncommitted semantics), not read as empty diff.
      writeFileSync(join(dir, 'a.txt'), 'line1\nline2\nline3\n');
      const decision = resolveLiteTrackAuto({ projectRoot: dir });
      assert.equal(decision.source, 'auto');
      assert.equal(decision.track, 'lite');
      assert.equal(decision.files, 1);
      assert.equal(decision.total, 2);
    } finally {
      cleanup(dir);
    }
  });

  test('classifier failure falls back to full, never lite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evalid-autolite-nogit-'));
    try {
      const decision = resolveLiteTrackAuto({ projectRoot: dir });
      assert.equal(decision.source, 'auto-fallback-full');
      assert.equal(decision.track, 'full');
      assert.match(decision.reason, /classifier failed/);
      assert.match(decision.reason, /falling back to full/);
    } finally {
      cleanup(dir);
    }
  });

  test('missing classifier falls back to full', () => {
    const dir = makeRepo();
    try {
      const decision = resolveLiteTrackAuto({
        projectRoot: dir,
        classifierPath: join(dir, 'no-such-lite_track.py'),
      });
      assert.equal(decision.source, 'auto-fallback-full');
      assert.equal(decision.track, 'full');
    } finally {
      cleanup(dir);
    }
  });
});

// ─── flag priority ──────────────────────────────────────────────────────────

describe('decideLiteTrack flag priority (M4 slice 3)', () => {
  const autoLite = { source: 'auto', track: 'lite', reason: 'within thresholds (1 files, 2 lines <= 10 files, 300 lines)', files: 1, added: 2, removed: 0, total: 2, base: 'abc', force_full: [] };
  const autoFull = { source: 'auto', track: 'full', reason: 'exceeds line budget: 400 lines > 300 max_lines', files: 1, added: 400, removed: 0, total: 400, base: 'abc', force_full: [] };

  test('explicit --lite beats a full auto verdict', () => {
    const { lite, decision } = decideLiteTrack({ lite: true, full: false, autoDecision: autoFull });
    assert.equal(lite, true);
    assert.equal(decision.source, 'explicit-lite');
    assert.equal(decision.track, 'lite');
  });

  test('explicit --full beats a lite auto verdict', () => {
    const { lite, decision } = decideLiteTrack({ lite: false, full: true, autoDecision: autoLite });
    assert.equal(lite, false);
    assert.equal(decision.source, 'explicit-full');
    assert.equal(decision.track, 'full');
  });

  test('both flags resolve to full (conservative)', () => {
    const { lite, decision } = decideLiteTrack({ lite: true, full: true, autoDecision: autoLite });
    assert.equal(lite, false);
    assert.equal(decision.source, 'explicit-full');
    assert.equal(decision.track, 'full');
    assert.match(decision.reason, /--full wins/);
  });

  test('no flag passes the auto verdict through', () => {
    const liteCase = decideLiteTrack({ lite: false, full: false, autoDecision: autoLite });
    assert.equal(liteCase.lite, true);
    assert.equal(liteCase.decision, autoLite);
    const fullCase = decideLiteTrack({ lite: false, full: false, autoDecision: autoFull });
    assert.equal(fullCase.lite, false);
    assert.equal(fullCase.decision, autoFull);
  });

  test('no flag and no auto verdict falls back to full', () => {
    const { lite, decision } = decideLiteTrack({ lite: false, full: false, autoDecision: null });
    assert.equal(lite, false);
    assert.equal(decision.source, 'auto-fallback-full');
    assert.equal(decision.track, 'full');
  });
});

// ─── executor event recording ───────────────────────────────────────────────

function writeMockAtoms(projectRoot) {
  const mockDir = resolve(projectRoot, 'mock-atoms');
  mkdirSync(mockDir, { recursive: true });
  writeFileSync(resolve(mockDir, 'mock-common.mjs'), `
    import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    import { dirname, resolve } from 'node:path';
    export function appendEvent(context, atom, input = {}) {
      const eventPath = resolve(context.projectRoot, '.as-xflow', 'mock-events.json');
      mkdirSync(dirname(eventPath), { recursive: true });
      const events = existsSync(eventPath) ? JSON.parse(readFileSync(eventPath, 'utf8')) : [];
      events.push({ atom, input, change_id: context.changeId, index: events.length });
      writeFileSync(eventPath, JSON.stringify(events, null, 2));
      return { ok: true, status: 'completed', event_index: events.length - 1 };
    }
  `, 'utf8');
  for (const [atomId, file] of [
    ['SPEC.atom.mock', 'SPEC-atom-mock.mjs'],
    ['SEAL.atom.mock', 'SEAL-atom-mock.mjs'],
    ['TEST.atom.mock', 'TEST-atom-mock.mjs'],
  ]) {
    writeFileSync(resolve(mockDir, file), `
      import { appendEvent } from './mock-common.mjs';
      export default async function run(input = {}, context = {}) {
        return appendEvent(context, '${atomId}', input);
      }
    `, 'utf8');
  }
  const registry = { atoms: {} };
  for (const [atomId, file] of [
    ['SPEC.atom.mock', 'SPEC-atom-mock.mjs'],
    ['SEAL.atom.mock', 'SEAL-atom-mock.mjs'],
    ['TEST.atom.mock', 'TEST-atom-mock.mjs'],
  ]) {
    registry.atoms[atomId] = { track: 'lite', type: 'js', module: resolve(mockDir, file) };
  }
  return registry;
}

function liteWorkflow() {
  return {
    workflow: { name: 'lite-e2e-test', track: 'lite', requires: { agentos_http: false, gh: false, pencil: false } },
    phases: [
      {
        id: 'spec-phase', label: 'spec ritual (skipped in lite)', required: true,
        lite_skip: true,
        atoms: [{ id: 'SPEC.atom.mock' }],
        gate: { type: 'skip' },
      },
      {
        id: 'seal-phase', label: 'seal', required: true,
        atoms: [{ id: 'SEAL.atom.mock' }],
        gate: { type: 'skip' },
      },
      {
        id: 'verify-phase', label: 'verify', required: true,
        atoms: [{ id: 'TEST.atom.mock' }, { id: 'SPEC.atom.mock', lite_skip: true }],
        gate: { type: 'deterministic', atom: 'SPEC.atom.mock', on_fail: 'stop' },
      },
    ],
  };
}

function readExecutionLog(projectRoot) {
  const logPath = resolve(projectRoot, '.as-xflow', 'logs', 'execution.ndjson');
  assert.ok(existsSync(logPath), 'execution log should exist');
  return readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function readMockEvents(projectRoot) {
  const eventPath = resolve(projectRoot, '.as-xflow', 'mock-events.json');
  return existsSync(eventPath) ? JSON.parse(readFileSync(eventPath, 'utf8')) : [];
}

describe('WorkflowExecutor records the auto decision (M4 slice 3)', () => {
  test('auto-lite run skips spec atoms and records the decision in both events', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'evalid-autolite-exec-'));
    try {
      const registry = writeMockAtoms(projectRoot);
      const { workflow, phases } = liteWorkflow();
      const decision = { source: 'auto', track: 'lite', reason: 'within thresholds (1 files, 2 lines <= 10 files, 300 lines)', files: 1, added: 2, removed: 0, total: 2, base: 'abc123', force_full: [] };
      const executor = new WorkflowExecutor({
        workflow, phases, registry, projectRoot, changeId: 'chg-autolite-e2e',
        input: { lite: true, lite_track_decision: decision },
      });
      await executor.run();

      const ran = readMockEvents(projectRoot).map((event) => event.atom);
      assert.ok(!ran.includes('SPEC.atom.mock'), `spec atom must not run in auto-lite mode, got ${ran.join(', ')}`);
      assert.ok(ran.includes('SEAL.atom.mock'), 'seal atom must run in auto-lite mode');
      assert.ok(ran.includes('TEST.atom.mock'), 'test atom must run in auto-lite mode');

      const log = readExecutionLog(projectRoot);
      for (const kind of ['workflow_started', 'workflow_completed']) {
        const entry = log.find((e) => e.kind === kind);
        assert.ok(entry, `${kind} event must exist`);
        assert.equal(entry.lite_fast_track, true, `${kind} must record lite mode`);
        assert.deepEqual(entry.lite_track_decision, decision, `${kind} must record the auto decision`);
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('auto-full run executes spec atoms and records the decision', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'evalid-autolite-exec-'));
    try {
      const registry = writeMockAtoms(projectRoot);
      const { workflow, phases } = liteWorkflow();
      const decision = { source: 'auto', track: 'full', reason: 'exceeds line budget: 400 lines > 300 max_lines', files: 1, added: 400, removed: 0, total: 400, base: 'abc123', force_full: [] };
      const executor = new WorkflowExecutor({
        workflow, phases, registry, projectRoot, changeId: 'chg-autolite-e2e',
        input: { lite_track_decision: decision },
      });
      await executor.run();

      const ran = readMockEvents(projectRoot).map((event) => event.atom);
      assert.ok(ran.includes('SPEC.atom.mock'), `spec atom must run in auto-full mode, got ${ran.join(', ')}`);
      assert.ok(ran.includes('SEAL.atom.mock'), 'seal atom must run in auto-full mode');

      const log = readExecutionLog(projectRoot);
      const started = log.find((entry) => entry.kind === 'workflow_started');
      assert.equal(started.lite_fast_track, false, 'workflow_started must record full mode');
      assert.deepEqual(started.lite_track_decision, decision, 'workflow_started must record the auto-full decision');
      assert.ok(!log.some((entry) => entry.kind === 'phase_skipped' && entry.reason === 'lite_track'),
        'auto-full mode must not skip anything for lite_track');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('classifier-fallback run stays full and records the failure', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'evalid-autolite-exec-'));
    try {
      const registry = writeMockAtoms(projectRoot);
      const { workflow, phases } = liteWorkflow();
      const decision = { source: 'auto-fallback-full', track: 'full', reason: 'classifier failed (git merge-base failed); falling back to full track', files: null, added: null, removed: null, total: null, base: null, force_full: [] };
      const executor = new WorkflowExecutor({
        workflow, phases, registry, projectRoot, changeId: 'chg-autolite-e2e',
        input: { lite_track_decision: decision },
      });
      await executor.run();

      const ran = readMockEvents(projectRoot).map((event) => event.atom);
      assert.ok(ran.includes('SPEC.atom.mock'), 'fallback run must execute spec atoms (full track)');
      const log = readExecutionLog(projectRoot);
      const started = log.find((entry) => entry.kind === 'workflow_started');
      assert.equal(started.lite_fast_track, false);
      assert.equal(started.lite_track_decision.source, 'auto-fallback-full');
      assert.match(started.lite_track_decision.reason, /classifier failed/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── CLI wiring ─────────────────────────────────────────────────────────────

const CLI_WORKFLOW_YAML = `
name: cli-auto-lite
version: 1
track: lite
requires:
  agentos_http: false
  gh: false
  pencil: false
phases:
  - id: change-init
    label: "Change init"
    catalog_ref: 1
    required: true
    atoms:
      - id: B1.change.scaffold
        with: { change_type: "backend", title: "auto lite smoke" }
      - id: B2b.status.write
        with:
          fields:
            current_stage: "change-init"
            status: "draft"
    gate:
      type: skip
`;

function runCliDryRun(projectRoot, workflowPath, extraArgs = []) {
  return spawnSync('node', [
    'bin/xflow.js', 'workflow', 'run', workflowPath,
    '--project-root', projectRoot,
    '--change-id', 'chg-auto-test',
    '--dry-run', ...extraArgs,
  ], { cwd: repoRoot, encoding: 'utf8' });
}

describe('CLI wiring: workflow run prints the auto decision (M4 slice 3)', () => {
  test('small diff prints auto -> lite', () => {
    const dir = makeRepo();
    try {
      commitOnBranch(dir, { 'a.txt': 'line1\nline2\n' });
      const workflowPath = join(dir, 'cli-workflow.yaml');
      writeFileSync(workflowPath, CLI_WORKFLOW_YAML);
      const result = runCliDryRun(dir, workflowPath);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Lite fast track: auto → lite/);
    } finally {
      cleanup(dir);
    }
  });

  test('big diff prints auto -> full', () => {
    const dir = makeRepo();
    try {
      const big = Array.from({ length: 400 }, (_, i) => `added line ${i}`).join('\n') + '\n';
      commitOnBranch(dir, { 'big.txt': big });
      const workflowPath = join(dir, 'cli-workflow.yaml');
      writeFileSync(workflowPath, CLI_WORKFLOW_YAML);
      const result = runCliDryRun(dir, workflowPath);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Lite fast track: auto → full/);
    } finally {
      cleanup(dir);
    }
  });

  test('explicit --full overrides a lite auto verdict', () => {
    const dir = makeRepo();
    try {
      commitOnBranch(dir, { 'a.txt': 'line1\nline2\n' });
      const workflowPath = join(dir, 'cli-workflow.yaml');
      writeFileSync(workflowPath, CLI_WORKFLOW_YAML);
      const result = runCliDryRun(dir, workflowPath, ['--full']);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Lite fast track: explicit-full → full/);
      assert.doesNotMatch(result.stdout, /Lite fast track: auto/);
    } finally {
      cleanup(dir);
    }
  });

  test('explicit --lite overrides a full auto verdict', () => {
    const dir = makeRepo();
    try {
      const big = Array.from({ length: 400 }, (_, i) => `added line ${i}`).join('\n') + '\n';
      commitOnBranch(dir, { 'big.txt': big });
      const workflowPath = join(dir, 'cli-workflow.yaml');
      writeFileSync(workflowPath, CLI_WORKFLOW_YAML);
      const result = runCliDryRun(dir, workflowPath, ['--lite']);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Lite fast track: explicit-lite → lite/);
      assert.doesNotMatch(result.stdout, /Lite fast track: auto/);
    } finally {
      cleanup(dir);
    }
  });

  test('non-git project root prints auto-fallback-full -> full', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evalid-autolite-nogit-'));
    try {
      const workflowPath = join(dir, 'cli-workflow.yaml');
      writeFileSync(workflowPath, CLI_WORKFLOW_YAML);
      const result = runCliDryRun(dir, workflowPath);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Lite fast track: auto-fallback-full → full/);
    } finally {
      cleanup(dir);
    }
  });
});
