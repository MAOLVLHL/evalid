import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  aggregateTrend,
  collectTrendRecords,
  normalizeAuditReport,
  normalizeVerifyProof,
  renderTrendReport,
} from '../src/core/trend.js';

const REPO_ROOT = process.cwd();

function runCli(args, cwd = REPO_ROOT) {
  return spawnSync('node', ['bin/xflow.js', ...args], { cwd, encoding: 'utf8' });
}

function writeProof(projectRoot, changeId, proof) {
  const dir = resolve(projectRoot, 'specs', 'changes', changeId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'verify_proof.json'), `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
  return dir;
}

function j1Proof({ results, recordedAt, agent, model }) {
  const proof = {
    all_passed: results.every((entry) => entry.passed),
    results: results.map((entry) => ({
      command: entry.command || 'node --test test/example.test.js',
      exit_code: entry.passed ? 0 : 1,
      passed: entry.passed,
      stdout_tail: entry.passed ? 'pass 1' : 'fail 1',
    })),
    recorded_at: recordedAt,
  };
  if (agent !== undefined) proof.agent = agent;
  if (model !== undefined) proof.model = model;
  return proof;
}

describe('trend aggregation', () => {
  test('normalizeVerifyProof maps a J1 proof to claimed vs replayed counts', () => {
    const record = normalizeVerifyProof(j1Proof({
      results: [{ passed: true }, { passed: true }, { passed: true }, { passed: true }, { passed: false }],
      recordedAt: '2026-11-10T05:00:00.000Z',
      agent: 'pi',
      model: 'minimax-m3.1-flash',
    }), { repo: 'surlymochan/evalid', changeId: 'chg-trend-1' });
    assert.equal(record.repo, 'surlymochan/evalid');
    assert.equal(record.change_id, 'chg-trend-1');
    assert.equal(record.agent, 'pi');
    assert.equal(record.model, 'minimax-m3.1-flash');
    assert.equal(record.recorded_at, '2026-11-10T05:00:00.000Z');
    assert.equal(record.claimed_passed, 5);
    assert.equal(record.replayed_passed, 4);
    assert.equal(record.samples, 5);
    assert.equal(record.source, 'verify_proof');
  });

  test('normalizeVerifyProof defaults agent/model to unknown and rejects malformed proofs', () => {
    const record = normalizeVerifyProof(j1Proof({
      results: [{ passed: true }],
      recordedAt: '2026-11-10T05:00:00.000Z',
    }), { repo: 'surlymochan/evalid', changeId: 'chg-trend-2' });
    assert.equal(record.agent, 'unknown');
    assert.equal(record.model, 'unknown');
    assert.equal(normalizeVerifyProof(null, { repo: 'r', changeId: 'c' }), null);
    assert.equal(normalizeVerifyProof({ all_passed: true }, { repo: 'r', changeId: 'c' }), null);
    assert.equal(normalizeVerifyProof({ results: [] }, { repo: 'r', changeId: 'c' }), null);
    assert.equal(normalizeVerifyProof({ results: 'nope' }, { repo: 'r', changeId: 'c' }), null);
  });

  test('normalizeAuditReport maps counted claims and skips count-less claims', () => {
    const records = normalizeAuditReport({
      verdict: 'mismatch',
      claims: [
        { command: 'npm test', claimedPassed: 24, claimedFailed: 0, replay: { counts: { passed: 22, failed: 2 } }, match: false },
        { command: 'npm run check', claimedPassed: null, replay: { counts: { passed: 3, failed: 0 } }, match: true },
        { command: 'pytest -q', claimedPassed: 10, replay: null, match: false },
      ],
    }, { repo: 'surlymochan/senpi' });
    assert.equal(records.length, 1);
    assert.equal(records[0].repo, 'surlymochan/senpi');
    assert.equal(records[0].claimed_passed, 24);
    assert.equal(records[0].replayed_passed, 22);
    assert.equal(records[0].samples, 1);
    assert.equal(records[0].source, 'audit');
    assert.equal(normalizeAuditReport({ claims: [] }, { repo: 'r' }).length, 0);
    assert.equal(normalizeAuditReport(null, { repo: 'r' }).length, 0);
  });

  test('aggregateTrend groups by repo and agent/model with delta and rate', () => {
    const aggregation = aggregateTrend([
      { repo: 'surlymochan/evalid', change_id: 'a', recorded_at: '2026-11-10T05:00:00.000Z', agent: 'pi', model: 'm3', claimed_passed: 10, replayed_passed: 9, samples: 2, source: 'verify_proof' },
      { repo: 'surlymochan/evalid', change_id: 'b', recorded_at: '2026-11-10T06:00:00.000Z', agent: 'pi', model: 'm3', claimed_passed: 20, replayed_passed: 20, samples: 3, source: 'verify_proof' },
      { repo: 'surlymochan/evalid', change_id: 'c', recorded_at: '2026-11-10T07:00:00.000Z', agent: 'codex', model: 'gpt-5', claimed_passed: 5, replayed_passed: 2, samples: 1, source: 'verify_proof' },
      { repo: 'surlymochan/swrm', change_id: 'd', recorded_at: '2026-11-10T08:00:00.000Z', agent: 'pi', model: 'm3', claimed_passed: 8, replayed_passed: 8, samples: 1, source: 'verify_proof' },
    ]);
    assert.equal(aggregation.groups.length, 3);
    assert.deepEqual(aggregation.groups.map((group) => [group.repo, group.agent, group.model]), [
      ['surlymochan/evalid', 'codex', 'gpt-5'],
      ['surlymochan/evalid', 'pi', 'm3'],
      ['surlymochan/swrm', 'pi', 'm3'],
    ]);
    const piGroup = aggregation.groups.find((group) => group.agent === 'pi' && group.repo === 'surlymochan/evalid');
    assert.equal(piGroup.claimed_passed, 30);
    assert.equal(piGroup.replayed_passed, 29);
    assert.equal(piGroup.delta, 1);
    assert.equal(piGroup.delta_rate, 1 / 30);
    assert.equal(piGroup.samples, 5);
    assert.equal(aggregation.total.claimed_passed, 43);
    assert.equal(aggregation.total.replayed_passed, 39);
    assert.equal(aggregation.total.delta, 4);
    assert.equal(aggregation.total.samples, 7);
    assert.equal(aggregation.record_count, 4);
    assert.equal(aggregation.skipped_count, 0);
  });

  test('aggregateTrend --since keeps only in-window records and drops dateless ones', () => {
    const aggregation = aggregateTrend([
      { repo: 'r', change_id: 'old', recorded_at: '2026-10-20T00:00:00.000Z', agent: 'pi', model: 'm3', claimed_passed: 4, replayed_passed: 4, samples: 1, source: 'verify_proof' },
      { repo: 'r', change_id: 'new', recorded_at: '2026-11-10T00:00:00.000Z', agent: 'pi', model: 'm3', claimed_passed: 6, replayed_passed: 5, samples: 1, source: 'verify_proof' },
      { repo: 'r', change_id: 'dateless', recorded_at: null, agent: 'pi', model: 'm3', claimed_passed: 100, replayed_passed: 100, samples: 1, source: 'verify_proof' },
    ], { since: '2026-11-01' });
    assert.equal(aggregation.total.claimed_passed, 6);
    assert.equal(aggregation.record_count, 1);
    assert.equal(aggregation.since, '2026-11-01');
    const unfiltered = aggregateTrend([
      { repo: 'r', change_id: 'dateless', recorded_at: null, agent: 'pi', model: 'm3', claimed_passed: 100, replayed_passed: 100, samples: 1, source: 'verify_proof' },
    ]);
    assert.equal(unfiltered.total.claimed_passed, 100);
  });

  test('aggregateTrend reports null delta rate when nothing was claimed', () => {
    const aggregation = aggregateTrend([
      { repo: 'r', change_id: 'z', recorded_at: '2026-11-10T00:00:00.000Z', agent: 'pi', model: 'm3', claimed_passed: 0, replayed_passed: 0, samples: 1, source: 'verify_proof' },
    ]);
    assert.equal(aggregation.groups[0].delta, 0);
    assert.equal(aggregation.groups[0].delta_rate, null);
    assert.equal(aggregation.total.delta_rate, null);
  });

  test('renderTrendReport golden output', () => {
    const aggregation = aggregateTrend([
      { repo: 'surlymochan/evalid', change_id: 'a', recorded_at: '2026-11-10T05:00:00.000Z', agent: 'pi', model: 'm3', claimed_passed: 30, replayed_passed: 29, samples: 5, source: 'verify_proof' },
      { repo: 'surlymochan/evalid', change_id: 'b', recorded_at: '2026-11-10T06:00:00.000Z', agent: 'codex', model: 'gpt-5', claimed_passed: 5, replayed_passed: 2, samples: 1, source: 'verify_proof' },
    ], { since: '2026-11-01' });
    const expected = [
      'xflow trend — claimed vs replayed (since 2026-11-01)',
      '',
      'repo                agent/model  claimed  replayed  delta  delta%  samples',
      '------------------  -----------  -------  --------  -----  ------  -------',
      'surlymochan/evalid  codex/gpt-5  5        2         3      60.0%   1',
      'surlymochan/evalid  pi/m3        30       29        1      3.3%    5',
      'TOTAL                            35       31        4      11.4%   6',
      '',
      'records: 2 proof record(s), 0 skipped',
    ].join('\n');
    assert.equal(renderTrendReport(aggregation), expected);
  });
});

describe('trend ledger collection', () => {
  test('collectTrendRecords reads specs/changes/*/verify_proof.json and skips malformed files', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'evalid-trend-collect-'));
    try {
      writeProof(projectRoot, 'chg-a', j1Proof({
        results: [{ passed: true }, { passed: false }],
        recordedAt: '2026-11-10T05:00:00.000Z',
        agent: 'pi',
        model: 'm3',
      }));
      writeProof(projectRoot, 'chg-b', j1Proof({
        results: [{ passed: true }],
        recordedAt: '2026-11-11T05:00:00.000Z',
      }));
      const badDir = resolve(projectRoot, 'specs', 'changes', 'chg-bad');
      mkdirSync(badDir, { recursive: true });
      writeFileSync(resolve(badDir, 'verify_proof.json'), '{not json', 'utf8');
      const collected = collectTrendRecords(projectRoot);
      assert.equal(collected.records.length, 2);
      assert.equal(collected.scanned, 3);
      assert.equal(collected.skipped, 1);
      assert.equal(collected.records[0].change_id, 'chg-a');
      assert.equal(collected.records[0].claimed_passed, 2);
      assert.equal(collected.records[0].replayed_passed, 1);
      assert.equal(collected.records[1].agent, 'unknown');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('collectTrendRecords on a repo without a ledger reports zero files', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'evalid-trend-empty-'));
    try {
      const collected = collectTrendRecords(projectRoot);
      assert.equal(collected.records.length, 0);
      assert.equal(collected.scanned, 0);
      assert.equal(collected.skipped, 0);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('xflow trend CLI', () => {
  test('golden table from a fixture repo', () => {
    const projectRoot = join(tmpdir(), 'evalid-trend-golden');
    rmSync(projectRoot, { recursive: true, force: true });
    try {
      writeProof(projectRoot, 'chg-a', j1Proof({
        results: [{ passed: true }, { passed: true }, { passed: false }],
        recordedAt: '2026-11-10T05:00:00.000Z',
        agent: 'pi',
        model: 'm3',
      }));
      writeProof(projectRoot, 'chg-b', j1Proof({
        results: [{ passed: true }, { passed: true }],
        recordedAt: '2026-11-10T06:00:00.000Z',
        agent: 'codex',
        model: 'gpt-5',
      }));
      const result = runCli(['trend', '--repo', projectRoot]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const expected = [
        'xflow trend — claimed vs replayed (all time)',
        '',
        'repo                 agent/model  claimed  replayed  delta  delta%  samples',
        '-------------------  -----------  -------  --------  -----  ------  -------',
        'evalid-trend-golden  codex/gpt-5  2        2         0      0.0%    2',
        'evalid-trend-golden  pi/m3        3        2         1      33.3%   3',
        'TOTAL                             5        4         1      20.0%   5',
        '',
        'records: 2 proof record(s), 0 skipped',
        '',
      ].join('\n');
      assert.equal(result.stdout, expected);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('--since filters the window at the CLI', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'evalid-trend-since-'));
    try {
      writeProof(projectRoot, 'chg-old', j1Proof({
        results: [{ passed: true }],
        recordedAt: '2026-10-20T05:00:00.000Z',
        agent: 'pi',
        model: 'm3',
      }));
      writeProof(projectRoot, 'chg-new', j1Proof({
        results: [{ passed: true }, { passed: false }],
        recordedAt: '2026-11-10T05:00:00.000Z',
        agent: 'pi',
        model: 'm3',
      }));
      const result = runCli(['trend', '--repo', projectRoot, '--since', '2026-11-01']);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /since 2026-11-01/);
      assert.match(result.stdout, /2\s+1\s+1\s+50\.0%/);
      assert.match(result.stdout, /records: 1 proof record/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('--json prints the machine-readable aggregation', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'evalid-trend-json-'));
    try {
      writeProof(projectRoot, 'chg-a', j1Proof({
        results: [{ passed: true }, { passed: false }],
        recordedAt: '2026-11-10T05:00:00.000Z',
        agent: 'pi',
        model: 'm3',
      }));
      const result = runCli(['trend', '--repo', projectRoot, '--json']);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.total.claimed_passed, 2);
      assert.equal(parsed.total.replayed_passed, 1);
      assert.equal(parsed.total.delta, 1);
      assert.equal(parsed.groups.length, 1);
      assert.equal(parsed.groups[0].agent, 'pi');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('missing ledger gives an actionable hint, not an empty table', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'evalid-trend-nolegder-'));
    try {
      const result = runCli(['trend', '--repo', projectRoot]);
      assert.equal(result.status, 3, result.stdout);
      assert.match(result.stdout, /no proof ledger found/);
      assert.match(result.stdout, /verify_proof\.json/);
      assert.match(result.stdout, /xflow proof/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('empty window gives an actionable hint naming --since', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'evalid-trend-emptywin-'));
    try {
      writeProof(projectRoot, 'chg-a', j1Proof({
        results: [{ passed: true }],
        recordedAt: '2026-10-20T05:00:00.000Z',
        agent: 'pi',
        model: 'm3',
      }));
      const result = runCli(['trend', '--repo', projectRoot, '--since', '2026-11-01']);
      assert.equal(result.status, 3, result.stdout);
      assert.match(result.stdout, /no proof records in window/);
      assert.match(result.stdout, /--since 2026-11-01/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('bad repo path and bad --since are misuse (exit 2)', () => {
    const missing = runCli(['trend', '--repo', join(tmpdir(), 'evalid-trend-does-not-exist-xyz')]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /repo not found/);
    const projectRoot = mkdtempSync(join(tmpdir(), 'evalid-trend-baddate-'));
    try {
      const badDate = runCli(['trend', '--repo', projectRoot, '--since', 'not-a-date']);
      assert.equal(badDate.status, 2);
      assert.match(badDate.stderr, /--since/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('trend --help shows usage', () => {
    const result = runCli(['trend', '--help']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /xflow trend \[--repo <path>\] \[--since <date>\]/);
  });

  test('xflow --help lists trend', () => {
    const result = runCli(['--help']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /xflow trend/);
  });
});
