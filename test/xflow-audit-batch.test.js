import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  auditOnePR,
  batchExitCode,
  countAuditTotals,
  listMergedPRs,
  parseBatchRepo,
  renderBatchReport,
  resolveBatchRepo,
  runBatchAudit,
  summarizeBatch,
} from '../src/core/audit-batch.js';

const repoRoot = resolve(import.meta.dirname, '..');

function ghListResult(prs) {
  return { status: 0, stdout: JSON.stringify(prs), stderr: '' };
}

const CANNED_PRS = [
  { number: 12, title: 'fix one', mergedAt: '2026-11-11T10:00:00Z', mergeCommit: { oid: 'aaa' }, headRefOid: 'aaa', baseRefOid: '000', body: '`node --test test/a.test.js`, exit 0.' },
  { number: 13, title: 'fix two', mergedAt: '2026-11-10T10:00:00Z', mergeCommit: { oid: 'bbb' }, headRefOid: 'bbb', baseRefOid: '000', body: 'No tests.' },
  { number: 14, title: 'old fix', mergedAt: '2026-11-01T10:00:00Z', mergeCommit: { oid: 'ccc' }, headRefOid: 'ccc', baseRefOid: '000', body: '' },
];

describe('listMergedPRs (enumeration)', () => {
  test('normalizes gh pr list output and asks for merged PRs only', () => {
    let seenArgs = null;
    const runGh = (args) => { seenArgs = args; return ghListResult(CANNED_PRS); };
    const prs = listMergedPRs('surlymochan/evalid', { limit: 5, runGh });
    assert.equal(prs.length, 3);
    assert.equal(prs[0].number, 12);
    assert.equal(prs[0].mergeCommitOid, 'aaa');
    assert.equal(prs[0].body, '`node --test test/a.test.js`, exit 0.');
    assert.ok(seenArgs.includes('--state') && seenArgs.includes('merged'));
    assert.ok(seenArgs.includes('--limit') && seenArgs.includes('5'));
  });

  test('--since filters client-side on mergedAt', () => {
    const prs = listMergedPRs('surlymochan/evalid', {
      since: '2026-11-10',
      runGh: () => ghListResult(CANNED_PRS),
    });
    assert.deepEqual(prs.map((pr) => pr.number), [12, 13]);
  });

  test('gh failure and unparsable output throw with the gh stderr', () => {
    assert.throws(
      () => listMergedPRs('surlymochan/evalid', { runGh: () => ({ status: 1, stdout: '', stderr: 'HTTP 403' }) }),
      /gh pr list failed: HTTP 403/,
    );
    assert.throws(
      () => listMergedPRs('surlymochan/evalid', { runGh: () => ({ status: 0, stdout: 'not json', stderr: '' }) }),
      /unparsable JSON/,
    );
  });
});

describe('parseBatchRepo / resolveBatchRepo', () => {
  test('an existing directory is a path repo, owner/repo is a slug', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evalid-batch-repo-'));
    try {
      assert.equal(parseBatchRepo(dir).kind, 'path');
      assert.equal(parseBatchRepo('surlymochan/evalid').kind, 'slug');
      assert.throws(() => parseBatchRepo(''), /a repo is required/);
      assert.throws(() => parseBatchRepo('no-such-thing'), /repo not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a local path resolves its slug from the origin remote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evalid-batch-repo-'));
    try {
      const resolved = resolveBatchRepo({ kind: 'path', repo: dir }, {
        runGit: () => ({ status: 0, stdout: 'https://github.com/surlymochan/evalid.git\n', stderr: '' }),
      });
      assert.equal(resolved.slug, 'surlymochan/evalid');
      assert.equal(resolved.repoDir, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('countAuditTotals / summarizeBatch / renderBatchReport', () => {
  test('counts sum claimed and replayed passes/fails, nulls stay null', () => {
    const totals = countAuditTotals({
      claims: [
        { claimedPassed: 5, claimedFailed: 1, replay: { counts: { passed: 5, failed: 1 } } },
        { claimedPassed: null, claimedFailed: null, replay: { counts: { passed: null, failed: null } } },
      ],
    });
    assert.deepEqual(totals, {
      claimed: { passed: 5, failed: 1 },
      replayed: { passed: 5, failed: 1 },
    });
    assert.deepEqual(countAuditTotals({ claims: [] }), {
      claimed: { passed: null, failed: null },
      replayed: { passed: null, failed: null },
    });
  });

  test('summary counts each verdict and discrepancy rate is mismatch/total', () => {
    const rows = [
      { verdict: 'verified' }, { verdict: 'verified' },
      { verdict: 'mismatch' }, { verdict: 'no_claims' },
      { verdict: 'unverifiable' }, { verdict: 'error' },
    ];
    const summary = summarizeBatch(rows);
    assert.deepEqual(summary, {
      total: 6, verified: 2, mismatch: 1, no_claims: 1, unverifiable: 1, error: 1,
      discrepancy_rate: 0.1667,
    });
    assert.equal(summarizeBatch([]).discrepancy_rate, 0);
    assert.equal(batchExitCode(summary), 1);
    assert.equal(batchExitCode(summarizeBatch([{ verdict: 'verified' }])), 0);
    assert.equal(batchExitCode(summarizeBatch([{ verdict: 'no_claims' }])), 3);
    assert.equal(batchExitCode(summarizeBatch([])), 0);
  });

  test('table lists one row per PR plus the summary line', () => {
    const batch = {
      slug: 'surlymochan/evalid',
      since: '2026-11-10',
      limit: 20,
      rows: [
        { pr: 12, title: 'fix one', verdict: 'verified', claimed: { passed: 5, failed: 0 }, replayed: { passed: 5, failed: 0 }, error: null, retried: false },
        { pr: 13, title: 'fix two', verdict: 'mismatch', claimed: { passed: 3, failed: 0 }, replayed: { passed: 2, failed: 1 }, error: null, retried: true },
        { pr: 14, title: 'boom', verdict: 'error', claimed: { passed: null, failed: null }, replayed: { passed: null, failed: null }, error: 'gh pr diff 14 failed', retried: false },
      ],
      summary: { total: 3, verified: 1, mismatch: 1, no_claims: 0, unverifiable: 0, error: 1, discrepancy_rate: 0.3333 },
      durationMs: 1234,
    };
    const text = renderBatchReport(batch);
    assert.match(text, /#12\s+verified\s+5 passed \/ 0 failed\s+5 passed \/ 0 failed\s+fix one/);
    assert.match(text, /#13\s+mismatch\s+3 passed \/ 0 failed\s+2 passed \/ 1 failed\s+fix two \(retried once\)/);
    assert.match(text, /#14\s+error.*boom — gh pr diff 14 failed/);
    assert.match(text, /summary: 3 PRs — verified 1, mismatch 1, no_claims 0, unverifiable 0, error 1; discrepancy rate 0\.3333/);
    assert.equal(renderBatchReport({ ...batch, rows: [], summary: summarizeBatch([]) }).includes('no merged PRs in window'), true);
  });
});

describe('auditOnePR (single-PR reuse + failure isolation + retry)', () => {
  const base = { repoDir: '/tmp/repo', slug: 'surlymochan/evalid', fetchDiff: async () => 'diff' };

  test('a verified audit becomes a row with claimed/replayed counts', async () => {
    const auditOne = async () => ({
      verdict: 'verified',
      claims: [{ claimedPassed: 4, claimedFailed: 0, replay: { counts: { passed: 4, failed: 0 } } }],
      durationMs: 10,
    });
    const row = await auditOnePR(CANNED_PRS[0], { ...base, auditOne });
    assert.equal(row.pr, 12);
    assert.equal(row.verdict, 'verified');
    assert.deepEqual(row.claimed, { passed: 4, failed: 0 });
    assert.deepEqual(row.replayed, { passed: 4, failed: 0 });
    assert.equal(row.retried, false);
  });

  test('a mismatch is retried once and the retry verdict settles the row', async () => {
    let calls = 0;
    const auditOne = async () => {
      calls += 1;
      return calls === 1
        ? { verdict: 'mismatch', claims: [{ claimedPassed: 1, claimedFailed: 0, replay: { counts: { passed: 0, failed: 1 } } }] }
        : { verdict: 'verified', claims: [{ claimedPassed: 1, claimedFailed: 0, replay: { counts: { passed: 1, failed: 0 } } }] };
    };
    const row = await auditOnePR(CANNED_PRS[0], { ...base, auditOne });
    assert.equal(calls, 2);
    assert.equal(row.verdict, 'verified');
    assert.equal(row.retried, true);
    assert.equal(row.attempts.length, 2);
    assert.equal(row.attempts[0].verdict, 'mismatch');
    assert.equal(row.attempts[1].verdict, 'verified');
  });

  test('a mismatch that survives the retry stays a mismatch after exactly 2 runs', async () => {
    let calls = 0;
    const auditOne = async () => {
      calls += 1;
      return { verdict: 'mismatch', claims: [{ claimedPassed: 1, claimedFailed: 0, replay: { counts: { passed: 0, failed: 1 } } }] };
    };
    const row = await auditOnePR(CANNED_PRS[0], { ...base, auditOne });
    assert.equal(calls, 2);
    assert.equal(row.verdict, 'mismatch');
    assert.equal(row.retried, true);
  });

  test('a throw from the audit step is recorded as error, not raised', async () => {
    const auditOne = async () => { throw new Error('replay exploded'); };
    const row = await auditOnePR(CANNED_PRS[0], { ...base, auditOne });
    assert.equal(row.verdict, 'error');
    assert.match(row.error, /replay exploded/);
    assert.equal(row.retried, false);
  });

  test('a diff-fetch failure is recorded as error', async () => {
    const row = await auditOnePR(CANNED_PRS[0], {
      ...base,
      fetchDiff: async () => { throw new Error('gh pr diff 12 failed: 404'); },
    });
    assert.equal(row.verdict, 'error');
    assert.match(row.error, /gh pr diff 12 failed/);
  });
});

describe('runBatchAudit (batch orchestration)', () => {
  test('a failing PR does not stop the batch; summary counts it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evalid-batch-repo-'));
    try {
      const batch = await runBatchAudit(dir, {
        runGh: (args) => (args[1] === 'list' ? ghListResult(CANNED_PRS.slice(0, 2)) : { status: 0, stdout: '', stderr: '' }),
        runGit: () => ({ status: 0, stdout: 'git@github.com:surlymochan/evalid.git\n', stderr: '' }),
        fetchDiff: async () => '',
        auditOne: async (opts) => {
          if (opts.claimsText.includes('node --test')) {
            return { verdict: 'verified', claims: [{ claimedPassed: null, claimedFailed: null, replay: { counts: { passed: 1, failed: 0 } } }] };
          }
          throw new Error('boom');
        },
      });
      assert.equal(batch.slug, 'surlymochan/evalid');
      assert.equal(batch.rows.length, 2);
      assert.equal(batch.rows[0].verdict, 'verified');
      assert.equal(batch.rows[1].verdict, 'error');
      assert.deepEqual(batch.summary, {
        total: 2, verified: 1, mismatch: 0, no_claims: 0, unverifiable: 0, error: 1,
        discrepancy_rate: 0,
      });
      assert.equal(batch.exitCode, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CLI: xflow audit --batch (fake gh + real single-PR replay)', () => {
  test('enumerates via gh, reuses runAudit per PR, writes --out JSON', { timeout: 120000 }, () => {
    const workdir = mkdtempSync(join(tmpdir(), 'evalid-batch-cli-'));
    const binDir = join(workdir, 'bin');
    const repoDir = join(workdir, 'repo');
    try {
      // Minimal local repo: one passing node test at HEAD.
      const git = (args, cwd = repoDir) => spawnSync('git', args, { cwd, encoding: 'utf8' });
      spawnSync('git', ['init', '-q', repoDir], { encoding: 'utf8' });
      git(['config', 'user.email', 'test@example.com']);
      git(['config', 'user.name', 'Test']);
      mkdirSync(join(repoDir, 'test'), { recursive: true });
      writeFileSync(join(repoDir, 'test', 'a.test.js'), "import { test } from 'node:test';\ntest('ok', () => {});\n");
      git(['add', '.']);
      git(['commit', '-qm', 'add passing test']);
      git(['remote', 'add', 'origin', 'https://github.com/surlymochan/evalid.git']);
      const head = git(['rev-parse', 'HEAD']).stdout.trim();

      // Fake gh: pr list returns two PRs at HEAD (one with a claim, one
      // without); pr diff returns an empty diff.
      const prJson = JSON.stringify([
        { number: 101, title: 'passing change', mergedAt: '2026-11-12T00:00:00Z', mergeCommit: { oid: head }, headRefOid: head, baseRefOid: head, body: '`node --test test/a.test.js`, exit 0.' },
        { number: 102, title: 'docs only', mergedAt: '2026-11-12T00:00:00Z', mergeCommit: { oid: head }, headRefOid: head, baseRefOid: head, body: 'Docs tweak, no tests.' },
      ]);
      mkdirSync(binDir, { recursive: true });
      const fakeGh = join(binDir, 'gh');
      writeFileSync(fakeGh, `#!/bin/sh\nif [ "$1" = "pr" ] && [ "$2" = "list" ]; then printf '%s' "$PR_JSON"; exit 0; fi\nif [ "$1" = "pr" ] && [ "$2" = "diff" ]; then printf ''; exit 0; fi\necho "unexpected gh call: $*" >&2; exit 1\n`);
      chmodSync(fakeGh, 0o755);

      const outFile = join(workdir, 'batch.json');
      const result = spawnSync(process.execPath, [
        join(repoRoot, 'bin', 'xflow.js'), 'audit', '--batch', '.',
        '--since', '2026-11-11', '--limit', '5', '--out', outFile,
      ], {
        cwd: repoDir,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, PR_JSON: prJson },
      });
      assert.equal(result.status, 0, `CLI failed: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /#101\s+verified/);
      assert.match(result.stdout, /#102\s+no_claims/);
      assert.match(result.stdout, /summary: 2 PRs — verified 1, mismatch 0, no_claims 1, unverifiable 0, error 0; discrepancy rate 0/);
      assert.ok(existsSync(outFile), '--out JSON was not written');
      const written = JSON.parse(readFileSync(outFile, 'utf8'));
      assert.equal(written.rows.length, 2);
      assert.equal(written.summary.total, 2);
      assert.equal(written.rows[0].replayed.passed, 1);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
