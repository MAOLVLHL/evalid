import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
const pyModulePath = join(repoRoot, 'xflow', 'atoms', 'i6d_assertion_execution.py');
const jsModulePath = join(repoRoot, 'xflow', 'atoms', 'i6d_assertion_execution_js.js');
const python = process.env.PYTHON || 'python3';

// M3 slice 2 (#122): real-case evidence for the I6d assertion-execution
// gate. The three cases below are *constructed minimal reproductions*
// run through the real gate CLIs -- they are not historical bugs found
// in this repo (no dead-callback assert or wrong expectation was found
// in the repo's own tests when slice 2 was written; the scan is recorded
// in docs/i6d-m3-slice2-cases.md). Each case is a
// before/after pair: RED first (the test suite itself passes green while
// the gate flags the unexecuted assert by file:line), then the fix and
// GREEN. Case 2 has a middle step: wiring the callback exposes the
// plausible-but-wrong expectation as a plain pytest failure before the
// expectation itself is corrected.
//
// Live pytest runs need a python with pytest importable: ambient
// interpreter, else a throwaway venv in tmpdir (hermetic, deleted with
// the fixture). If neither works, the pytest cases skip instead of
// failing on an environment gap.
let pytestPython = null;
let pytestVenvDir = null;
process.on('exit', () => {
  if (pytestVenvDir) rmSync(pytestVenvDir, { recursive: true, force: true });
});
function ensurePytestPython() {
  if (pytestPython !== null) return pytestPython;
  const check = spawnSync(python, ['-c', 'import pytest'], { encoding: 'utf8' });
  if (check.status === 0) {
    pytestPython = python;
    return pytestPython;
  }
  const venvDir = mkdtempSync(join(tmpdir(), 'evalid-i6d-s2-venv-'));
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
  pytestVenvDir = venvDir;
  pytestPython = venvPython;
  return pytestPython;
}

function writeFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'evalid-i6d-s2-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(dir, name.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

function runPyGate(fixtureDir, pytestArgs = []) {
  const evidencePath = join(fixtureDir, 'evidence.json');
  const result = spawnSync(python, [
    pyModulePath,
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

function runJsGate(fixtureDir, extraArgs = []) {
  const evidencePath = join(fixtureDir, 'evidence.json');
  const result = spawnSync(process.execPath, [
    jsModulePath,
    '--root', fixtureDir,
    '--output', evidencePath,
    ...extraArgs,
  ], { encoding: 'utf8' });
  const evidence = existsSync(evidencePath)
    ? JSON.parse(readFileSync(evidencePath, 'utf8'))
    : null;
  return { result, evidence, evidencePath };
}

// --- Case 1: pytest, assert in a callback that is never called ---------
// The test suite passes (2 passed) while the gate flags the dead assert.
const CASE1_RED = {
  'test_case1.py': [
    'def test_process_never_calls_back():',
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

const CASE1_GREEN = {
  'test_case1.py': [
    'def test_process_never_calls_back():',
    '    def on_done(value):',
    '        assert value == 42',
    '    on_done(42)',
    '    assert True',
    '',
    '',
    'def test_normal():',
    '    assert 1 + 1 == 2',
    '',
  ].join('\n'),
};

// --- Case 2: pytest, dead callback hiding a plausible-but-wrong ---------
// expectation. round(2.675, 2) is 2.67 in CPython (2.675 is stored
// slightly below its decimal value), so 2.68 looks right and is wrong.
// RED: the test passes while the gate flags the assert. MIDDLE: wiring
// the callback exposes the wrong expectation as a pytest failure.
// GREEN: the expectation is corrected to the real value 2.67.
const CASE2_RED = {
  'test_case2.py': [
    'def test_rounding_never_checked():',
    '    def on_done():',
    '        assert round(2.675, 2) == 2.68',
    '    # on_done is defined but never called: the plausible-but-wrong',
    '    # expectation (2.68) is never exposed; the test passes green.',
    '',
  ].join('\n'),
};

const CASE2_MIDDLE = {
  'test_case2.py': [
    'def test_rounding_never_checked():',
    '    def on_done():',
    '        assert round(2.675, 2) == 2.68',
    '    on_done()',
    '',
  ].join('\n'),
};

const CASE2_GREEN = {
  'test_case2.py': [
    'def test_rounding_never_checked():',
    '    def on_done():',
    '        assert round(2.675, 2) == 2.67',
    '    on_done()',
    '',
  ].join('\n'),
};

// --- Case 3: JS, assert in an EventEmitter callback that never fires ---
// node:test passes while the V8-coverage gate flags the dead assert.
const CASE3_RED = {
  'test_case3.test.js': [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { EventEmitter } from 'node:events';",
    '',
    "test('callback never runs', () => {",
    '  const emitter = new EventEmitter();',
    "  emitter.on('done', (value) => {",
    '    assert.equal(value, 42);',
    '  });',
    "  // 'done' is never emitted: the assert never executes.",
    '  assert.ok(true);',
    '});',
    '',
    "test('normal', () => {",
    '  assert.equal(1 + 1, 2);',
    '});',
  ].join('\n'),
};

const CASE3_GREEN = {
  'test_case3.test.js': [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { EventEmitter } from 'node:events';",
    '',
    "test('callback never runs', () => {",
    '  const emitter = new EventEmitter();',
    "  emitter.on('done', (value) => {",
    '    assert.equal(value, 42);',
    '  });',
    "  emitter.emit('done', 42);",
    '  assert.ok(true);',
    '});',
    '',
    "test('normal', () => {",
    '  assert.equal(1 + 1, 2);',
    '});',
  ].join('\n'),
};

const skipNoPytest = () => ensurePytestPython() === null && 'pytest unavailable and venv install failed';

describe('i6d M3 slice 2 real cases (#122)', () => {
  test('case 1 (pytest): dead callback assert is red while pytest passes, green once called', { skip: skipNoPytest() }, () => {
    const dir = writeFixture(CASE1_RED);
    try {
      const { result, evidence } = runPyGate(dir, ['test_case1.py']);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(evidence, 'evidence.json missing');
      assert.equal(evidence.verdict, 'unexecuted_assertions');
      assert.equal(evidence.pytestExit, 0, 'pytest itself must pass -- that is the point of the case');
      assert.match(result.stdout, /2 passed/);
      assert.equal(evidence.total, 3);
      assert.equal(evidence.executed, 2);
      assert.equal(evidence.unexecuted.length, 1);
      const [flagged] = evidence.unexecuted;
      assert.match(flagged.file, /test_case1\.py$/);
      assert.equal(flagged.line, 3);
      assert.equal(flagged.test, 'test_process_never_calls_back');
      assert.match(flagged.source, /assert value == 42/);
      assert.match(result.stdout, /unexecuted_assertions/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const greenDir = writeFixture(CASE1_GREEN);
    try {
      const { result, evidence } = runPyGate(greenDir, ['test_case1.py']);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(evidence, 'evidence.json missing');
      assert.equal(evidence.verdict, 'pass');
      assert.equal(evidence.total, 3);
      assert.equal(evidence.executed, 3);
      assert.deepEqual(evidence.unexecuted, []);
    } finally {
      rmSync(greenDir, { recursive: true, force: true });
    }
  });

  test('case 2 (pytest): dead callback hides a wrong expectation; wiring it fails, fixing it passes', { skip: skipNoPytest() }, () => {
    const dir = writeFixture(CASE2_RED);
    try {
      const { result, evidence } = runPyGate(dir, ['test_case2.py']);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(evidence, 'evidence.json missing');
      assert.equal(evidence.verdict, 'unexecuted_assertions');
      assert.equal(evidence.pytestExit, 0, 'pytest itself must pass -- the wrong expectation is hidden');
      assert.match(result.stdout, /1 passed/);
      assert.equal(evidence.total, 1);
      assert.equal(evidence.executed, 0);
      assert.equal(evidence.unexecuted.length, 1);
      const [flagged] = evidence.unexecuted;
      assert.match(flagged.file, /test_case2\.py$/);
      assert.equal(flagged.line, 3);
      assert.match(flagged.source, /assert round\(2\.675, 2\) == 2\.68/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const midDir = writeFixture(CASE2_MIDDLE);
    try {
      const { result, evidence } = runPyGate(midDir, ['test_case2.py']);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(evidence, 'evidence.json missing');
      // Wiring the callback exposes the wrong expectation as a plain
      // test failure; the gate reports it as pytest_failed, not as an
      // unexecuted assert (the assert did execute -- and failed).
      assert.equal(evidence.verdict, 'pytest_failed');
      assert.equal(evidence.pytestExit, 1);
      assert.equal(evidence.total, 1);
      assert.equal(evidence.executed, 1);
      assert.deepEqual(evidence.unexecuted, []);
      assert.match(result.stdout, /assert 2\.67 == 2\.68/);
    } finally {
      rmSync(midDir, { recursive: true, force: true });
    }
    const greenDir = writeFixture(CASE2_GREEN);
    try {
      const { result, evidence } = runPyGate(greenDir, ['test_case2.py']);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(evidence, 'evidence.json missing');
      assert.equal(evidence.verdict, 'pass');
      assert.equal(evidence.total, 1);
      assert.equal(evidence.executed, 1);
      assert.deepEqual(evidence.unexecuted, []);
    } finally {
      rmSync(greenDir, { recursive: true, force: true });
    }
  });

  test('case 3 (JS): dead EventEmitter callback assert is red under V8 coverage, green once emitted', () => {
    const dir = writeFixture(CASE3_RED);
    try {
      const { result, evidence } = runJsGate(dir, ['--', 'test_case3.test.js']);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(evidence, 'evidence.json missing');
      assert.equal(evidence.verdict, 'unexecuted_assertions');
      assert.equal(evidence.nodeExit, 0, 'node:test itself must pass -- that is the point of the case');
      assert.equal(evidence.total, 3);
      assert.equal(evidence.executed, 2);
      assert.equal(evidence.unexecuted.length, 1);
      const [flagged] = evidence.unexecuted;
      assert.match(flagged.file, /test_case3\.test\.js$/);
      assert.equal(flagged.line, 8);
      assert.equal(flagged.test, 'callback never runs');
      assert.match(flagged.source, /assert\.equal\(value, 42\)/);
      assert.match(result.stdout, /unexecuted_assertions/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const greenDir = writeFixture(CASE3_GREEN);
    try {
      const { result, evidence } = runJsGate(greenDir, ['--', 'test_case3.test.js']);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(evidence, 'evidence.json missing');
      assert.equal(evidence.verdict, 'pass');
      assert.equal(evidence.total, 3);
      assert.equal(evidence.executed, 3);
      assert.deepEqual(evidence.unexecuted, []);
    } finally {
      rmSync(greenDir, { recursive: true, force: true });
    }
  });
});
