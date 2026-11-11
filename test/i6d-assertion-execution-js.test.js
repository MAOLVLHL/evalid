import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
const jsModulePath = join(repoRoot, 'xflow', 'atoms', 'i6d_assertion_execution_js.js');
const pyModulePath = join(repoRoot, 'xflow', 'atoms', 'i6d_assertion_execution.py');
const python = process.env.PYTHON || 'python3';

// Live pytest runs (merged Python+JS tests only) need a python with pytest
// importable: ambient interpreter, else a throwaway venv in tmpdir. The
// pure-JS tests never touch pytest.
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
  const venvDir = mkdtempSync(join(tmpdir(), 'evalid-i6d-js-venv-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'evalid-i6d-js-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(dir, name.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
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

const GREEN_FIXTURE = {
  'test_calc.test.js': [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    '',
    'function add(a, b) {',
    '  return a + b;',
    '}',
    '',
    '',
    "test('adds', () => {",
    '  assert.equal(add(1, 2), 3);',
    '  assert.equal(add(-1, 1), 0);',
    '});',
    '',
    '',
    "test('adds multiline', () => {",
    '  assert.equal(add(',
    '    2,',
    '    3,',
    '  ), 5);',
    '});',
  ].join('\n'),
};

const DEAD_CALLBACK_FIXTURE = {
  'test_callback.test.js': [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    '',
    "test('callback never runs', () => {",
    '  function onDone(value) {',
    '    assert.equal(value, 42);',
    '  }',
    '  // onDone is defined but never called.',
    '  assert.ok(true);',
    '});',
    '',
    '',
    "test('normal', () => {",
    '  assert.equal(1 + 1, 2);',
    '});',
  ].join('\n'),
};

const SKIPPED_FIXTURE = {
  'test_skipped.test.js': [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    '',
    "test('not ready yet', { skip: true }, () => {",
    '  assert.equal(1, 2);',
    '});',
    '',
    "test.skip('also skipped', () => {",
    '  assert.equal(3, 4);',
    '});',
    '',
    "test('runs', () => {",
    '  assert.equal(1, 1);',
    '});',
  ].join('\n'),
};

const FAILING_FIXTURE = {
  'test_failing.test.js': [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    '',
    "test('fails', () => {",
    '  assert.equal(1, 2);',
    '});',
  ].join('\n'),
};

const UNICODE_FIXTURE = {
  'test_unicode.test.js': [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    '',
    '// 中文注释：回调里的断言',
    "test('callback never runs', () => {",
    '  function onDone(value) {',
    '    assert.equal(value, 42);',
    '  }',
    '  assert.ok(true);',
    '});',
  ].join('\n'),
};

const NESTED_FIXTURE = {
  'test_nested.test.js': [
    "import { test, describe } from 'node:test';",
    "import assert from 'node:assert/strict';",
    '',
    "describe('calc', () => {",
    "  test('adds', () => {",
    '    assert.equal(1 + 1, 2);',
    '  });',
    '});',
    '',
    'assert.equal(1, 1);',
  ].join('\n'),
};

describe('i6d JS assertion-execution gate (M3 slice 1, #120)', () => {
  test('module exists and exposes collectAssertions', async () => {
    assert.ok(existsSync(jsModulePath), `missing ${jsModulePath}`);
    const mod = await import(jsModulePath);
    assert.equal(typeof mod.collectAssertions, 'function');
    assert.equal(typeof mod.isJavaScriptTestFile, 'function');
    assert.equal(typeof mod.runGate, 'function');
  });

  test('isJavaScriptTestFile matches node:test default collection names', async () => {
    const { isJavaScriptTestFile } = await import(jsModulePath);
    assert.equal(isJavaScriptTestFile('test_calc.test.js'), true);
    assert.equal(isJavaScriptTestFile('test/test_calc.test.mjs'), true);
    assert.equal(isJavaScriptTestFile('test_calc.test.cjs'), true);
    assert.equal(isJavaScriptTestFile('test-calc.js'), true);
    assert.equal(isJavaScriptTestFile('src/calc.js'), false);
    assert.equal(isJavaScriptTestFile('test_calc.test.py'), false);
    assert.equal(isJavaScriptTestFile('test_calc.js'), false);
  });

  test('collectAssertions finds asserts with file, line, endLine and enclosing test', async () => {
    const { collectAssertions } = await import(jsModulePath);
    const dir = writeFixture(GREEN_FIXTURE);
    try {
      const asserts = collectAssertions(join(dir, 'test_calc.test.js'));
      assert.equal(asserts.length, 3);
      assert.deepEqual(
        asserts.map((a) => [a.line, a.endLine, a.test]),
        [[10, 10, 'adds'], [11, 11, 'adds'], [16, 19, 'adds multiline']],
      );
      assert.match(asserts[0].source, /assert\.equal\(add\(1, 2\), 3\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('collectAssertions attributes nested tests and module-level asserts', async () => {
    const { collectAssertions } = await import(jsModulePath);
    const dir = writeFixture(NESTED_FIXTURE);
    try {
      const asserts = collectAssertions(join(dir, 'test_nested.test.js'));
      assert.equal(asserts.length, 2);
      assert.deepEqual(
        asserts.map((a) => [a.line, a.test]),
        [[6, 'adds'], [10, null]],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('changedLinesFromDiff counts only added lines, even with context', async () => {
    const { changedLinesFromDiff } = await import(jsModulePath);
    const diff = [
      'diff --git a/test_mixed.test.js b/test_mixed.test.js',
      '--- a/test_mixed.test.js',
      '+++ b/test_mixed.test.js',
      '@@ -1,3 +1,6 @@',
      " test('legacy ok', () => {",
      '+  function onDone(value) {',
      '+    assert.equal(value, 99);',
      '  assert.equal(1 + 1, 2);',
      '+  assert.equal(2 + 2, 4);',
      '-  assert.equal(9, 9);',
      '',
    ].join('\n');
    const changed = changedLinesFromDiff(diff, repoRoot);
    const files = Object.keys(changed);
    assert.equal(files.length, 1);
    assert.match(files[0], /test_mixed\.test\.js$/);
    // Added lines are 2, 3 and 5; the context line (4) and the removed
    // line (which would be 6) are not in scope.
    assert.deepEqual(changed[files[0]], [2, 3, 5]);
  });

  test('all asserts executed: verdict pass, exit 0', () => {
    const dir = writeFixture(GREEN_FIXTURE);
    try {
      const { result, evidence } = runJsGate(dir, ['--', 'test_calc.test.js']);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(evidence, 'evidence.json missing');
      assert.equal(evidence.verdict, 'pass');
      assert.equal(evidence.total, 3);
      assert.equal(evidence.executed, 3);
      assert.deepEqual(evidence.unexecuted, []);
      assert.equal(evidence.nodeExit, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('assert in a never-called callback: verdict unexecuted_assertions, exit 1, line named', () => {
    const dir = writeFixture(DEAD_CALLBACK_FIXTURE);
    try {
      const { result, evidence } = runJsGate(dir, ['--', 'test_callback.test.js']);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(evidence, 'evidence.json missing');
      assert.equal(evidence.verdict, 'unexecuted_assertions');
      assert.equal(evidence.total, 3);
      assert.equal(evidence.executed, 2);
      assert.equal(evidence.unexecuted.length, 1);
      const [flagged] = evidence.unexecuted;
      assert.match(flagged.file, /test_callback\.test\.js$/);
      assert.equal(flagged.line, 6);
      assert.equal(flagged.test, 'callback never runs');
      assert.match(flagged.source, /assert\.equal\(value, 42\)/);
      assert.match(result.stdout, /unexecuted_assertions/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skipped tests ({skip:true} and test.skip) are reported skipped, not red', () => {
    const dir = writeFixture(SKIPPED_FIXTURE);
    try {
      const { result, evidence } = runJsGate(dir, ['--', 'test_skipped.test.js']);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(evidence, 'evidence.json missing');
      assert.equal(evidence.verdict, 'pass');
      assert.equal(evidence.total, 3);
      assert.equal(evidence.executed, 1);
      assert.deepEqual(evidence.unexecuted, []);
      assert.equal(evidence.skipped.length, 2);
      assert.deepEqual(evidence.skipped.map((s) => s.test).sort(), ['also skipped', 'not ready yet']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('failing test: executed assert that fails is js_test_failed, not unexecuted', () => {
    const dir = writeFixture(FAILING_FIXTURE);
    try {
      const { result, evidence } = runJsGate(dir, ['--', 'test_failing.test.js']);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(evidence, 'evidence.json missing');
      assert.equal(evidence.verdict, 'js_test_failed');
      assert.equal(evidence.total, 1);
      assert.equal(evidence.executed, 1);
      assert.deepEqual(evidence.unexecuted, []);
      assert.notEqual(evidence.nodeExit, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('non-ASCII source: V8 offsets are UTF-16, dead assert still located', () => {
    const dir = writeFixture(UNICODE_FIXTURE);
    try {
      const { result, evidence } = runJsGate(dir, ['--', 'test_unicode.test.js']);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(evidence, 'evidence.json missing');
      assert.equal(evidence.verdict, 'unexecuted_assertions');
      assert.equal(evidence.unexecuted.length, 1);
      assert.equal(evidence.unexecuted[0].line, 7);
      assert.match(evidence.unexecuted[0].source, /assert\.equal\(value, 42\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('i6d JS gate diff scoping (M3 slice 1, #120)', () => {
  const BASELINE_MIXED = [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    '',
    "test('legacy dead', () => {",
    '  function onDone(value) {',
    '    assert.equal(value, 42);',
    '  }',
    '  assert.ok(true);',
    '});',
    '',
    "test('legacy ok', () => {",
    '  assert.equal(1 + 1, 2);',
    '});',
  ].join('\n');

  const FEATURE_MIXED_APPEND = [
    '',
    "test('new dead', () => {",
    '  function onDone(value) {',
    '    assert.equal(value, 99);',
    '  }',
    '  assert.ok(true);',
    '});',
    '',
    "test('new ok', () => {",
    '  assert.equal(2 + 2, 4);',
    '});',
  ].join('\n');

  const FEATURE_GREEN_APPEND = [
    '',
    "test('new ok', () => {",
    '  assert.equal(2 + 2, 4);',
    '});',
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

  function writeGitRepo(featureAppend) {
    const dir = writeFixture({ 'test_mixed.test.js': BASELINE_MIXED });
    gitCmd(dir, ['init', '-b', 'main']);
    gitCmd(dir, ['add', '.']);
    gitCmd(dir, ['commit', '-m', 'baseline']);
    if (featureAppend !== null) {
      gitCmd(dir, ['checkout', '-b', 'feature']);
      writeFileSync(join(dir, 'test_mixed.test.js'), BASELINE_MIXED + featureAppend);
      gitCmd(dir, ['add', '.']);
      gitCmd(dir, ['commit', '-m', 'feature']);
    }
    return dir;
  }

  function runScopedGate(fixtureDir, base = 'main') {
    const evidencePath = join(fixtureDir, 'evidence.json');
    const result = spawnSync(process.execPath, [
      jsModulePath,
      '--root', fixtureDir,
      '--output', evidencePath,
      '--only-changed', '--diff-base', base,
    ], { encoding: 'utf8' });
    const evidence = existsSync(evidencePath)
      ? JSON.parse(readFileSync(evidencePath, 'utf8'))
      : null;
    return { result, evidence };
  }

  const skipNoGit = () => !gitAvailable() && 'git unavailable';

  test('mixed fixture: only the in-diff unexecuted assert is red', { skip: skipNoGit() }, () => {
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
      assert.equal(evidence.unexecuted[0].line, 16);
      assert.match(evidence.unexecuted[0].source, /assert\.equal\(value, 99\)/);
      assert.equal(evidence.outOfScope.length, 3);
      assert.ok(evidence.outOfScope.some((a) => a.line === 6 && /assert\.equal\(value, 42\)/.test(a.source)),
        'legacy unexecuted assert must be out of scope, not red');
      assert.match(evidence.diffBase, /^[0-9a-f]{40}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('diff adds only executed asserts: verdict pass, legacy dead assert out of scope', { skip: skipNoGit() }, () => {
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

  test('empty diff: verdict pass, everything out of scope, exit 0', { skip: skipNoGit() }, () => {
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

describe('i6d merged Python+JS gate (M3 slice 1, #120)', () => {
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

  // Atom mode through the Python CLI: --project-root + --change-id, the
  // way the workflow executor invokes the I6d atom. JS-only change must
  // be judged without pytest (no Python test files in scope).
  test('atom mode, JS-only dead assert: merged verdict unexecuted_assertions, single JSON line', { skip: !gitAvailable() && 'git unavailable' }, () => {
    const dir = writeFixture({
      'test_mixed.test.js': [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        '',
        "test('legacy ok', () => {",
        '  assert.equal(1 + 1, 2);',
        '});',
      ].join('\n'),
    });
    try {
      gitCmd(dir, ['init', '-b', 'main']);
      gitCmd(dir, ['add', '.']);
      gitCmd(dir, ['commit', '-m', 'baseline']);
      gitCmd(dir, ['checkout', '-b', 'feature']);
      writeFileSync(join(dir, 'test_mixed.test.js'), [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        '',
        "test('legacy ok', () => {",
        '  assert.equal(1 + 1, 2);',
        '});',
        '',
        "test('new dead', () => {",
        '  function onDone(value) {',
        '    assert.equal(value, 99);',
        '  }',
        '  assert.ok(true);',
        '});',
      ].join('\n'));
      gitCmd(dir, ['add', '.']);
      gitCmd(dir, ['commit', '-m', 'feature']);
      const result = spawnSync(python, [
        pyModulePath,
        '--project-root', dir,
        '--change-id', 'chg-i6d-js',
        '--pytest-python', python,
        '--only-changed',
      ], { encoding: 'utf8' });
      const proofPath = join(dir, 'specs', 'changes', 'chg-i6d-js', 'tdd', 'i6d-0.json');
      assert.ok(existsSync(proofPath), `i6d-0.json missing at ${proofPath}: ${result.stdout}${result.stderr}`);
      const evidence = JSON.parse(readFileSync(proofPath, 'utf8'));
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(evidence.verdict, 'unexecuted_assertions');
      assert.equal(evidence.unexecuted.length, 1);
      assert.equal(evidence.unexecuted[0].line, 10);
      assert.match(evidence.unexecuted[0].source, /assert\.equal\(value, 99\)/);
      assert.equal(evidence.languages.python.total, 0);
      assert.equal(evidence.languages.javascript.verdict, 'unexecuted_assertions');
      // Atom stdout must be exactly one JSON line.
      assert.equal(result.stdout.trim().split('\n').length, 1, result.stdout);
      const summary = JSON.parse(result.stdout.trim());
      assert.equal(summary.ok, false);
      assert.equal(summary.verdict, 'unexecuted_assertions');
      assert.equal(summary.proof_file, proofPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('atom mode, mixed py-green + js-dead: both languages judged, merged totals', { skip: (!gitAvailable() || ensurePytestPython() === null) && 'git or pytest unavailable' }, () => {
    const dir = writeFixture({
      'test_mixed.py': [
        'def test_legacy_ok():',
        '    assert 1 + 1 == 2',
        '',
      ].join('\n'),
      'test_mixed.test.js': [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        '',
        "test('legacy ok', () => {",
        '  assert.equal(1 + 1, 2);',
        '});',
      ].join('\n'),
    });
    try {
      gitCmd(dir, ['init', '-b', 'main']);
      gitCmd(dir, ['add', '.']);
      gitCmd(dir, ['commit', '-m', 'baseline']);
      gitCmd(dir, ['checkout', '-b', 'feature']);
      writeFileSync(join(dir, 'test_mixed.py'), [
        'def test_legacy_ok():',
        '    assert 1 + 1 == 2',
        '',
        '',
        'def test_new_ok():',
        '    assert 2 + 2 == 4',
        '',
      ].join('\n'));
      writeFileSync(join(dir, 'test_mixed.test.js'), [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        '',
        "test('legacy ok', () => {",
        '  assert.equal(1 + 1, 2);',
        '});',
        '',
        "test('new dead', () => {",
        '  function onDone(value) {',
        '    assert.equal(value, 99);',
        '  }',
        '  assert.ok(true);',
        '});',
      ].join('\n'));
      gitCmd(dir, ['add', '.']);
      gitCmd(dir, ['commit', '-m', 'feature']);
      const result = spawnSync(python, [
        pyModulePath,
        '--project-root', dir,
        '--change-id', 'chg-i6d-mixed',
        '--pytest-python', ensurePytestPython(),
        '--only-changed',
      ], { encoding: 'utf8' });
      const proofPath = join(dir, 'specs', 'changes', 'chg-i6d-mixed', 'tdd', 'i6d-0.json');
      assert.ok(existsSync(proofPath), `i6d-0.json missing at ${proofPath}: ${result.stdout}${result.stderr}`);
      const evidence = JSON.parse(readFileSync(proofPath, 'utf8'));
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(evidence.verdict, 'unexecuted_assertions');
      assert.equal(evidence.languages.python.verdict, 'pass');
      assert.equal(evidence.languages.javascript.verdict, 'unexecuted_assertions');
      assert.equal(evidence.total, evidence.languages.python.total + evidence.languages.javascript.total);
      assert.equal(evidence.unexecuted.length, 1);
      assert.match(evidence.unexecuted[0].file, /test_mixed\.test\.js$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
