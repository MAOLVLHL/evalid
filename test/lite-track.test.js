import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { load } from '../src/core/workflow-loader.js';
import { WorkflowExecutor } from '../src/core/workflow-executor.js';

const repoRoot = resolve(import.meta.dirname, '..');
const modulePath = join(repoRoot, 'xflow', 'atoms', 'lite_track.py');
const python = process.env.PYTHON || 'python3';

// ─── classifier fixtures ────────────────────────────────────────────────────

function git(dir, ...args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'evalid-lite-'));
  git(dir, 'init', '-b', 'main', '-q');
  git(dir, 'config', 'user.email', 'lite@test');
  git(dir, 'config', 'user.name', 'lite-test');
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

function classify(dir, extraArgs = []) {
  const result = spawnSync(python, [modulePath, '--repo', dir, '--json', ...extraArgs], { encoding: 'utf8' });
  assert.equal(result.status, 0, `lite_track.py failed: ${result.stderr}${result.stdout}`);
  return JSON.parse(result.stdout);
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

describe('lite_track classifier (M4 slice 1)', () => {
  test('small diff classifies lite', () => {
    const dir = makeRepo();
    try {
      commitOnBranch(dir, { 'a.txt': 'line1\nline2\nline3\n', 'b.txt': 'new\n' });
      const verdict = classify(dir);
      assert.equal(verdict.track, 'lite');
      assert.equal(verdict.files, 2);
      assert.ok(verdict.total <= 300, `total ${verdict.total} should be within threshold`);
      assert.equal(verdict.max_files, 10);
      assert.equal(verdict.max_lines, 300);
      assert.ok(verdict.base, 'merge-base sha recorded');
    } finally {
      cleanup(dir);
    }
  });

  test('diff over the line budget classifies full', () => {
    const dir = makeRepo();
    try {
      const big = Array.from({ length: 400 }, (_, i) => `added line ${i}`).join('\n') + '\n';
      commitOnBranch(dir, { 'big.txt': big });
      const verdict = classify(dir);
      assert.equal(verdict.track, 'full');
      assert.ok(verdict.total > 300);
      assert.match(verdict.reason, /line/);
    } finally {
      cleanup(dir);
    }
  });

  test('diff over the file budget classifies full', () => {
    const dir = makeRepo();
    try {
      const files = {};
      for (let i = 0; i < 11; i++) files[`f${i}.txt`] = 'one\n';
      commitOnBranch(dir, files);
      const verdict = classify(dir);
      assert.equal(verdict.track, 'full');
      assert.equal(verdict.files, 11);
      assert.match(verdict.reason, /file/);
    } finally {
      cleanup(dir);
    }
  });

  test('small diff touching specs/ is forced full', () => {
    const dir = makeRepo();
    try {
      commitOnBranch(dir, { 'specs/changes/demo/proposal.md': '# proposal\n', 'a.txt': 'line1\nline2\n' });
      const verdict = classify(dir);
      assert.equal(verdict.track, 'full');
      assert.ok(verdict.force_full.length > 0);
      assert.match(verdict.reason, /specs\//);
    } finally {
      cleanup(dir);
    }
  });

  test('small diff touching workflows/ is forced full', () => {
    const dir = makeRepo();
    try {
      commitOnBranch(dir, { 'workflows/yolo.yaml': 'name: yolo\n', 'a.txt': 'line1\nline2\n' });
      const verdict = classify(dir);
      assert.equal(verdict.track, 'full');
      assert.match(verdict.reason, /workflows\//);
    } finally {
      cleanup(dir);
    }
  });

  test('empty diff classifies lite', () => {
    const dir = makeRepo();
    try {
      const verdict = classify(dir);
      assert.equal(verdict.track, 'lite');
      assert.equal(verdict.files, 0);
      assert.equal(verdict.total, 0);
    } finally {
      cleanup(dir);
    }
  });

  test('diff-text mode classifies a small PR diff as lite', () => {
    const dir = makeRepo();
    try {
      const diffText = [
        'diff --git a/a.txt b/a.txt',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1 +1,2 @@',
        ' line1',
        '+line2',
        'diff --git a/b.txt b/b.txt',
        '--- /dev/null',
        '+++ b/b.txt',
        '@@ -0,0 +1 @@',
        '+new',
        '',
      ].join('\n');
      const diffFile = join(dir, 'small.diff');
      writeFileSync(diffFile, diffText);
      const verdict = classify(dir, ['--diff-file', diffFile]);
      assert.equal(verdict.track, 'lite');
      assert.equal(verdict.files, 2);
      assert.equal(verdict.added, 2);
    } finally {
      cleanup(dir);
    }
  });

  test('threshold overrides are honoured', () => {
    const dir = makeRepo();
    try {
      const big = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\n';
      commitOnBranch(dir, { 'big.txt': big });
      const verdict = classify(dir, ['--max-lines', '10']);
      assert.equal(verdict.track, 'full');
      assert.equal(verdict.max_lines, 10);
    } finally {
      cleanup(dir);
    }
  });
});

// ─── yolo.yaml lite wiring ──────────────────────────────────────────────────

describe('yolo.yaml lite wiring (M4 slice 1)', () => {
  test('spec-ritual steps are marked lite_skip, verification spine is not', () => {
    const { phases } = load('workflows/yolo.yaml', { skipRuntimeChecks: true });
    const specPhase = phases.find((phase) => phase.id === 'proposal-consistency-check');
    assert.ok(specPhase, 'yolo.yaml missing proposal-consistency-check phase');
    assert.equal(specPhase.lite_skip, true, 'proposal-consistency-check must skip in lite mode');

    const verify = phases.find((phase) => phase.id === 'verify-consistency');
    assert.ok(verify, 'yolo.yaml missing verify-consistency phase');
    const atomById = new Map((verify.atoms || []).map((atomRef) => [atomRef.id, atomRef]));
    assert.equal(atomById.get('J4a.spec_consistency.structural')?.lite_skip, true, 'J4a must skip in lite mode');
    assert.equal(atomById.get('J4b.spec_delta.review')?.lite_skip, true, 'J4b must skip in lite mode');
    assert.equal(atomById.get('J1.tests.run')?.lite_skip, undefined, 'J1 full test run must stay in lite mode');
    assert.equal(atomById.get('J6.cr.review')?.lite_skip, undefined, 'J6 code review must stay in lite mode');

    const green = phases.find((phase) => phase.id === 'tdd-green');
    const greenIds = (green.atoms || []).map((atomRef) => atomRef.id);
    assert.ok(greenIds.includes('I6a.tdd.run'), 'lite keeps TDD run');
    assert.ok(greenIds.includes('I6b.tdd.proof_validate'), 'lite keeps proof seal');
    assert.ok(greenIds.includes('I6d.tdd.assertion_execution'), 'lite keeps assertion-execution gate');
  });
});

// ─── executor lite_skip behaviour ───────────────────────────────────────────

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

describe('WorkflowExecutor lite fast track (M4 slice 1)', () => {
  test('lite run skips spec atoms and phases, keeps seal and test atoms', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'evalid-lite-exec-'));
    try {
      const registry = writeMockAtoms(projectRoot);
      const { workflow, phases } = liteWorkflow();
      const executor = new WorkflowExecutor({
        workflow, phases, registry, projectRoot, changeId: 'chg-lite-e2e', input: { lite: true },
      });
      await executor.run();

      const ran = readMockEvents(projectRoot).map((event) => event.atom);
      assert.ok(!ran.includes('SPEC.atom.mock'), `spec atom must not run in lite mode, got ${ran.join(', ')}`);
      assert.ok(ran.includes('SEAL.atom.mock'), 'seal atom must run in lite mode');
      assert.ok(ran.includes('TEST.atom.mock'), 'test atom must run in lite mode');

      const log = readExecutionLog(projectRoot);
      const skippedPhase = log.find((entry) => entry.kind === 'phase_skipped' && entry.phase_id === 'spec-phase');
      assert.ok(skippedPhase, 'spec-phase should be logged phase_skipped');
      assert.equal(skippedPhase.reason, 'lite_track');
      const skippedAtom = log.find((entry) => entry.kind === 'atom_skipped' && entry.atom_id === 'SPEC.atom.mock');
      assert.ok(skippedAtom, 'spec atom in verify-phase should be logged atom_skipped');
      assert.equal(skippedAtom.reason, 'lite_track');
      const started = log.find((entry) => entry.kind === 'workflow_started');
      assert.equal(started.lite_fast_track, true, 'workflow_started must record lite mode');
      const completed = log.find((entry) => entry.kind === 'workflow_completed');
      assert.equal(completed.lite_fast_track, true, 'workflow_completed must record lite mode');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('full run executes spec atoms (no lite flag)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'evalid-lite-exec-'));
    try {
      const registry = writeMockAtoms(projectRoot);
      const { workflow, phases } = liteWorkflow();
      const executor = new WorkflowExecutor({
        workflow, phases, registry, projectRoot, changeId: 'chg-lite-e2e', input: {},
      });
      await executor.run();

      const ran = readMockEvents(projectRoot).map((event) => event.atom);
      assert.ok(ran.includes('SPEC.atom.mock'), `spec atom must run in full mode, got ${ran.join(', ')}`);
      assert.ok(ran.includes('SEAL.atom.mock'), 'seal atom must run in full mode');

      const log = readExecutionLog(projectRoot);
      assert.ok(!log.some((entry) => entry.kind === 'phase_skipped' && entry.reason === 'lite_track'),
        'full mode must not skip anything for lite_track');
      const started = log.find((entry) => entry.kind === 'workflow_started');
      assert.equal(started.lite_fast_track, false, 'workflow_started must record full mode');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── --uncommitted regression (M4 slice 2, evalid #97) ──────────────────────

describe('lite_track --uncommitted counting (M4 slice 2)', () => {
  test('worktree that partially reverts committed lines counts the true diff', () => {
    const dir = makeRepo();
    try {
      // Base file: 10 lines. The branch commits 10 added lines; the
      // worktree then cuts 5 of them back. The true worktree-vs-base diff
      // is 5 added, 0 removed — the pre-fix max() merge reported 15.
      const ten = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
      writeFileSync(join(dir, 'a.txt'), ten);
      git(dir, 'add', '.');
      git(dir, 'commit', '-qm', 'ten lines');
      git(dir, 'checkout', '-qb', 'feature');
      const twenty = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
      writeFileSync(join(dir, 'a.txt'), twenty);
      git(dir, 'add', '.');
      git(dir, 'commit', '-qm', 'add 10 lines');
      const kept = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
      writeFileSync(join(dir, 'a.txt'), kept);
      const verdict = classify(dir, ['--uncommitted']);
      assert.equal(verdict.track, 'lite');
      assert.equal(verdict.files, 1);
      assert.equal(verdict.added, 5);
      assert.equal(verdict.removed, 0);
      assert.equal(verdict.total, 5);
    } finally {
      cleanup(dir);
    }
  });
});
