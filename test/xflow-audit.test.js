import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  extractClaims,
  isPythonTestFile,
  parseAuditTarget,
  parseClaimCounts,
  parseDiffFiles,
  parseReplayCounts,
  renderAuditReport,
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
});
