import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
const modulePath = join(repoRoot, 'xflow', 'atoms', 'i6d_assertion_execution.py');
const python = process.env.PYTHON || 'python3';

// The live pytest runs need a python with pytest importable. Prefer the
// ambient interpreter; otherwise build a throwaway venv in tmpdir (hermetic,
// deleted with the fixture). If neither works, the live tests skip instead
// of failing on an environment gap.
let pytestPython = null;
function ensurePytestPython() {
  if (pytestPython !== null) return pytestPython;
  const check = spawnSync(python, ['-c', 'import pytest'], { encoding: 'utf8' });
  if (check.status === 0) {
    pytestPython = python;
    return pytestPython;
  }
  const venvDir = mkdtempSync(join(tmpdir(), 'evalid-i6d-venv-'));
  const venv = spawnSync(python, ['-m', 'venv', venvDir], { encoding: 'utf8' });
  if (venv.status !== 0) {
    rmSync(venvDir, { recursive: true, force: true });
    return null;
  }
  const venvPython = join(venvDir, 'bin', 'python');
  const install = spawnSync(venvPython, ['-m', 'pip', 'install', '--quiet', 'pytest'], { encoding: 'utf8' });
  if (install.status !== 0) {
    rmSync(venvDir, { recursive: true, force: true });
    return null;
  }
  pytestPython = venvPython;
  return pytestPython;
}

function writeFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'evalid-i6d-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(dir, name.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

function runGate(fixtureDir, pytestArgs = []) {
  const evidencePath = join(fixtureDir, 'evidence.json');
  const result = spawnSync(python, [
    modulePath,
    '--root', fixtureDir,
    '--output', evidencePath,
    '--pytest-python', ensurePytestPython() || python,
    '--', ...pytestArgs,
  ], { encoding: 'utf8' });
  const evidence = existsSync(evidencePath)
    ? JSON.parse(readFileSync(evidencePath, 'utf8'))
    : null;
  return { result, evidence, evidencePath };
}

const GREEN_FIXTURE = {
  'test_calc.py': [
    'def add(a, b):',
    '    return a + b',
    '',
    '',
    'def test_add():',
    '    assert add(1, 2) == 3',
    '    assert add(-1, 1) == 0',
    '',
    '',
    'def test_add_multiline():',
    '    assert add(',
    '        2,',
    '        3,',
    '    ) == 5',
    '',
  ].join('\n'),
};

const DEAD_CALLBACK_FIXTURE = {
  'test_callback.py': [
    'def test_callback_never_runs():',
    '    def on_done(value):',
    '        assert value == 42',
    '    # on_done is defined but never called: its assert never executes.',
    '    assert True',
    '',
    '',
    'def test_normal():',
    '    assert 1 + 1 == 2',
    '',
  ].join('\n'),
};

const SKIPPED_FIXTURE = {
  'test_skipped.py': [
    'import pytest',
    '',
    '',
    '@pytest.mark.skip(reason="not ready yet")',
    'def test_skipped():',
    '    assert 1 == 2',
    '',
    '',
    'def test_runs():',
    '    assert 1 == 1',
    '',
  ].join('\n'),
};

describe('i6d assertion execution gate (M3 slice 1)', () => {
  test('module exists and exposes collect_assertions', () => {
    assert.ok(existsSync(modulePath), `missing ${modulePath}`);
    const probe = spawnSync(python, ['-c', [
      'import sys',
      'sys.path.insert(0, "xflow/atoms")',
      'from i6d_assertion_execution import collect_assertions',
      'print(callable(collect_assertions))',
    ].join('; ')], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.match(probe.stdout, /True/);
  });

  test('collect_assertions finds asserts with file, line and enclosing test', () => {
    const dir = writeFixture(GREEN_FIXTURE);
    try {
      const probe = spawnSync(python, ['-c', [
        'import json, sys',
        'sys.path.insert(0, "xflow/atoms")',
        'from i6d_assertion_execution import collect_assertions',
        `asserts = collect_assertions(${JSON.stringify(join(dir, 'test_calc.py'))})`,
        'print(json.dumps(asserts))',
      ].join('; ')], { cwd: repoRoot, encoding: 'utf8' });
      assert.equal(probe.status, 0, probe.stderr);
      const asserts = JSON.parse(probe.stdout);
      assert.equal(asserts.length, 3);
      assert.deepEqual(
        asserts.map((a) => [a.line, a.test]),
        [[6, 'test_add'], [7, 'test_add'], [11, 'test_add_multiline']],
      );
      assert.match(asserts[0].source, /assert add\(1, 2\) == 3/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('all asserts executed: verdict pass, exit 0', { skip: ensurePytestPython() === null && 'pytest unavailable and venv install failed' }, () => {
    const dir = writeFixture(GREEN_FIXTURE);
    try {
      const { result, evidence } = runGate(dir);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(evidence, 'evidence.json missing');
      assert.equal(evidence.verdict, 'pass');
      assert.equal(evidence.total, 3);
      assert.equal(evidence.executed, 3);
      assert.deepEqual(evidence.unexecuted, []);
      assert.equal(evidence.pytestExit, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('assert in a never-called callback: verdict unexecuted_assertions, exit 1, line named', { skip: ensurePytestPython() === null && 'pytest unavailable and venv install failed' }, () => {
    const dir = writeFixture(DEAD_CALLBACK_FIXTURE);
    try {
      const { result, evidence } = runGate(dir);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(evidence, 'evidence.json missing');
      assert.equal(evidence.verdict, 'unexecuted_assertions');
      assert.equal(evidence.total, 3);
      assert.equal(evidence.executed, 2);
      assert.equal(evidence.unexecuted.length, 1);
      const [flagged] = evidence.unexecuted;
      assert.match(flagged.file, /test_callback\.py$/);
      assert.equal(flagged.line, 3);
      assert.equal(flagged.test, 'test_callback_never_runs');
      assert.match(flagged.source, /assert value == 42/);
      assert.match(result.stdout, /unexecuted_assertions/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skipped test asserts are reported skipped, not red', { skip: ensurePytestPython() === null && 'pytest unavailable and venv install failed' }, () => {
    const dir = writeFixture(SKIPPED_FIXTURE);
    try {
      const { result, evidence } = runGate(dir);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(evidence, 'evidence.json missing');
      assert.equal(evidence.verdict, 'pass');
      assert.equal(evidence.total, 2);
      assert.equal(evidence.executed, 1);
      assert.deepEqual(evidence.unexecuted, []);
      assert.equal(evidence.skipped.length, 1);
      assert.equal(evidence.skipped[0].test, 'test_skipped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
