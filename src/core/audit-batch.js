/**
 * xflow audit --batch — batch audit of merged PRs in a window (M12, #171/#172).
 *
 * One row per merged PR: the existing single-PR audit (runAudit in
 * ./audit.js — claim extraction + sealed replay + verdict) is reused
 * unchanged, never reimplemented. A single PR's replay failure never
 * aborts the batch: the row records verdict 'error' (harness failure)
 * or 'unverifiable' (runAudit's own verdict) with the reason, and the
 * batch continues with the next PR.
 *
 * Enumeration choice — gh API, not local git log (issue #172 requires
 * the choice and its reasons to be recorded):
 *   1. The PR body is the claims source, and git log does not carry it;
 *      any git-log enumeration would still need one gh call per PR.
 *   2. Merge commits are not a complete enumeration: squash merges
 *      produce no merge commit ("title (#N)" subjects) and rebase
 *      merges produce none at all, so `git log --merges` silently
 *      drops merged PRs. `gh pr list --state merged` is the only
 *      complete source.
 *   3. mergedAt gives an exact window filter; git log dates are
 *      committer dates and do not say when a PR merged.
 * The trade-off is explicit: --batch needs `gh` authenticated for the
 * target repo, and enumeration is capped by --limit (default 20) before
 * the --since filter is applied client-side.
 *
 * Retry policy (#169 flake): a mismatch is re-run once before the
 * verdict is settled, because a single timing-sensitive test can flake
 * in replay. Both attempts are recorded on the row (`attempts`,
 * `retried`); the retry's verdict is final. A mismatch that survives
 * the retry stays a mismatch.
 *
 * Discrepancy rate: mismatch rows / total rows (0 when the batch is
 * empty). It is the share of enumerated PRs whose replay contradicts
 * the claim — no_claims and unverifiable rows are in the denominator,
 * so the rate never hides an inconclusive batch.
 *
 * Exit codes mirror the single-PR audit: 0 no mismatch / unverifiable /
 * error, 1 any mismatch / unverifiable / error, 3 every row no_claims
 * (inconclusive, not a failure of the changes). An empty window exits 0.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runAudit } from './audit.js';

export const BATCH_VERDICTS = ['verified', 'mismatch', 'no_claims', 'unverifiable', 'error'];

export const DEFAULT_BATCH_LIMIT = 20;

/** Default gh runner: spawnSync, returning { status, stdout, stderr }. */
export function defaultGhRunner(args, options = {}) {
  return spawnSync('gh', args, { encoding: 'utf8', ...options });
}

/**
 * Parse the <repo> argument: a local directory path or an owner/repo slug.
 * Returns { kind: 'path' | 'slug', repo, slug? }.
 */
export function parseBatchRepo(arg) {
  const value = String(arg || '').trim();
  if (!value) throw new Error('a repo is required: a local path or owner/repo');
  // A local directory wins over a same-shaped slug.
  if (existsSync(resolve(value))) return { kind: 'path', repo: value };
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return { kind: 'slug', repo: value, slug: value };
  throw new Error(`repo not found: ${value} (expected a local path or owner/repo)`);
}

/**
 * Resolve a parsed repo into { repoDir, slug, tempDir }.
 * - Local path: repoDir is the path; the owner/repo slug is read from
 *   the origin remote so gh can enumerate its PRs.
 * - Slug: the repo is cloned with `gh repo clone` into a temp dir,
 *   which runAudit then clones locally per PR (same as a local path).
 */
export function resolveBatchRepo(parsed, options = {}) {
  const runGh = options.runGh || defaultGhRunner;
  const runGit = options.runGit || ((args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' }));
  if (parsed.kind === 'slug') {
    const tempDir = mkdtempSync(join(tmpdir(), 'evalid-audit-batch-'));
    const clone = runGh(['repo', 'clone', parsed.slug, tempDir]);
    if (clone.status !== 0) {
      throw new Error(`gh repo clone ${parsed.slug} failed: ${(clone.stderr || clone.stdout || '').trim().slice(-300)}`);
    }
    return { repoDir: tempDir, slug: parsed.slug, tempDir };
  }
  const repoDir = resolve(parsed.repo);
  const remote = runGit(['remote', 'get-url', 'origin'], repoDir);
  const url = (remote.stdout || '').trim();
  const match = url.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  if (!match) {
    throw new Error(`cannot determine owner/repo for ${repoDir}: origin remote is not a github.com URL (${url || 'no origin remote'})`);
  }
  return { repoDir, slug: match[1], tempDir: null };
}

/**
 * Enumerate merged PRs via `gh pr list --state merged`, newest first.
 * Returns [{ number, title, mergedAt, mergeCommitOid, headRefOid,
 * baseRefOid, body }]. --since filters client-side on mergedAt (the gh
 * search index can lag, so no server-side date filter is trusted);
 * --limit caps how many merged PRs gh returns before that filter.
 */
export function listMergedPRs(slug, options = {}) {
  const { since = null, limit = DEFAULT_BATCH_LIMIT, runGh = defaultGhRunner } = options;
  const args = [
    'pr', 'list', '--repo', slug, '--state', 'merged',
    '--limit', String(limit),
    '--json', 'number,title,mergedAt,mergeCommit,headRefOid,baseRefOid,body',
  ];
  const result = runGh(args);
  if (result.status !== 0) {
    throw new Error(`gh pr list failed: ${(result.stderr || result.stdout || '').trim().slice(-300)}`);
  }
  let prs;
  try {
    prs = JSON.parse(result.stdout || '[]');
  } catch {
    throw new Error('gh pr list returned unparsable JSON');
  }
  const sinceMs = since ? Date.parse(`${since}T00:00:00.000Z`) : null;
  return prs
    .filter((pr) => pr && typeof pr.number === 'number')
    .filter((pr) => sinceMs === null || (pr.mergedAt && Date.parse(pr.mergedAt) >= sinceMs))
    .map((pr) => ({
      number: pr.number,
      title: pr.title || '',
      mergedAt: pr.mergedAt || null,
      mergeCommitOid: pr.mergeCommit?.oid || null,
      headRefOid: pr.headRefOid || null,
      baseRefOid: pr.baseRefOid || null,
      body: pr.body || '',
    }));
}

/** Sum claimed / replayed pass/fail counts out of a single-PR report. */
export function countAuditTotals(report) {
  const claimed = { passed: null, failed: null };
  const replayed = { passed: null, failed: null };
  for (const claim of report?.claims || []) {
    if (claim.claimedPassed !== null && claim.claimedPassed !== undefined) {
      claimed.passed = (claimed.passed ?? 0) + claim.claimedPassed;
    }
    if (claim.claimedFailed !== null && claim.claimedFailed !== undefined) {
      claimed.failed = (claimed.failed ?? 0) + claim.claimedFailed;
    }
    const counts = claim.replay?.counts;
    if (counts && counts.passed !== null && counts.passed !== undefined) {
      replayed.passed = (replayed.passed ?? 0) + counts.passed;
    }
    if (counts && counts.failed !== null && counts.failed !== undefined) {
      replayed.failed = (replayed.failed ?? 0) + counts.failed;
    }
  }
  return { claimed, replayed };
}

/**
 * Audit one PR by reusing runAudit. fetchDiff defaults to
 * `gh pr diff`; auditOne defaults to runAudit. Returns a batch row.
 * A mismatch is re-run once (#169 flake policy); a throw from either
 * step is recorded as verdict 'error' and never propagates.
 */
export async function auditOnePR(pr, context) {
  const {
    repoDir,
    slug,
    timeoutMs = 300000,
    i6d = true,
    runGh = defaultGhRunner,
    fetchDiff = null,
    auditOne = null,
  } = context;
  const started = Date.now();
  const runOne = async () => {
    const diffText = fetchDiff
      ? await fetchDiff(pr.number)
      : (() => {
          const diff = runGh(['pr', 'diff', String(pr.number), '--repo', slug]);
          if (diff.status !== 0) {
            throw new Error(`gh pr diff ${pr.number} failed: ${(diff.stderr || diff.stdout || '').trim().slice(-300)}`);
          }
          return diff.stdout || '';
        })();
    const audit = auditOne || ((opts) => runAudit(opts));
    return audit({
      repoDir,
      diffText,
      baseRef: pr.baseRefOid,
      headRef: pr.mergeCommitOid || pr.headRefOid,
      claimsText: pr.body || '',
      timeoutMs,
      python: process.env.PYTHON || 'python3',
      i6d,
    });
  };
  try {
    const first = await runOne();
    let report = first;
    let attempts = [first];
    let retried = false;
    if (first.verdict === 'mismatch') {
      // #169: one retry before settling a mismatch; both attempts kept.
      retried = true;
      const second = await runOne();
      attempts = [first, second];
      report = second;
    }
    const { claimed, replayed } = countAuditTotals(report);
    return {
      pr: pr.number,
      title: pr.title || '',
      mergedAt: pr.mergedAt || null,
      verdict: report.verdict,
      claimed,
      replayed,
      error: report.error || null,
      retried,
      attempts: attempts.map((attempt) => ({
        verdict: attempt.verdict,
        error: attempt.error || null,
        durationMs: attempt.durationMs ?? null,
      })),
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      pr: pr.number,
      title: pr.title || '',
      mergedAt: pr.mergedAt || null,
      verdict: 'error',
      claimed: { passed: null, failed: null },
      replayed: { passed: null, failed: null },
      error: error?.message || String(error),
      retried: false,
      attempts: [],
      durationMs: Date.now() - started,
    };
  }
}

/** Aggregate rows into summary counts and the discrepancy rate. */
export function summarizeBatch(rows) {
  const summary = { total: rows.length, verified: 0, mismatch: 0, no_claims: 0, unverifiable: 0, error: 0 };
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(summary, row.verdict)) summary[row.verdict] += 1;
  }
  // Discrepancy rate = mismatch rows / total rows (0 for an empty batch).
  summary.discrepancy_rate = summary.total === 0 ? 0 : Number((summary.mismatch / summary.total).toFixed(4));
  return summary;
}

export function batchExitCode(summary) {
  if (summary.mismatch > 0 || summary.unverifiable > 0 || summary.error > 0) return 1;
  if (summary.total > 0 && summary.no_claims === summary.total) return 3;
  return 0;
}

/**
 * Run a full batch: resolve the repo, enumerate merged PRs, audit each
 * (a per-PR failure is recorded on its row, never aborts the batch).
 * Returns { repo, slug, since, limit, rows, summary, exitCode }.
 * Injectable seams (runGh / runGit / auditOne / fetchDiff) exist for
 * tests; production callers pass none of them.
 */
export async function runBatchAudit(repoArg, options = {}) {
  const {
    since = null,
    limit = DEFAULT_BATCH_LIMIT,
    timeoutMs = 300000,
    i6d = true,
    runGh = defaultGhRunner,
    runGit,
    auditOne = null,
    fetchDiff = null,
  } = options;
  const started = Date.now();
  const parsed = parseBatchRepo(repoArg);
  const resolved = resolveBatchRepo(parsed, { runGh, runGit });
  const prs = listMergedPRs(resolved.slug, { since, limit, runGh });
  const rows = [];
  for (const pr of prs) {
    // Awaited sequentially on purpose: each runAudit replays in its own
    // scratch clone with its own npm install, so parallel rows would
    // thrash disk and the shared gh rate-limit budget.
    rows.push(await auditOnePR(pr, {
      repoDir: resolved.repoDir,
      slug: resolved.slug,
      timeoutMs,
      i6d,
      runGh,
      fetchDiff,
      auditOne,
    }));
  }
  const summary = summarizeBatch(rows);
  return {
    repo: repoArg,
    slug: resolved.slug,
    since,
    limit,
    rows,
    summary,
    exitCode: batchExitCode(summary),
    durationMs: Date.now() - started,
  };
}

function countCell(value) {
  return value === null || value === undefined ? '–' : String(value);
}

/** Human-readable per-PR verdict table + summary. */
export function renderBatchReport(batch) {
  const lines = [`xflow audit --batch ${batch.slug}${batch.since ? ` --since ${batch.since}` : ''} (limit ${batch.limit})`];
  if (batch.rows.length === 0) {
    lines.push('no merged PRs in window');
  } else {
    lines.push(`${'PR'.padEnd(7)}${'verdict'.padEnd(13)}${'claimed'.padEnd(24)}${'replayed'.padEnd(24)}title`);
    for (const row of batch.rows) {
      const pr = `#${row.pr}`.padEnd(7);
      const verdict = row.verdict.padEnd(13);
      const claimed = `${countCell(row.claimed.passed)} passed / ${countCell(row.claimed.failed)} failed`.padEnd(24);
      const replayed = `${countCell(row.replayed.passed)} passed / ${countCell(row.replayed.failed)} failed`.padEnd(24);
      const extra = row.error ? ` — ${row.error}` : '';
      const retry = row.retried ? ' (retried once)' : '';
      lines.push(`${pr}${verdict}${claimed}${replayed}${row.title}${retry}${extra}`);
    }
  }
  const s = batch.summary;
  lines.push(
    `summary: ${s.total} PRs — verified ${s.verified}, mismatch ${s.mismatch}, no_claims ${s.no_claims}, unverifiable ${s.unverifiable}, error ${s.error}; discrepancy rate ${s.discrepancy_rate}`,
  );
  if (batch.durationMs !== undefined) lines.push(`duration: ${(batch.durationMs / 1000).toFixed(1)}s`);
  return lines.join('\n');
}
