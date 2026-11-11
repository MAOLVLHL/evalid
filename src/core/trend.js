/**
 * M5 slice 1 (#126): trend core — aggregate proof ledgers into a
 * claimed-vs-replayed report.
 *
 * A trend record is one proof entry reduced to the numbers the report
 * needs. Two ledger shapes normalize into it:
 *
 *   - specs/changes/<id>/verify_proof.json (J1 proof): every result entry
 *     is a command the change claimed would pass, and `passed` is the
 *     replay outcome. claimed_passed = results.length, replayed_passed =
 *     the count of passed results, samples = results.length.
 *   - `xflow audit --out` JSON reports: one record per claim that states
 *     both a claimed pass count and a replayed pass count; claims without
 *     counts on either side are skipped (the delta is undefined for them).
 *
 * The module is read-only: it never writes, seals, or replays anything.
 * All it does is read ledger files and count.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const UNKNOWN = 'unknown';

/** Parse a --since value (YYYY-MM-DD) into a UTC midnight timestamp. */
export function parseSinceDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`invalid --since date '${value}' (expected YYYY-MM-DD)`);
  }
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(ms)) {
    throw new Error(`invalid --since date '${value}' (expected YYYY-MM-DD)`);
  }
  return ms;
}

function asLabel(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : UNKNOWN;
}

function asTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : value;
}

function asCount(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * Normalize one J1 verify_proof.json payload into a trend record.
 * Returns null when the payload is not a usable proof (no results array).
 */
export function normalizeVerifyProof(proof, { repo, changeId }) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return null;
  const results = proof.results;
  if (!Array.isArray(results) || results.length === 0) return null;
  const replayedPassed = results.filter((entry) => entry && entry.passed === true).length;
  return {
    repo,
    change_id: changeId || null,
    recorded_at: asTimestamp(proof.recorded_at),
    agent: asLabel(proof.agent),
    model: asLabel(proof.model),
    claimed_passed: results.length,
    replayed_passed: replayedPassed,
    samples: results.length,
    source: 'verify_proof',
  };
}

/**
 * Normalize one `xflow audit --out` JSON report into trend records.
 * One record per claim with a claimed pass count and a replayed pass
 * count; claims missing either count are skipped (delta undefined).
 */
export function normalizeAuditReport(report, { repo, recordedAt = null } = {}) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.claims)) return [];
  const records = [];
  for (const claim of report.claims) {
    if (!claim || typeof claim !== 'object') continue;
    const claimed = asCount(claim.claimedPassed);
    const replayed = asCount(claim.replay?.counts?.passed);
    if (claimed === null || replayed === null) continue;
    records.push({
      repo,
      change_id: claim.changeId || null,
      recorded_at: asTimestamp(recordedAt),
      agent: UNKNOWN,
      model: UNKNOWN,
      claimed_passed: claimed,
      replayed_passed: replayed,
      samples: 1,
      source: 'audit',
    });
  }
  return records;
}

function deltaRate(claimed, replayed) {
  if (claimed <= 0) return null;
  return (claimed - replayed) / claimed;
}

function sumGroup(records) {
  const claimed = records.reduce((sum, record) => sum + record.claimed_passed, 0);
  const replayed = records.reduce((sum, record) => sum + record.replayed_passed, 0);
  const samples = records.reduce((sum, record) => sum + record.samples, 0);
  return {
    claimed_passed: claimed,
    replayed_passed: replayed,
    delta: claimed - replayed,
    delta_rate: deltaRate(claimed, replayed),
    samples,
  };
}

/**
 * Aggregate normalized records into per-(repo, agent, model) groups.
 *
 * @param {Array} records normalized trend records (nulls count as skipped)
 * @param {object} [options]
 * @param {string|null} [options.since] YYYY-MM-DD window start (UTC); records
 *   without a parseable recorded_at are dropped when a window is set.
 * @param {number} [options.skipped] records already known-skipped upstream
 *   (e.g. malformed ledger files), added to skipped_count.
 */
export function aggregateTrend(records, { since = null, skipped = 0 } = {}) {
  const sinceMs = since ? parseSinceDate(since) : null;
  const groupsByKey = new Map();
  let recordCount = 0;
  let skippedCount = skipped;
  for (const record of records || []) {
    if (!record || typeof record !== 'object'
      || !Number.isFinite(record.claimed_passed)
      || !Number.isFinite(record.replayed_passed)
      || !Number.isFinite(record.samples)) {
      skippedCount += 1;
      continue;
    }
    if (sinceMs !== null) {
      const at = record.recorded_at ? Date.parse(record.recorded_at) : Number.NaN;
      if (Number.isNaN(at) || at < sinceMs) continue;
    }
    recordCount += 1;
    const key = `${record.repo}\0${record.agent}\0${record.model}`;
    if (!groupsByKey.has(key)) {
      groupsByKey.set(key, {
        repo: record.repo,
        agent: record.agent,
        model: record.model,
        records: [],
      });
    }
    groupsByKey.get(key).records.push(record);
  }
  const groups = [...groupsByKey.values()]
    .sort((a, b) => (
      a.repo < b.repo ? -1 : a.repo > b.repo ? 1
        : a.agent < b.agent ? -1 : a.agent > b.agent ? 1
          : a.model < b.model ? -1 : a.model > b.model ? 1 : 0
    ))
    .map((group) => ({
      repo: group.repo,
      agent: group.agent,
      model: group.model,
      ...sumGroup(group.records),
    }));
  const total = sumGroup(groups);
  return {
    since: since || null,
    groups,
    total,
    record_count: recordCount,
    skipped_count: skippedCount,
  };
}

function agentModelLabel(agent, model) {
  if (agent === UNKNOWN && model === UNKNOWN) return UNKNOWN;
  return `${agent}/${model}`;
}

function formatRate(rate) {
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}

function renderTable(headers, rows) {
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...rows.map((row) => String(row[index]).length),
  ));
  const renderRow = (row) => row
    .map((cell, index) => (index === row.length - 1 ? String(cell) : String(cell).padEnd(widths[index])))
    .join('  ');
  const lines = [renderRow(headers), widths.map((width) => '-'.repeat(width)).join('  ')];
  for (const row of rows) lines.push(renderRow(row));
  return lines;
}

/** Render an aggregation as the text table `xflow trend` prints. */
export function renderTrendReport(aggregation) {
  const windowLabel = aggregation.since ? `since ${aggregation.since}` : 'all time';
  const rows = aggregation.groups.map((group) => [
    group.repo,
    agentModelLabel(group.agent, group.model),
    group.claimed_passed,
    group.replayed_passed,
    group.delta,
    formatRate(group.delta_rate),
    group.samples,
  ]);
  rows.push([
    'TOTAL',
    '',
    aggregation.total.claimed_passed,
    aggregation.total.replayed_passed,
    aggregation.total.delta,
    formatRate(aggregation.total.delta_rate),
    aggregation.total.samples,
  ]);
  const lines = [
    `xflow trend — claimed vs replayed (${windowLabel})`,
    '',
    ...renderTable(
      ['repo', 'agent/model', 'claimed', 'replayed', 'delta', 'delta%', 'samples'],
      rows,
    ),
    '',
    `records: ${aggregation.record_count} proof record(s), ${aggregation.skipped_count} skipped`,
  ];
  return lines.join('\n');
}

/** Best-effort repo display name: owner/repo from the git remote, else the dir name. */
export function resolveRepoName(repoDir) {
  try {
    const remote = spawnSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: repoDir,
      encoding: 'utf8',
    });
    const url = (remote.stdout || '').trim();
    const match = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch {
    // Fall through to the directory name.
  }
  return basename(resolve(repoDir));
}

function readProofFile(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    return raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Collect trend records from a repo's proof ledger:
 * specs/changes/<id>/verify_proof.json. Read-only; malformed files are
 * counted as skipped, never fatal.
 */
export function collectTrendRecords(repoDir) {
  const repo = resolveRepoName(repoDir);
  const changesDir = resolve(repoDir, 'specs', 'changes');
  const records = [];
  let scanned = 0;
  let skipped = 0;
  if (!existsSync(changesDir)) return { repo, records, scanned, skipped };
  let changeIds = [];
  try {
    changeIds = readdirSync(changesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { repo, records, scanned, skipped };
  }
  for (const changeId of changeIds) {
    const proofPath = resolve(changesDir, changeId, 'verify_proof.json');
    if (!existsSync(proofPath)) continue;
    scanned += 1;
    const record = normalizeVerifyProof(readProofFile(proofPath), { repo, changeId });
    if (record) records.push(record);
    else skipped += 1;
  }
  return { repo, records, scanned, skipped };
}
