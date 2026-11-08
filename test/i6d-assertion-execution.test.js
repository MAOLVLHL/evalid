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

describe('i6d assertion execution gate (M3 slice 2: diff scoping)', () => {
  const BASELINE_MIXED = [
    'def test_legacy_dead():',
    '    def on_done(value):',
    '        assert value == 42',
    '    assert True',
    '',
    'def test_legacy_ok():',
    '    assert 1 + 1 == 2',
    '',
  ].join('\n');

  // Appended on the feature branch: one never-executed assert inside the
  // diff (line 11), one executed assert inside the diff (line 15).
  const FEATURE_MIXED_APPEND = [
    '',
    'def test_new_dead():',
    '    def on_done(value):',
    '        assert value == 99',
    '    assert True',
    '',
    'def test_new_ok():',
    '    assert 2 + 2 == 4',
    '',
  ].join('\n');

  const FEATURE_GREEN_APPEND = [
    '',
    'def test_new_ok():',
    '    assert 2 + 2 == 4',
    '',
  ].join('\n');

  function gitAvailable() {
    return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
  }

  function gitCmd(dir, args) {
    const result = spawnSync('git', [
      '-c', 'user.name=evalid-test',
      '-c', 'user.email=test@example.com',
      ...args,
    ], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stdout}${result.stderr}`);
    return result.stdout.trim();
  }

  // Baseline committed on main; optionally a feature branch appending to
  // test_mixed.py. Returns the repo dir (also the pytest root).
  function writeGitRepo(featureAppend) {
    const dir = writeFixture({ 'test_mixed.py': BASELINE_MIXED });
    gitCmd(dir, ['init', '-b', 'main']);
    gitCmd(dir, ['add', '.']);
    gitCmd(dir, ['commit', '-m', 'baseline']);
    if (featureAppend !== null) {
      gitCmd(dir, ['checkout', '-b', 'feature']);
      writeFileSync(join(dir, 'test_mixed.py'), BASELINE_MIXED + featureAppend);
      gitCmd(dir, ['add', '.']);
      gitCmd(dir, ['commit', '-m', 'feature']);
    }
    return dir;
  }

  function runScopedGate(fixtureDir, base = 'main') {
    const evidencePath = join(fixtureDir, 'evidence.json');
    const result = spawnSync(python, [
      modulePath,
      '--root', fixtureDir,
      '--output', evidencePath,
      '--pytest-python', ensurePytestPython() || python,
      '--only-changed', '--diff-base', base,
    ], { encoding: 'utf8' });
    const evidence = existsSync(evidencePath)
      ? JSON.parse(readFileSync(evidencePath, 'utf8'))
      : null;
    return { result, evidence };
  }

  const skipNoGit = () => !gitAvailable() && 'git unavailable';

  test('changed_lines reports only the appended lines vs merge-base', { skip: skipNoGit() }, () => {
    const dir = writeGitRepo(FEATURE_MIXED_APPEND);
    try {
      const probe = spawnSync(python, ['-c', [
        'import json, sys',
        'sys.path.insert(0, "xflow/atoms")',
        'from i6d_assertion_execution import changed_lines, resolve_diff_base',
        `base = resolve_diff_base(${JSON.stringify(dir)}, "main")`,
        `mb, changed = changed_lines(${JSON.stringify(dir)}, "main")`,
        'print(json.dumps({"base": base, "mb": mb, "changed": {k: sorted(v) for k, v in changed.items()}}))',
      ].join('; ')], { cwd: repoRoot, encoding: 'utf8' });
      assert.equal(probe.status, 0, probe.stderr);
      const out = JSON.parse(probe.stdout);
      assert.equal(out.base, out.mb);
      assert.match(out.mb, /^[0-9a-f]{40}$/);
      const files = Object.keys(out.changed);
      assert.equal(files.length, 1);
      assert.match(files[0], /test_mixed\.py$/);
      assert.deepEqual(out.changed[files[0]], [8, 9, 10, 11, 12, 13, 14, 15]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('mixed fixture: only the in-diff unexecuted assert is red', { skip: (!gitAvailable() || ensurePytestPython() === null) && 'git or pytest unavailable' }, () => {
    const dir = writeGitRepo(FEATURE_MIXED_APPEND);
    try {
      const { result, evidence } = runScopedGate(dir);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(evidence, 'evidence.json missing');
      assert.equal(evidence.verdict, 'unexecuted_assertions');
      assert.equal(evidence.total, 6);
      assert.equal(evidence.executed, 2);
      assert.equal(evidence.inScope, 3);
      assert.equal(evidence.unexecuted.length, 1);
      assert.equal(evidence.unexecuted[0].line, 11);
      assert.match(evidence.unexecuted[0].source, /assert value == 99/);
      assert.equal(evidence.outOfScope.length, 3);
      assert.ok(evidence.outOfScope.some((a) => a.line === 3 && /assert value == 42/.test(a.source)),
        'legacy unexecuted assert must be out of scope, not red');
      assert.match(evidence.diffBase, /^[0-9a-f]{40}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('diff adds only executed asserts: verdict pass, legacy dead assert out of scope', { skip: (!gitAvailable() || ensurePytestPython() === null) && 'git or pytest unavailable' }, () => {
    const dir = writeGitRepo(FEATURE_GREEN_APPEND);
    try {
      const { result, evidence } = runScopedGate(dir);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(evidence, 'evidence.json missing');
      assert.equal(evidence.verdict, 'pass');
      assert.equal(evidence.total, 4);
      assert.equal(evidence.executed, 1);
      assert.deepEqual(evidence.unexecuted, []);
      assert.equal(evidence.outOfScope.length, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('empty diff: verdict pass, everything out of scope, exit 0', { skip: (!gitAvailable() || ensurePytestPython() === null) && 'git or pytest unavailable' }, () => {
    const dir = writeGitRepo(null);
    try {
      const { result, evidence } = runScopedGate(dir);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(evidence, 'evidence.json missing');
      assert.equal(evidence.verdict, 'pass');
      assert.equal(evidence.total, 3);
      assert.equal(evidence.executed, 0);
      assert.deepEqual(evidence.unexecuted, []);
      assert.equal(evidence.outOfScope.length, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
