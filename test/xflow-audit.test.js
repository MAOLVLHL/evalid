import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  checkNodeModulesSnapshot,
  compareNodeModulesTrees,
  extractClaims,
  isDependencyFile,
  isJavaScriptTestFile,
  isPythonTestFile,
  isTestCommand,
  listBunCachePackages,
  parseAuditTarget,
  parseClaimCounts,
  parseDiffFiles,
  parseJsonc,
  parseReplayCounts,
  readBunLockEntries,
  readLockfileEntries,
  readLockfileVersions,
  renderAuditReport,
  resolveClaimCwd,
  runAudit,
} from '../src/core/audit.js';

const repoRoot = resolve(import.meta.dirname, '..');
const python = process.env.PYTHON || 'python3';

// Live pytest runs need a python with pytest importable (same approach as
// the i6d tests: ambient interpreter, else a throwaway venv in tmpdir).
// If neither works, the live tests skip instead of failing on an
// environment gap.
let pytestPython = null;
let pytestVenvDir = null;
// The venv is per test-file process; remove it when the process exits so
// repeated full-suite runs do not fill the 512M /tmp tmpfs (ENOSPC).
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
  const venvDir = mkdtempSync(join(tmpdir(), 'evalid-audit-venv-'));
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

const PR75_BODY = `## Green-path proof in this PR
\`specs/changes/pr-comment-ledger/\` is force-added so this PR itself carries a sealed green proof for the new tests (\`node --test test/github-action-ledger-comment.test.js test/github-action-verify-proof.test.js\`, exit 0).

## Tests
- New \`test/github-action-ledger-comment.test.js\`: 18 tests — all pass locally.
- Existing \`test/github-action-verify-proof.test.js\`: 6/6 pass.
- Full \`npm test\`: exit 0; \`drift:scan\` and \`pack:check\` pass.`;

const PR68_BODY = `## 回归测试

新增 test/phase-run-dispatch-dead-code.test.js（5 项），RED→GREEN 实测：
- 删除前：4/5 通过，仅「文件已不存在」失败；
- 删除后：5/5 通过；
- 全量 \`npm test\`：50 文件、440 项、439 通过、0 失败、1 项跳过。`;

describe('extractClaims', () => {
  test('extracts the #75 claims: targeted node --test plus full npm test', () => {
    const claims = extractClaims(PR75_BODY);
    const targeted = claims.find((c) => c.command.startsWith('node --test test/github-action-ledger-comment.test.js'));
    assert.ok(targeted, `targeted claim missing: ${JSON.stringify(claims)}`);
    assert.equal(targeted.claimedExit, 0);
    const full = claims.find((c) => c.command === 'npm test');
    assert.ok(full, `npm test claim missing: ${JSON.stringify(claims)}`);
    assert.equal(full.claimedExit, 0);
  });

  test('attaches file-scoped counts to the command that runs the file', () => {
    const claims = extractClaims(PR75_BODY);
    const targeted = claims.find((c) => c.command.startsWith('node --test test/github-action-ledger-comment.test.js'));
    // The command runs two files (18 + 6 tests); per-file counts sum.
    assert.equal(targeted.claimedPassed, 24);
    assert.equal(targeted.claimedFailed, 0);
    assert.equal(targeted.claimedTotal, 24);
  });

  test('parses Chinese counts from the #68 body', () => {
    const counts = parseClaimCounts('全量 npm test：50 文件、440 项、439 通过、0 失败、1 项跳过。');
    assert.equal(counts.total, 440);
    assert.equal(counts.passed, 439);
    assert.equal(counts.failed, 0);
    const claims = extractClaims(PR68_BODY);
    const full = claims.find((c) => c.command === 'npm test');
    assert.ok(full);
    assert.equal(full.claimedPassed, 439);
    assert.equal(full.claimedFailed, 0);
    assert.equal(full.claimedTotal, 440);
  });

  test('does not leak one clause counts onto another command on the line', () => {
    // #71 body: "then passed 6/6 after. Full `npm test` passes (exit 0...)"
    // — the 6/6 belongs to the new test file, not to the full suite.
    const claims = extractClaims(
      'RED → GREEN evidence: the new test file failed before, then passed 6/6 after. Full `npm test` passes (exit 0, run twice post-change).',
    );
    assert.equal(claims.length, 1);
    assert.equal(claims[0].command, 'npm test');
    assert.equal(claims[0].claimedExit, 0);
    assert.equal(claims[0].claimedPassed, null);
    assert.equal(claims[0].claimedTotal, null);
  });

  test('parses x/y pass fractions and returns no claims for claim-free text', () => {
    assert.deepEqual(parseClaimCounts('6/6 pass'), { passed: 6, total: 6, failed: 0 });
    assert.deepEqual(extractClaims('Just a refactor, no tests mentioned.'), []);
  });

  test('distinguishes passed/failed from passed/total in X/Y (M13 slice 1, #178)', () => {
    // Second number smaller than the first cannot be a total: it is the
    // failed count (M12 batch audit: 472/12 used to yield failed -460).
    assert.deepEqual(parseClaimCounts('472/12'), { passed: 472, failed: 12 });
    assert.deepEqual(parseClaimCounts('240/0'), { passed: 240, failed: 0 });
    // Second number greater than or equal to the first is the total.
    assert.deepEqual(parseClaimCounts('61/64'), { passed: 61, total: 64, failed: 3 });
    // Boundaries: total == passed (zero failures), and no second number.
    assert.deepEqual(parseClaimCounts('240/240'), { passed: 240, total: 240, failed: 0 });
    assert.deepEqual(parseClaimCounts('472 passed'), { passed: 472 });
    assert.deepEqual(parseClaimCounts('0/5'), { passed: 0, total: 5, failed: 5 });
  });

  test('parses label-first counts: node --test summary style (M2 slice 2, #116)', () => {
    // senpi PRs report "reports `pass 8`, `fail 0`" — the count-first
    // patterns never fired, so the RED claim (pass 0, fail 4) was silently
    // dropped and audited as exit-only.
    assert.deepEqual(parseClaimCounts('reports `pass 8`, `fail 0`'), { passed: 8, failed: 0 });
    assert.deepEqual(parseClaimCounts('reports `pass 0`, `fail 4`, and `AssertionError`'), { passed: 0, failed: 4 });
    const claims = extractClaims('RED: `node --test test/a.test.js` — reports `pass 0`, `fail 4`.');
    assert.equal(claims.length, 1);
    assert.equal(claims[0].claimedPassed, 0);
    assert.equal(claims[0].claimedFailed, 4);
  });

  test('count-first counts still win over label-first on the same line', () => {
    assert.deepEqual(parseClaimCounts('9 passed, 0 failed'), { passed: 9, failed: 0 });
    assert.deepEqual(parseClaimCounts('Full `npm test` passes (exit 0, run twice post-change)'), {});
  });

  test('extracts python -m unittest claims: module, discover, and python3 -v forms', () => {
    // Regression: swrm M2 attempt 1 (run 20261109-231900-3c6b2a) genuinely
    // passed 9 unittest tests but audit reported no_claims — the runner
    // list knew pytest only. Each form below must extract one claim.
    const body = [
      'Tests: `python -m unittest tests.test_foo` — 9 passed, 0 failed.',
      'Also ran `python -m unittest discover` — 9 passed, 0 failed.',
      'And `python3 -m unittest -v tests.test_bar` — 9 passed, 0 failed.',
    ].join('\n');
    const claims = extractClaims(body);
    assert.equal(claims.length, 3, JSON.stringify(claims));
    for (const claim of claims) {
      assert.equal(claim.claimedPassed, 9);
      assert.equal(claim.claimedFailed, 0);
      assert.equal(claim.claimedExit, 0);
    }
    assert.equal(claims[0].command, 'python -m unittest tests.test_foo');
    assert.equal(claims[1].command, 'python -m unittest discover');
    assert.equal(claims[2].command, 'python3 -m unittest -v tests.test_bar');
  });

  test('extracts bun test claims with bun-style count-first pass/fail (M6 slice 1, #132)', () => {
    // G3 (M2 acceptance): a PR whose body claims `bun test` was audited
    // as no_claims — the runner list knew npm/node/pytest only.
    assert.equal(isTestCommand('bun test'), true);
    assert.equal(isTestCommand('bun run test'), true);
    const body = 'Tests: `bun test` — 18 pass, 0 fail.';
    const claims = extractClaims(body);
    assert.equal(claims.length, 1, JSON.stringify(claims));
    assert.equal(claims[0].command, 'bun test');
    assert.equal(claims[0].claimedPassed, 18);
    assert.equal(claims[0].claimedFailed, 0);
    assert.equal(claims[0].claimedExit, 0);
  });

  test('extracts bun test with a file argument and the bun run test form (M6 slice 1, #132)', () => {
    const body = [
      'Tests: `bun test test/calc.test.ts` — 2 pass, 0 fail.',
      'Full suite: `bun run test` — 18 pass, 0 fail.',
    ].join('\n');
    const claims = extractClaims(body);
    assert.equal(claims.length, 2, JSON.stringify(claims));
    assert.equal(claims[0].command, 'bun test test/calc.test.ts');
    assert.equal(claims[0].claimedPassed, 2);
    assert.equal(claims[0].claimedFailed, 0);
    assert.equal(claims[1].command, 'bun run test');
    assert.equal(claims[1].claimedPassed, 18);
    assert.equal(claims[1].claimedFailed, 0);
  });
});

describe('resolveClaimCwd (M2 slice 2, #116)', () => {
  function makeTree(files) {
    const root = mkdtempSync(join(tmpdir(), 'evalid-audit-cwd-'));
    for (const file of files) {
      mkdirSync(join(root, file.split('/').slice(0, -1).join('/')), { recursive: true });
      writeFileSync(join(root, file), 'x');
    }
    return root;
  }

  test('stays at the root when the paths resolve there', () => {
    const root = makeTree(['test/a.test.js']);
    try {
      assert.equal(resolveClaimCwd(root, ['node', '--test', 'test/a.test.js']), '');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns the unique subdirectory when paths exist only there', () => {
    const root = makeTree(['packages/tui/test/stdin-buffer.test.ts', 'packages/tui/test/setup.mjs']);
    try {
      // senpi#2606 shape: two path tokens, both under packages/tui.
      assert.equal(
        resolveClaimCwd(root, ['node', '--test', '--import', 'tsx', '--import', './test/setup.mjs', 'test/stdin-buffer.test.ts']),
        'packages/tui',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('stays at the root when two subdirectories both fit', () => {
    const root = makeTree(['pkg-a/test/a.test.js', 'pkg-b/test/a.test.js']);
    try {
      assert.equal(resolveClaimCwd(root, ['node', '--test', 'test/a.test.js']), '');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('stays at the root when a path exists nowhere, or there are no path tokens', () => {
    const root = makeTree(['packages/tui/test/stdin-buffer.test.ts']);
    try {
      assert.equal(resolveClaimCwd(root, ['node', '--test', 'test/missing.test.js']), '');
      assert.equal(resolveClaimCwd(root, ['npm', 'test']), '');
      // One token under pkg, the other nowhere: no single dir fits.
      assert.equal(resolveClaimCwd(root, ['node', '--test', 'test/stdin-buffer.test.ts', 'test/a.test.js']), '');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('parseDiffFiles', () => {
  test('lists touched files, test files, and added evalid seals', () => {
    const diff = [
      'diff --git a/action/verify-proof.mjs b/action/verify-proof.mjs',
      '+++ b/action/verify-proof.mjs',
      'diff --git a/test/github-action-verify-proof.test.js b/test/github-action-verify-proof.test.js',
      '+++ b/test/github-action-verify-proof.test.js',
      'diff --git a/specs/changes/pr-comment-ledger/tdd/green-0.json b/specs/changes/pr-comment-ledger/tdd/green-0.json',
      '+++ b/specs/changes/pr-comment-ledger/tdd/green-0.json',
    ].join('\n');
    const parsed = parseDiffFiles(diff);
    assert.deepEqual(parsed.files, [
      'action/verify-proof.mjs',
      'test/github-action-verify-proof.test.js',
      'specs/changes/pr-comment-ledger/tdd/green-0.json',
    ]);
    assert.deepEqual(parsed.testFiles, ['test/github-action-verify-proof.test.js']);
    assert.deepEqual(parsed.seals, [{ changeId: 'pr-comment-ledger', phase: 'green', attempt: 0, path: 'specs/changes/pr-comment-ledger/tdd/green-0.json' }]);
  });
});

describe('parseAuditTarget', () => {
  test('classifies PR refs: bare number, owner/repo#n, PR URL', () => {
    assert.deepEqual(parseAuditTarget('75'), { kind: 'pr', number: '75', repo: null, raw: '75' });
    assert.deepEqual(parseAuditTarget('surlymochan/evalid#75'), { kind: 'pr', number: '75', repo: 'surlymochan/evalid', raw: 'surlymochan/evalid#75' });
    assert.deepEqual(parseAuditTarget('https://github.com/surlymochan/evalid/pull/75'), { kind: 'pr', number: '75', repo: 'surlymochan/evalid', raw: 'https://github.com/surlymochan/evalid/pull/75' });
    assert.deepEqual(parseAuditTarget('https://github.com/surlymochan/evalid/pull/75/files'), { kind: 'pr', number: '75', repo: 'surlymochan/evalid', raw: 'https://github.com/surlymochan/evalid/pull/75/files' });
  });

  test('classifies diff targets: .patch/.diff paths, existing files, stdin dash', () => {
    assert.deepEqual(parseAuditTarget('change.patch'), { kind: 'diff', path: 'change.patch', raw: 'change.patch' });
    assert.deepEqual(parseAuditTarget('/tmp/some.diff'), { kind: 'diff', path: '/tmp/some.diff', raw: '/tmp/some.diff' });
    assert.deepEqual(parseAuditTarget('-'), { kind: 'diff', path: '-', raw: '-' });
    // An existing file without a patch suffix is still a diff target.
    const tmp = mkdtempSync(join(tmpdir(), 'evalid-audit-target-'));
    try {
      const file = join(tmp, 'notes.txt');
      writeFileSync(file, 'x');
      assert.deepEqual(parseAuditTarget(file), { kind: 'diff', path: file, raw: file });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects anything else as unknown (a bare number wins over a file)', () => {
    assert.equal(parseAuditTarget('hello').kind, 'unknown');
    assert.equal(parseAuditTarget('owner/repo').kind, 'unknown');
    assert.equal(parseAuditTarget('').kind, 'unknown');
    assert.equal(parseAuditTarget('  ').kind, 'unknown');
  });
});

describe('parseReplayCounts', () => {
  test('reads node --test summary lines and pytest lines', () => {
    assert.deepEqual(parseReplayCounts('# pass 18\n# fail 0\n'), { passed: 18, failed: 0, total: 18 });
    assert.deepEqual(parseReplayCounts('18 passed, 0 failed in 1.2s\n'), { passed: 18, failed: 0, total: null });
    assert.equal(parseReplayCounts('no counts here'), null);
  });

  test('multi-file runner output has no single total to compare', () => {
    // npm test prints one summary per file; the first file's numbers are
    // not the suite total, so counts stay unparsed (exit code decides).
    assert.equal(parseReplayCounts('ℹ pass 3\nℹ fail 0\nℹ pass 1\nℹ fail 0\n'), null);
  });

  test('reads python -m unittest summary lines (pytest parity)', () => {
    assert.deepEqual(
      parseReplayCounts('Ran 9 tests in 0.012s\n\nOK\n'),
      { passed: 9, failed: 0, total: 9 },
    );
    assert.deepEqual(
      parseReplayCounts('Ran 9 tests in 0.012s\n\nFAILED (failures=1, errors=1)\n'),
      { passed: 7, failed: 2, total: 9 },
    );
    assert.deepEqual(
      parseReplayCounts('Ran 9 tests in 0.012s\n\nFAILED (failures=2)\n'),
      { passed: 7, failed: 2, total: 9 },
    );
    assert.deepEqual(
      parseReplayCounts('Ran 9 tests in 0.012s\n\nOK (skipped=1)\n'),
      { passed: 8, failed: 0, total: 9 },
    );
  });

  test('reads bun test summary lines: one aggregated block per run (M6 slice 1, #132)', () => {
    // Real `bun test` v1.4.4 output (verified 2026-11-11): per-test
    // "(pass)" lines, then a single totals block " N pass / N fail" and
    // "Ran N tests across M files." — count-first, unlike node --test.
    assert.deepEqual(
      parseReplayCounts('calc.test.ts:\n(pass) adds [0.07ms]\n(pass) adds again [0.03ms]\n\n 2 pass\n 0 fail\n 2 expect() calls\nRan 2 tests across 1 file. [48.00ms]\n'),
      { passed: 2, failed: 0, total: 2 },
    );
    assert.deepEqual(
      parseReplayCounts('bad.test.ts:\n(pass) passes [0.04ms]\n(fail) fails [6.28ms]\n\n 1 pass\n 1 fail\n 2 expect() calls\nRan 2 tests across 1 file. [10.00ms]\n'),
      { passed: 1, failed: 1, total: 2 },
    );
    // Multi-file run still prints one aggregated totals block.
    assert.deepEqual(
      parseReplayCounts(' 3 pass\n 1 fail\n 4 expect() calls\nRan 4 tests across 2 files. [5.00ms]\n'),
      { passed: 3, failed: 1, total: 4 },
    );
  });
});

describe('node_modules snapshot consistency (M6 slice 1, #132)', () => {
  function makeTree(structure) {
    const root = mkdtempSync(join(tmpdir(), 'evalid-audit-snapshot-'));
    for (const [rel, content] of Object.entries(structure)) {
      const file = join(root, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    }
    return root;
  }

  function lockfile(versions) {
    const packages = { '': { name: 'fixture', version: '1.0.0' } };
    for (const [name, spec] of Object.entries(versions)) {
      // A plain version string, or a full lockfile entry
      // ({ version, optional, cpu, os, libc }).
      packages[`node_modules/${name}`] = typeof spec === 'string' ? { version: spec } : spec;
    }
    return { name: 'fixture', lockfileVersion: 3, packages };
  }

  function cleanup(...roots) {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }

  test('isDependencyFile covers manifests and lockfiles', () => {
    assert.equal(isDependencyFile('package.json'), true);
    assert.equal(isDependencyFile('package-lock.json'), true);
    assert.equal(isDependencyFile('bun.lockb'), true);
    assert.equal(isDependencyFile('bun.lock'), true);
    assert.equal(isDependencyFile('yarn.lock'), true);
    assert.equal(isDependencyFile('pnpm-lock.yaml'), true);
    assert.equal(isDependencyFile('packages/pkg/package.json'), true);
    assert.equal(isDependencyFile('src/index.js'), false);
    assert.equal(isDependencyFile('test/a.test.js'), false);
  });

  test('readLockfileVersions reads npm v7+ packages and legacy dependencies', () => {
    const root = makeTree({ 'package-lock.json': lockfile({ 'js-yaml': '4.1.0', '@scope/pkg': '2.0.1' }) });
    try {
      const versions = readLockfileVersions(root);
      assert.equal(versions.get('js-yaml'), '4.1.0');
      assert.equal(versions.get('@scope/pkg'), '2.0.1');
      assert.equal(versions.has(''), false);
    } finally {
      cleanup(root);
    }
    const legacy = makeTree({ 'package-lock.json': { dependencies: { 'js-yaml': { version: '3.14.1' } } } });
    try {
      assert.equal(readLockfileVersions(legacy).get('js-yaml'), '3.14.1');
    } finally {
      cleanup(legacy);
    }
    assert.equal(readLockfileVersions(makeTree({})), null);
  });

  test('deps unchanged + replay node_modules missing is not a mismatch signal (#111 root cause)', () => {
    // The replay tree has no node_modules snapshot at all, but the diff
    // touches no dependency file: the absence must not read as a
    // mismatch — it is an environment gap, not a broken change.
    const workdir = makeTree({ 'package.json': { name: 'fixture' } });
    try {
      const check = checkNodeModulesSnapshot(workdir, null, { diffFiles: ['src/index.js'] });
      assert.equal(check.status, 'deps_unchanged_missing_snapshot');
      assert.equal(check.consistent, true);
      assert.equal(check.depsChanged, false);
      assert.deepEqual(check.differences, []);
    } finally {
      cleanup(workdir);
    }
  });

  test('deps changed + replay node_modules missing cannot be judged', () => {
    const workdir = makeTree({ 'package.json': { name: 'fixture' } });
    try {
      const check = checkNodeModulesSnapshot(workdir, null, { diffFiles: ['package-lock.json'] });
      assert.equal(check.status, 'deps_changed_missing_snapshot');
      assert.equal(check.consistent, null);
      assert.equal(check.depsChanged, true);
      assert.equal(check.differences.length, 1);
      assert.match(check.differences[0], /node_modules: missing/);
    } finally {
      cleanup(workdir);
    }
  });

  test('zero declared deps + no node_modules is consistent, not missing', () => {
    // `npm ci` with zero dependencies exits 0 and creates no
    // node_modules dir (verified 2026-11-11): the absent tree is the
    // expected tree.
    const workdir = makeTree({
      'package.json': { name: 'fixture' },
      'package-lock.json': lockfile({}),
    });
    try {
      const check = checkNodeModulesSnapshot(workdir, null, { diffFiles: ['src/index.js'] });
      assert.equal(check.status, 'consistent');
      assert.equal(check.consistent, true);
      assert.deepEqual(check.differences, []);
    } finally {
      cleanup(workdir);
    }
  });

  test('installed tree matching the lockfile is consistent', () => {
    const workdir = makeTree({
      'package.json': { name: 'fixture' },
      'package-lock.json': lockfile({ 'js-yaml': '4.1.0' }),
      'node_modules/js-yaml/package.json': { name: 'js-yaml', version: '4.1.0' },
    });
    try {
      const check = checkNodeModulesSnapshot(workdir, null, { diffFiles: ['src/index.js'] });
      assert.equal(check.status, 'consistent');
      assert.equal(check.consistent, true);
      assert.deepEqual(check.differences, []);
    } finally {
      cleanup(workdir);
    }
  });

  test('version drift vs the lockfile names the exact package.json', () => {
    const workdir = makeTree({
      'package.json': { name: 'fixture' },
      'package-lock.json': lockfile({ 'js-yaml': '4.1.0' }),
      'node_modules/js-yaml/package.json': { name: 'js-yaml', version: '4.1.1' },
    });
    try {
      const check = checkNodeModulesSnapshot(workdir, null, { diffFiles: ['src/index.js'] });
      assert.equal(check.status, 'inconsistent');
      assert.equal(check.consistent, false);
      assert.deepEqual(check.differences, [
        'node_modules/js-yaml/package.json: version 4.1.1 (replay) vs 4.1.0 (lockfile)',
      ]);
    } finally {
      cleanup(workdir);
    }
  });

  test('a lockfile package missing from the replay tree is named exactly', () => {
    const workdir = makeTree({
      'package.json': { name: 'fixture' },
      'package-lock.json': lockfile({ 'js-yaml': '4.1.0' }),
      'node_modules/other/package.json': { name: 'other', version: '1.0.0' },
    });
    try {
      const check = checkNodeModulesSnapshot(workdir, null, { diffFiles: ['src/index.js'] });
      assert.equal(check.status, 'inconsistent');
      assert.deepEqual(check.differences, [
        'node_modules/js-yaml: missing in replay tree (expected 4.1.0)',
      ]);
    } finally {
      cleanup(workdir);
    }
  });

  test('no lockfile + installed tree reports cannot-determine, never hollow consistent (M6 slice 3, #135)', () => {
    // omo#8014 (M6 slice 2): with no package-lock.json the judgement
    // degenerated into replay-vs-source self-comparison and reported a
    // hollow "consistent" (0 differences). Without a trustworthy
    // lockfile there is no reference to judge against — say so
    // explicitly, whether or not the tree was copied from the source.
    const workdir = makeTree({
      'package.json': { name: 'fixture' },
      'node_modules/js-yaml/package.json': { name: 'js-yaml', version: '4.1.0' },
    });
    const source = makeTree({
      'node_modules/js-yaml/package.json': { name: 'js-yaml', version: '4.1.0' },
    });
    try {
      const copied = checkNodeModulesSnapshot(workdir, source, { diffFiles: ['src/index.js'], replayCopiedFromSource: true });
      assert.equal(copied.status, 'cannot-determine');
      assert.equal(copied.consistent, null);
      assert.match(copied.differences[0], /copied from the source tree/);
      assert.match(copied.differences[0], /cannot-determine/);
      const installed = checkNodeModulesSnapshot(workdir, source, { diffFiles: ['src/index.js'] });
      assert.equal(installed.status, 'cannot-determine');
      assert.equal(installed.consistent, null);
      assert.match(installed.differences[0], /no lockfile/);
    } finally {
      cleanup(workdir, source);
    }
  });

  test('optional packages missing from the replay tree are exempt, not inconsistent (M6 slice 3, #135)', () => {
    // senpi#2606 (92 diffs) / senpi#4801 (162 diffs): every recorded
    // difference was an optional lockfile entry — platform packages
    // (os/cpu/libc mismatch on linux-x64/glibc) plus pruned optional
    // transitives (buildcheck/cpu-features/nan, @emnapi/*). A
    // successful install legitimately skips them; the lockfile's own
    // `optional` flag is the authority.
    const workdir = makeTree({
      'package.json': { name: 'fixture' },
      'package-lock.json': lockfile({
        'js-yaml': '4.1.0',
        '@scope/darwin-pkg': { version: '1.0.0', optional: true, cpu: ['arm64'], os: ['darwin'] },
        '@scope/musl-pkg': { version: '1.0.0', optional: true, cpu: ['x64'], os: ['linux'], libc: ['musl'] },
        'pruned-transitive': { version: '2.0.0', optional: true },
      }),
      'node_modules/js-yaml/package.json': { name: 'js-yaml', version: '4.1.0' },
    });
    try {
      const check = checkNodeModulesSnapshot(workdir, null, { diffFiles: ['src/index.js'] });
      assert.equal(check.status, 'consistent');
      assert.equal(check.consistent, true);
      assert.deepEqual(check.differences, []);
      assert.equal(check.optionalExempted, 3);
      assert.deepEqual([...check.exemptedPackages].sort(), ['@scope/darwin-pkg', '@scope/musl-pkg', 'pruned-transitive']);
    } finally {
      cleanup(workdir);
    }
  });

  test('a missing non-optional package is still inconsistent', () => {
    const workdir = makeTree({
      'package.json': { name: 'fixture' },
      'package-lock.json': lockfile({
        'js-yaml': '4.1.0',
        'required-pkg': '1.0.0',
        '@scope/darwin-pkg': { version: '1.0.0', optional: true, cpu: ['arm64'], os: ['darwin'] },
      }),
      'node_modules/js-yaml/package.json': { name: 'js-yaml', version: '4.1.0' },
    });
    try {
      const check = checkNodeModulesSnapshot(workdir, null, { diffFiles: ['src/index.js'] });
      assert.equal(check.status, 'inconsistent');
      assert.equal(check.consistent, false);
      assert.deepEqual(check.differences, [
        'node_modules/required-pkg: missing in replay tree (expected 1.0.0)',
      ]);
      assert.equal(check.optionalExempted, 1);
    } finally {
      cleanup(workdir);
    }
  });

  test('version drift on an installed optional package is still a real difference', () => {
    const workdir = makeTree({
      'package.json': { name: 'fixture' },
      'package-lock.json': lockfile({
        '@scope/darwin-pkg': { version: '1.0.0', optional: true, cpu: ['arm64'], os: ['darwin'] },
      }),
      'node_modules/@scope/darwin-pkg/package.json': { name: '@scope/darwin-pkg', version: '1.0.1' },
    });
    try {
      const check = checkNodeModulesSnapshot(workdir, null, { diffFiles: ['src/index.js'] });
      assert.equal(check.status, 'inconsistent');
      assert.deepEqual(check.differences, [
        'node_modules/@scope/darwin-pkg/package.json: version 1.0.1 (replay) vs 1.0.0 (lockfile)',
      ]);
      assert.equal(check.optionalExempted, 0);
    } finally {
      cleanup(workdir);
    }
  });

  test('parseJsonc keeps // inside strings and drops comments + trailing commas', () => {
    const parsed = parseJsonc(`{
      // a comment line
      "a": "sha512-abc//def==",
      "b": [1, 2,],
      /* block comment */
      "c": { "d": true, },
    }`);
    assert.deepEqual(parsed, { a: 'sha512-abc//def==', b: [1, 2], c: { d: true } });
  });

  test('bun.lock is parsed as a lockfile authority (M6 slice 3, #135)', () => {
    // Fixture in the real bun.lock shape (verified against
    // oh-my-openagent#8014, merge 51ddf958): JSONC with a comment and
    // trailing commas, integrity hashes containing `//`, platform
    // packages carrying os/cpu in the entry meta, optional packages
    // listed under workspaces / entry optionalDependencies.
    const bunLock = `{
      // bun.lock fixture
      "lockfileVersion": 1,
      "workspaces": {
        "": {
          "name": "fixture",
          "dependencies": { "js-yaml": "^4.1.0" },
          "optionalDependencies": { "platform-pkg": "^1.0.0" },
        },
      },
      "packages": {
        "js-yaml": ["js-yaml@4.1.0", "", { "optionalDependencies": { "plain-opt": "2.0.0" } }, "sha512-abc//def=="],
        "platform-pkg": ["platform-pkg@1.0.0", "", { "os": "darwin", "cpu": "arm64" }, "sha512-xyz=="],
        "plain-opt": ["plain-opt@2.0.0", "", {}, "sha512-qq=="],
      },
    }`;
    const root = makeTree({ 'bun.lock': bunLock });
    try {
      const entries = readBunLockEntries(root);
      assert.equal(entries.get('js-yaml').version, '4.1.0');
      assert.equal(entries.get('js-yaml').optional, false);
      assert.equal(entries.get('platform-pkg').version, '1.0.0');
      assert.equal(entries.get('platform-pkg').optional, true);
      assert.equal(entries.get('platform-pkg').os, 'darwin');
      assert.equal(entries.get('platform-pkg').cpu, 'arm64');
      assert.equal(entries.get('plain-opt').optional, true);
      assert.equal(readLockfileEntries(root).get('platform-pkg').version, '1.0.0');
    } finally {
      cleanup(root);
    }
    assert.equal(readBunLockEntries(makeTree({})), null);
    assert.equal(readBunLockEntries(makeTree({ 'bun.lock': '{ not json' })), null);
  });

  test('bun.lock-only tree: matching install is consistent, missing optional is exempt', () => {
    const bunLock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "fixture", "optionalDependencies": { "platform-pkg": "^1.0.0" } } },
      "packages": {
        "js-yaml": ["js-yaml@4.1.0", "", {}, "sha512-abc=="],
        "platform-pkg": ["platform-pkg@1.0.0", "", { "os": "darwin", "cpu": "arm64" }, "sha512-xyz=="],
      },
    }`;
    const workdir = makeTree({
      'package.json': { name: 'fixture' },
      'bun.lock': bunLock,
      'node_modules/js-yaml/package.json': { name: 'js-yaml', version: '4.1.0' },
    });
    try {
      // No package-lock.json: bun.lock is the authority, and the
      // missing optional platform package does not break consistency.
      const check = checkNodeModulesSnapshot(workdir, null, { diffFiles: ['src/index.js'] });
      assert.equal(check.status, 'consistent');
      assert.equal(check.consistent, true);
      assert.equal(check.optionalExempted, 1);
      assert.deepEqual(check.exemptedPackages, ['platform-pkg']);
    } finally {
      cleanup(workdir);
    }
  });

  test('readLockfileEntries prefers package-lock.json over bun.lock', () => {
    const root = makeTree({
      'package-lock.json': lockfile({ 'js-yaml': '4.1.0' }),
      'bun.lock': `{
        "lockfileVersion": 1,
        "workspaces": {},
        "packages": { "js-yaml": ["js-yaml@9.9.9", "", {}, "sha512-qq=="] },
      }`,
    });
    try {
      assert.equal(readLockfileEntries(root).get('js-yaml').version, '4.1.0');
    } finally {
      cleanup(root);
    }
  });

  test('listBunCachePackages reads bun .bun store dirs (scoped, hashed)', () => {
    const root = makeTree({
      'node_modules/.bun/@ai-sdk+provider@3.0.8/package.json': { name: '@ai-sdk/provider', version: '3.0.8' },
      'node_modules/.bun/typescript@7.0.2/package.json': { name: 'typescript', version: '7.0.2' },
      'node_modules/.bun/@anthropic-ai+claude-agent-sdk@0.3.306+02a3a1e1642d8bd3/package.json': { name: '@anthropic-ai/claude-agent-sdk', version: '0.3.306' },
    });
    try {
      const cache = listBunCachePackages(join(root, 'node_modules'));
      assert.deepEqual([...cache.get('@ai-sdk/provider')], ['3.0.8']);
      assert.deepEqual([...cache.get('typescript')], ['7.0.2']);
      assert.deepEqual([...cache.get('@anthropic-ai/claude-agent-sdk')], ['0.3.306']);
      assert.deepEqual(listBunCachePackages(join(makeTree({}), 'node_modules')).size, 0);
    } finally {
      cleanup(root);
    }
  });

  test('bun-installed tree: packages in .bun store count as installed', () => {
    // omo#8014: bun keeps most packages in node_modules/.bun and only
    // symlinks a subset to the top level; a top-level-only scan
    // over-reports "missing". A package present in .bun at the
    // lockfile version counts as installed; present only at another
    // version is drift, not missing.
    const bunLock = `{
      "lockfileVersion": 1,
      "workspaces": {},
      "packages": {
        "js-yaml": ["js-yaml@4.1.0", "", {}, "sha512-abc=="],
        "cached-pkg": ["cached-pkg@1.0.0", "", {}, "sha512-qq=="],
        "drifted-pkg": ["drifted-pkg@2.0.0", "", {}, "sha512-rr=="],
        "gone-pkg": ["gone-pkg@3.0.0", "", {}, "sha512-ss=="],
      },
    }`;
    const workdir = makeTree({
      'package.json': { name: 'fixture' },
      'bun.lock': bunLock,
      'node_modules/js-yaml/package.json': { name: 'js-yaml', version: '4.1.0' },
      'node_modules/.bun/cached-pkg@1.0.0/package.json': { name: 'cached-pkg', version: '1.0.0' },
      'node_modules/.bun/drifted-pkg@2.0.1/package.json': { name: 'drifted-pkg', version: '2.0.1' },
    });
    try {
      const check = checkNodeModulesSnapshot(workdir, null, { diffFiles: ['src/index.js'] });
      assert.equal(check.status, 'inconsistent');
      assert.deepEqual(check.differences, [
        'node_modules/drifted-pkg/package.json: version 2.0.1 (bun .bun store) vs 2.0.0 (lockfile)',
        'node_modules/gone-pkg: missing in replay tree (expected 3.0.0)',
      ]);
    } finally {
      cleanup(workdir);
    }
  });

  test('no package.json means there is nothing to judge', () => {
    const workdir = makeTree({ 'README.md': '# fixture\n' });
    try {
      const check = checkNodeModulesSnapshot(workdir, null, { diffFiles: [] });
      assert.equal(check.status, 'no_package_json');
      assert.equal(check.consistent, null);
    } finally {
      cleanup(workdir);
    }
  });

  test('compareNodeModulesTrees reports both directions of drift', () => {
    const a = makeTree({
      'node_modules/js-yaml/package.json': { name: 'js-yaml', version: '4.1.0' },
      'node_modules/only-replay/package.json': { name: 'only-replay', version: '1.0.0' },
    });
    const b = makeTree({
      'node_modules/js-yaml/package.json': { name: 'js-yaml', version: '4.1.1' },
      'node_modules/only-ref/package.json': { name: 'only-ref', version: '2.0.0' },
    });
    try {
      const { differences } = compareNodeModulesTrees(join(a, 'node_modules'), join(b, 'node_modules'));
      assert.deepEqual(differences, [
        'node_modules/js-yaml/package.json: version 4.1.0 (replay) vs 4.1.1 (reference)',
        'node_modules/only-ref: missing in replay tree (expected 2.0.0)',
        'node_modules/only-replay: only in replay tree (not in reference snapshot)',
      ]);
    } finally {
      cleanup(a, b);
    }
  });
});

function makeFixtureRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'evalid-audit-fixture-'));
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result;
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'audit-fixture@example.test']);
  git(['config', 'user.name', 'audit-fixture']);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', scripts: { test: 'node --test test/a.test.js' } }, null, 2));
  mkdirSync(join(repo, 'test'));
  writeFileSync(join(repo, 'src.js'), 'export const add = (a, b) => a + b;\n');
  writeFileSync(join(repo, 'test', 'a.test.js'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from '../src.js';",
    "test('adds', () => assert.equal(add(1, 2), 3));",
    "test('adds again', () => assert.equal(add(2, 2), 4));",
    '',
  ].join('\n'));
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  return { repo, git };
}

function makeSubdirFixtureRepo() {
  // Like makeFixtureRepo, but the tests live in a package subdirectory:
  // the claimed command's path is relative to packages/pkg, not the root
  // (senpi#2606 shape).
  const repo = mkdtempSync(join(tmpdir(), 'evalid-audit-fixture-'));
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result;
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'audit-fixture@example.test']);
  git(['config', 'user.name', 'audit-fixture']);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }, null, 2));
  mkdirSync(join(repo, 'packages', 'pkg', 'test'), { recursive: true });
  writeFileSync(join(repo, 'packages', 'pkg', 'src.js'), 'export const add = (a, b) => a + b;\n');
  writeFileSync(join(repo, 'packages', 'pkg', 'test', 'a.test.js'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from '../src.js';",
    "test('adds', () => assert.equal(add(1, 2), 3));",
    "test('adds again', () => assert.equal(add(2, 2), 4));",
    '',
  ].join('\n'));
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  return { repo, git };
}
function makeDiff(repo, mutate) {
  const { git } = { git: (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' }) };
  mutate();
  const diff = git(['diff']).stdout;
  git(['checkout', '--', '.']);
  return diff;
}

// Python-only fixture: stdlib unittest, no pytest needed. The diff under
// audit adds a function; the committed test file already covers it.
function makePythonFixtureRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'evalid-audit-py-'));
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result;
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'audit-fixture@example.test']);
  git(['config', 'user.name', 'audit-fixture']);
  writeFileSync(join(repo, 'calc.py'), 'def add(a, b):\n    return a + b\n');
  writeFileSync(join(repo, 'test_calc.py'), [
    'import unittest',
    'from calc import add',
    '',
    '',
    'class TestCalc(unittest.TestCase):',
    '    def test_add(self):',
    '        self.assertEqual(add(1, 2), 3)',
    '',
    '    def test_add_again(self):',
    '        self.assertEqual(add(2, 2), 4)',
    '',
    '',
    "if __name__ == '__main__':",
    '    unittest.main()',
    '',
  ].join('\n'));
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  return { repo, git };
}

describe('runAudit end-to-end on a fixture repo', () => {
  test('verified when the claimed run replays as claimed', () => {
    const { repo } = makeFixtureRepo();
    try {
      const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
      const diff = makeDiff(repo, () => {
        writeFileSync(join(repo, 'src.js'), 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n');
      });
      const report = runAudit({
        repoDir: repo,
        diffText: diff,
        baseRef: base,
        claimsText: 'Tests: `node --test test/a.test.js` — 2 tests, all pass.',
      });
      assert.equal(report.verdict, 'verified', JSON.stringify(report, null, 2));
      assert.equal(report.claims[0].replay.exit, 0);
      assert.equal(report.claims[0].replay.counts.passed, 2);
      // No I6d plugin in this repo: the gate must not apply and must not
      // change the verdict.
      assert.equal(report.i6d.applicable, false);
      assert.equal(report.i6d.reason, 'plugin_not_present');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('verified for label-first counts, and a tampered count mismatches at the exact break point (M2 slice 2, #116)', () => {
    const { repo } = makeFixtureRepo();
    try {
      const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
      const diff = makeDiff(repo, () => {
        writeFileSync(join(repo, 'src.js'), 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n');
      });
      const honest = runAudit({
        repoDir: repo,
        diffText: diff,
        baseRef: base,
        claimsText: 'Tests: `node --test test/a.test.js` — reports `pass 2`, `fail 0`.',
      });
      assert.equal(honest.verdict, 'verified', JSON.stringify(honest, null, 2));
      assert.equal(honest.claims[0].claimedPassed, 2);
      assert.equal(honest.claims[0].replay.counts.passed, 2);
      const tampered = runAudit({
        repoDir: repo,
        diffText: diff,
        baseRef: base,
        claimsText: 'Tests: `node --test test/a.test.js` — reports `pass 3`, `fail 0`.',
      });
      assert.equal(tampered.verdict, 'mismatch', JSON.stringify(tampered, null, 2));
      assert.equal(tampered.claims[0].match, false);
      assert.equal(tampered.claims[0].note, 'passed count: claimed 3, replayed 2');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('verified when the claimed command runs in a package subdirectory (M2 slice 2, #116)', () => {
    // senpi#2606 regression: the claim's path only exists under
    // packages/tui; replaying at the root used to fail with
    // "Could not find 'test/stdin-buffer.test.ts'" (false mismatch).
    const { repo } = makeSubdirFixtureRepo();
    try {
      const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
      const diff = makeDiff(repo, () => {
        writeFileSync(join(repo, 'packages', 'pkg', 'src.js'), 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n');
      });
      const report = runAudit({
        repoDir: repo,
        diffText: diff,
        baseRef: base,
        claimsText: 'Tests: `node --test test/a.test.js` — 2 tests, all pass.',
      });
      assert.equal(report.verdict, 'verified', JSON.stringify(report, null, 2));
      assert.equal(report.claims[0].cwd, 'packages/pkg');
      assert.equal(report.claims[0].replay.counts.passed, 2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('mismatch when the claimed passing run actually fails', () => {
    const { repo } = makeFixtureRepo();
    try {
      const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
      const diff = makeDiff(repo, () => {
        writeFileSync(join(repo, 'test', 'a.test.js'), [
          "import { test } from 'node:test';",
          "import assert from 'node:assert/strict';",
          "test('broken', () => assert.equal(1, 2));",
          '',
        ].join('\n'));
      });
      const report = runAudit({
        repoDir: repo,
        diffText: diff,
        baseRef: base,
        claimsText: 'Tests: `node --test test/a.test.js` — all pass.',
      });
      assert.equal(report.verdict, 'mismatch', JSON.stringify(report, null, 2));
      assert.equal(report.claims[0].match, false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('no_claims when the text states no test runs', () => {
    const { repo } = makeFixtureRepo();
    try {
      const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
      const report = runAudit({ repoDir: repo, headRef: base, claimsText: 'Docs only.' });
      assert.equal(report.verdict, 'no_claims');
      assert.equal(report.exitCode, 3);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('verified when a python -m unittest claim replays as claimed', () => {
    // Regression: swrm M2 attempt 1 — a genuine `python -m unittest` pass
    // was reported no_claims. stdlib unittest only, no pytest needed.
    const { repo } = makePythonFixtureRepo();
    try {
      const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
      const diff = makeDiff(repo, () => {
        writeFileSync(join(repo, 'calc.py'), 'def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n');
      });
      const report = runAudit({
        repoDir: repo,
        diffText: diff,
        baseRef: base,
        claimsText: 'Tests: `python3 -m unittest test_calc` — 2 tests, all pass.',
      });
      assert.equal(report.verdict, 'verified', JSON.stringify(report, null, 2));
      assert.equal(report.claims[0].command, 'python3 -m unittest test_calc');
      assert.equal(report.claims[0].replay.exit, 0);
      assert.equal(report.claims[0].replay.counts.passed, 2);
      assert.equal(report.claims[0].replay.counts.failed, 0);
      assert.equal(report.i6d.applicable, false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // --- M6 slice 1 (#132): bun test end-to-end -------------------------
  // Fixture repo whose tests run under `bun test` (bun:test imports, no
  // npm deps). The replay really runs bun in the scratch clone.
  const bunAvailable = () => spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;
  const bunMissing = () => !bunAvailable() && 'bun is not installed';

  function makeBunFixtureRepo() {
    const repo = mkdtempSync(join(tmpdir(), 'evalid-audit-bun-'));
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result;
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'audit-fixture@example.test']);
    git(['config', 'user.name', 'audit-fixture']);
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', scripts: { test: 'bun test' } }, null, 2));
    writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { '': { name: 'fixture', version: '1.0.0' } } }, null, 2));
    writeFileSync(join(repo, 'calc.ts'), 'export const add = (a, b) => a + b;\n');
    mkdirSync(join(repo, 'test'));
    writeFileSync(join(repo, 'test', 'calc.test.ts'), [
      'import { test, expect } from "bun:test";',
      "import { add } from '../calc.ts';",
      "test('adds', () => { expect(add(1, 2)).toBe(3); });",
      "test('adds again', () => { expect(add(2, 2)).toBe(4); });",
      '',
    ].join('\n'));
    git(['add', '.']);
    git(['commit', '-qm', 'base']);
    return { repo, git };
  }

  test('verified when a bun test claim replays as claimed', { skip: bunMissing() }, () => {
    const { repo } = makeBunFixtureRepo();
    try {
      const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
      const diff = makeDiff(repo, () => {
        writeFileSync(join(repo, 'calc.ts'), 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n');
      });
      const report = runAudit({
        repoDir: repo,
        diffText: diff,
        baseRef: base,
        claimsText: 'Tests: `bun test` — 2 pass, 0 fail.',
      });
      assert.equal(report.verdict, 'verified', JSON.stringify(report, null, 2));
      assert.equal(report.claims[0].command, 'bun test');
      assert.equal(report.claims[0].replay.exit, 0);
      assert.equal(report.claims[0].replay.counts.passed, 2);
      assert.equal(report.claims[0].replay.counts.failed, 0);
      assert.equal(report.claims[0].replay.counts.total, 2);
      // Zero-dep lockfile: the installed tree matches it exactly.
      assert.equal(report.nodeModules.status, 'consistent');
      assert.equal(report.nodeModules.consistent, true);
      assert.deepEqual(report.nodeModules.differences, []);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('mismatch when a bun test claim overstates the pass count', { skip: bunMissing() }, () => {
    const { repo } = makeBunFixtureRepo();
    try {
      const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
      const diff = makeDiff(repo, () => {
        writeFileSync(join(repo, 'calc.ts'), 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n');
      });
      const report = runAudit({
        repoDir: repo,
        diffText: diff,
        baseRef: base,
        claimsText: 'Tests: `bun test` — 3 pass, 0 fail.',
      });
      assert.equal(report.verdict, 'mismatch', JSON.stringify(report, null, 2));
      assert.equal(report.claims[0].match, false);
      assert.equal(report.claims[0].note, 'passed count: claimed 3, replayed 2');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('mismatch when the bun test actually fails on replay', { skip: bunMissing() }, () => {
    const { repo } = makeBunFixtureRepo();
    try {
      const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
      const diff = makeDiff(repo, () => {
        writeFileSync(join(repo, 'calc.ts'), 'export const add = (a, b) => a - b;\n');
      });
      const report = runAudit({
        repoDir: repo,
        diffText: diff,
        baseRef: base,
        claimsText: 'Tests: `bun test` — 2 pass, 0 fail.',
      });
      assert.equal(report.verdict, 'mismatch', JSON.stringify(report, null, 2));
      assert.equal(report.claims[0].match, false);
      assert.equal(report.claims[0].replay.exit, 1);
      assert.equal(report.claims[0].replay.counts.passed, 0);
      assert.equal(report.claims[0].replay.counts.failed, 2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('xflow audit CLI positional form (M2 slice 1, #114)', () => {
  function runCli(cwd, args) {
    return spawnSync(process.execPath, [join(repoRoot, 'bin', 'xflow.js'), 'audit', ...args], { cwd, encoding: 'utf8' });
  }

  function repoState(repo) {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout;
    return { head, status };
  }

  test('positional diff file audits verified and leaves the target repo untouched', () => {
    const { repo } = makeFixtureRepo();
    const dir = mkdtempSync(join(tmpdir(), 'evalid-audit-cli-'));
    try {
      const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
      const diff = makeDiff(repo, () => {
        writeFileSync(join(repo, 'src.js'), 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n');
      });
      const diffPath = join(dir, 'change.patch');
      const claimsPath = join(dir, 'claims.txt');
      writeFileSync(diffPath, diff);
      writeFileSync(claimsPath, 'Tests: `node --test test/a.test.js` — 2 tests, all pass.');
      const before = repoState(repo);
      const result = runCli(repo, [diffPath, '--base', base, '--claims-file', claimsPath, '--json']);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.verdict, 'verified');
      assert.equal(report.claims[0].replay.counts.passed, 2);
      // Read-only: audit clones to a scratch dir; the target repo must be
      // byte-identical afterwards (same HEAD, clean status).
      assert.deepEqual(repoState(repo), before);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('human summary prints the verdict without --json', () => {
    const { repo } = makeFixtureRepo();
    const dir = mkdtempSync(join(tmpdir(), 'evalid-audit-cli-'));
    try {
      const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
      const diff = makeDiff(repo, () => {
        writeFileSync(join(repo, 'src.js'), 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n');
      });
      const diffPath = join(dir, 'change.patch');
      writeFileSync(diffPath, diff);
      const result = runCli(repo, [diffPath, '--base', base, '--claims', 'Tests: `node --test test/a.test.js` — 2 tests, all pass.']);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /xflow audit: verified/);
      assert.match(result.stdout, /node --test test\/a\.test\.js/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('tampered claim: inflated pass count fails with the exact breaking point', () => {
    const { repo } = makeFixtureRepo();
    const dir = mkdtempSync(join(tmpdir(), 'evalid-audit-cli-'));
    try {
      const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
      const diff = makeDiff(repo, () => {
        writeFileSync(join(repo, 'src.js'), 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n');
      });
      const diffPath = join(dir, 'change.patch');
      writeFileSync(diffPath, diff);
      // The fixture has 2 tests; the claim says 3 passed. The replay
      // really passes 2, so the verdict must be mismatch naming the count.
      const result = runCli(repo, [diffPath, '--base', base, '--claims', 'Tests: `node --test test/a.test.js` — 3 tests, all pass.', '--json']);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.verdict, 'mismatch');
      assert.equal(report.claims[0].match, false);
      assert.match(report.claims[0].note, /passed count: claimed 3, replayed 2/);
      assert.match(renderAuditReport(report), /mismatch/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unrecognised positional target is misuse (exit 2), not a verdict', () => {
    const { repo } = makeFixtureRepo();
    try {
      const result = runCli(repo, ['hello']);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /cannot tell whether 'hello' is a diff file or a PR/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('positional target conflicts with --pr / --diff (exit 2)', () => {
    const { repo } = makeFixtureRepo();
    try {
      const result = runCli(repo, ['change.patch', '--diff', 'other.patch']);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /conflicts with --pr \/ --diff/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('runAudit with a broken evalid seal (M2 slice 1, #114)', () => {
  // Fixture repo carrying the i6b seal validator (copied from this repo).
  // The diff under audit adds a seal file whose JSON is not a valid proof.
  function makeSealFixtureRepo() {
    const repo = mkdtempSync(join(tmpdir(), 'evalid-audit-seal-'));
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result;
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'audit-fixture@example.test']);
    git(['config', 'user.name', 'audit-fixture']);
    mkdirSync(join(repo, 'xflow', 'atoms'), { recursive: true });
    copyFileSync(
      join(repoRoot, 'xflow', 'atoms', 'i6b_tdd_proof_validate.py'),
      join(repo, 'xflow', 'atoms', 'i6b_tdd_proof_validate.py'),
    );
    copyFileSync(
      join(repoRoot, 'xflow', 'atoms', 'tdd_lib.py'),
      join(repo, 'xflow', 'atoms', 'tdd_lib.py'),
    );
    writeFileSync(join(repo, 'README.md'), '# fixture\n');
    git(['add', '.']);
    git(['commit', '-qm', 'base']);
    return { repo, git };
  }

  test('a seal file that is not a valid proof fails with the seal named', () => {
    const { repo } = makeSealFixtureRepo();
    try {
      const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
      const diff = makeDiff(repo, () => {
        mkdirSync(join(repo, 'specs', 'changes', 'demo-change', 'tdd'), { recursive: true });
        // Claims a green proof but carries none of the required fields
        // (phase, attempt, command, exit_code, passed, recorded_at).
        writeFileSync(join(repo, 'specs', 'changes', 'demo-change', 'tdd', 'green-0.json'), '{}\n');
        // New file: intent-to-add so `git diff` in makeDiff includes it.
        spawnSync('git', ['add', '-N', 'specs/changes/demo-change/tdd/green-0.json'], { cwd: repo, encoding: 'utf8' });
      });
      const report = runAudit({
        repoDir: repo,
        diffText: diff,
        baseRef: base,
        claimsText: 'Docs only, no test claims.',
      });
      assert.equal(report.verdict, 'mismatch', JSON.stringify(report, null, 2));
      assert.equal(report.exitCode, 1);
      assert.equal(report.seals.length, 1);
      assert.equal(report.seals[0].ok, false);
      assert.equal(report.seals[0].changeId, 'demo-change');
      assert.equal(report.seals[0].phase, 'green');
      assert.equal(report.seals[0].attempt, 0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('runAudit with the I6d assertion-execution gate (M3 slice 3)', () => {
  const PYTEST_BASE = [
    'def test_normal():',
    '    assert 1 + 1 == 2',
    '',
  ].join('\n');

  const PYTEST_DEAD = [
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
  ].join('\n');

  const PYTEST_GREEN = [
    'def test_normal():',
    '    assert 1 + 1 == 2',
    '',
    '',
    'def test_new_ok():',
    '    assert 2 + 2 == 4',
    '',
  ].join('\n');

  // Fixture repo that carries the I6d plugin (copied from this repo) and
  // one committed Python test file. The diff under audit adds to it.
  function makePytestFixtureRepo() {
    const repo = mkdtempSync(join(tmpdir(), 'evalid-audit-i6d-'));
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result;
    };
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'audit-fixture@example.test']);
    git(['config', 'user.name', 'audit-fixture']);
    mkdirSync(join(repo, 'xflow', 'atoms'), { recursive: true });
    copyFileSync(
      join(repoRoot, 'xflow', 'atoms', 'i6d_assertion_execution.py'),
      join(repo, 'xflow', 'atoms', 'i6d_assertion_execution.py'),
    );
    writeFileSync(join(repo, 'test_dead.py'), PYTEST_BASE);
    git(['add', '.']);
    git(['commit', '-qm', 'base']);
    return { repo, git };
  }

  const live = () => ensurePytestPython() === null && 'pytest unavailable and venv install failed';

  // The claimed replay spawns bare `pytest` from PATH; the venv python
  // that has pytest is not on PATH, so prepend its bin dir while the
  // audit runs (the I6d gate itself gets the venv python explicitly).
  function withPytestOnPath(fn) {
    const binDir = dirname(ensurePytestPython());
    const prev = process.env.PATH;
    process.env.PATH = `${binDir}:${prev}`;
    try {
      return fn();
    } finally {
      process.env.PATH = prev;
    }
  }

  test('isPythonTestFile matches pytest default collection names', () => {
    assert.equal(isPythonTestFile('test_calc.py'), true);
    assert.equal(isPythonTestFile('tests/test_calc.py'), true);
    assert.equal(isPythonTestFile('calc_test.py'), true);
    assert.equal(isPythonTestFile('src/calc.py'), false);
    assert.equal(isPythonTestFile('test_calc.js'), false);
    assert.equal(isPythonTestFile('tests/helpers.py'), false);
  });

  test('mismatch when the replay is green but an in-diff assert never executed', { skip: live() }, () => {
    const { repo } = makePytestFixtureRepo();
    try {
      const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
      const diff = makeDiff(repo, () => {
        writeFileSync(join(repo, 'test_dead.py'), PYTEST_DEAD);
      });
      const report = withPytestOnPath(() => runAudit({
        repoDir: repo,
        diffText: diff,
        baseRef: base,
        claimsText: 'Tests: `pytest test_dead.py` — 2 tests, all pass.',
        python: ensurePytestPython(),
      }));
      // The claimed pytest run really passes on replay -- the gate, not
      // the replay, is what flips this to mismatch.
      assert.equal(report.claims[0].match, true, JSON.stringify(report, null, 2));
      assert.equal(report.i6d.applicable, true);
      assert.equal(report.i6d.verdict, 'unexecuted_assertions');
      assert.equal(report.i6d.unexecuted.length, 1);
      assert.equal(report.i6d.unexecuted[0].line, 3);
      assert.match(report.i6d.unexecuted[0].source, /assert value == 42/);
      assert.equal(report.verdict, 'mismatch', JSON.stringify(report, null, 2));
      assert.equal(report.exitCode, 1);
      assert.equal(report.ok, false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('verified when the diff adds only executed assertions', { skip: live() }, () => {
    const { repo } = makePytestFixtureRepo();
    try {
      const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
      const diff = makeDiff(repo, () => {
        writeFileSync(join(repo, 'test_dead.py'), PYTEST_GREEN);
      });
      const report = withPytestOnPath(() => runAudit({
        repoDir: repo,
        diffText: diff,
        baseRef: base,
        claimsText: 'Tests: `pytest test_dead.py` — 2 tests, all pass.',
        python: ensurePytestPython(),
      }));
      assert.equal(report.verdict, 'verified', JSON.stringify(report, null, 2));
      assert.equal(report.i6d.applicable, true);
      assert.equal(report.i6d.verdict, 'pass');
      assert.deepEqual(report.i6d.unexecuted, []);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('--no-i6d leaves a green replay verified even with a dead assert', { skip: live() }, () => {
    const { repo } = makePytestFixtureRepo();
    try {
      const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
      const diff = makeDiff(repo, () => {
        writeFileSync(join(repo, 'test_dead.py'), PYTEST_DEAD);
      });
      const report = withPytestOnPath(() => runAudit({
        repoDir: repo,
        diffText: diff,
        baseRef: base,
        claimsText: 'Tests: `pytest test_dead.py` — 2 tests, all pass.',
        python: ensurePytestPython(),
        i6d: false,
      }));
      assert.equal(report.verdict, 'verified', JSON.stringify(report, null, 2));
      assert.equal(report.i6d.applicable, false);
      assert.equal(report.i6d.reason, 'disabled');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // --- M3 slice 1 (#120): the JS half of the I6d gate ---------------

  const JS_BASE = [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    '',
    "test('normal', () => {",
    '  assert.equal(1 + 1, 2);',
    '});',
  ].join('\n');

  const JS_DEAD = [
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
    "test('normal', () => {",
    '  assert.equal(1 + 1, 2);',
    '});',
  ].join('\n');

  const JS_GREEN = [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    '',
    "test('normal', () => {",
    '  assert.equal(1 + 1, 2);',
    '});',
    '',
    "test('new ok', () => {",
    '  assert.equal(2 + 2, 4);',
    '});',
  ].join('\n');

  // Fixture repo that carries both I6d halves (copied from this repo) and
  // one committed JS test file. The diff under audit adds to it. No
  // pytest is needed: a JS-only diff is judged by the node half alone.
  function makeJsFixtureRepo() {
    const repo = mkdtempSync(join(tmpdir(), 'evalid-audit-i6d-js-'));
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result;
    };
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'audit-fixture@example.test']);
    git(['config', 'user.name', 'audit-fixture']);
    mkdirSync(join(repo, 'xflow', 'atoms'), { recursive: true });
    copyFileSync(
      join(repoRoot, 'xflow', 'atoms', 'i6d_assertion_execution.py'),
      join(repo, 'xflow', 'atoms', 'i6d_assertion_execution.py'),
    );
    copyFileSync(
      join(repoRoot, 'xflow', 'atoms', 'i6d_assertion_execution_js.js'),
      join(repo, 'xflow', 'atoms', 'i6d_assertion_execution_js.js'),
    );
    writeFileSync(join(repo, 'test_dead.test.js'), JS_BASE);
    git(['add', '.']);
    git(['commit', '-qm', 'base']);
    return { repo, git };
  }

  test('isJavaScriptTestFile matches node:test default collection names', () => {
    assert.equal(isJavaScriptTestFile('test_calc.test.js'), true);
    assert.equal(isJavaScriptTestFile('test/test_calc.test.mjs'), true);
    assert.equal(isJavaScriptTestFile('test-calc.js'), true);
    assert.equal(isJavaScriptTestFile('src/calc.js'), false);
    assert.equal(isJavaScriptTestFile('test_calc.js'), false);
    assert.equal(isJavaScriptTestFile('test_calc.test.py'), false);
  });

  test('mismatch when the replay is green but an in-diff JS assert never executed', () => {
    const { repo } = makeJsFixtureRepo();
    try {
      const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
      const diff = makeDiff(repo, () => {
        writeFileSync(join(repo, 'test_dead.test.js'), JS_DEAD);
      });
      const report = runAudit({
        repoDir: repo,
        diffText: diff,
        baseRef: base,
        claimsText: 'Tests: `node --test test_dead.test.js` — 2 tests, all pass.',
        python,
      });
      // The claimed node run really passes on replay -- the gate, not
      // the replay, is what flips this to mismatch.
      assert.equal(report.claims[0].match, true, JSON.stringify(report, null, 2));
      assert.equal(report.i6d.applicable, true);
      assert.equal(report.i6d.verdict, 'unexecuted_assertions');
      assert.equal(report.i6d.unexecuted.length, 1);
      assert.equal(report.i6d.unexecuted[0].line, 6);
      assert.match(report.i6d.unexecuted[0].source, /assert\.equal\(value, 42\)/);
      assert.equal(report.verdict, 'mismatch', JSON.stringify(report, null, 2));
      assert.equal(report.exitCode, 1);
      assert.equal(report.ok, false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('verified when the JS diff adds only executed assertions', () => {
    const { repo } = makeJsFixtureRepo();
    try {
      const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
      const diff = makeDiff(repo, () => {
        writeFileSync(join(repo, 'test_dead.test.js'), JS_GREEN);
      });
      const report = runAudit({
        repoDir: repo,
        diffText: diff,
        baseRef: base,
        claimsText: 'Tests: `node --test test_dead.test.js` — 2 tests, all pass.',
        python,
      });
      assert.equal(report.verdict, 'verified', JSON.stringify(report, null, 2));
      assert.equal(report.i6d.applicable, true);
      assert.equal(report.i6d.verdict, 'pass');
      assert.deepEqual(report.i6d.unexecuted, []);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
