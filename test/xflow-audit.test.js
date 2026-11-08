import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  extractClaims,
  parseClaimCounts,
  parseDiffFiles,
  parseReplayCounts,
  runAudit,
} from '../src/core/audit.js';

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
});
