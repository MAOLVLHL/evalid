#!/usr/bin/env node
/**
 * evalid PR comment ledger (issue #73).
 *
 * Renders the claim-vs-evidence ledger for one sealed TDD proof as a PR
 * comment and upserts it on the pull request: the same marker is reused
 * across runs so a re-run updates the existing comment instead of
 * spamming a new one per push.
 *
 * The ledger shows what the proof claims (command, exit code, pass/fail,
 * failure kind, seal time) next to what the clean replay actually found
 * (validator verdict, replayed exit code / failure kind, mismatched
 * files). On a failed proof the comment names the breakage point:
 * binding mismatch, snapshot drift, green-tree drift, or replay mismatch.
 *
 * Transport is plain fetch against the GitHub REST API (Node 22 has a
 * global fetch); no dependencies. Posting is best-effort by design: a
 * failed post must never mask the proof verdict — callers record
 * comment_posted / comment_error and keep the exit code driven by the
 * proof alone.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const LEDGER_MARKER_PREFIX = 'evalid-ledger:';

/** Stable marker embedded in the comment body; used to find it again. */
export function ledgerMarker(changeId, phase, attempt) {
  return `<!-- ${LEDGER_MARKER_PREFIX} ${changeId}/${phase}/${attempt} -->`;
}

function escapeMd(value) {
  return String(value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
}

function code(value) {
  return `\`${String(value ?? '')}\``;
}

/** Human-readable explanation of a validator verdict (the breakage point). */
export function explainVerdict(payload = {}) {
  const verdict = payload.verdict || 'unknown';
  switch (verdict) {
    case 'valid':
      return 'Seal verifies and the clean replay matches the claim.';
    case 'not_required':
      return 'No proof is required for this phase in this TDD mode.';
    case 'missing':
      return `No sealed proof found at ${code(payload.file || '(unknown path)')}. The change claims a test run it never sealed.`;
    case 'invalid_json':
      return `The proof file is not valid JSON (${escapeMd(payload.error || '')}).`;
    case 'schema_error':
      return `The proof is missing required fields: ${(payload.missing_fields || []).map(code).join(', ')}.`;
    case 'phase_mismatch':
      return `The proof records phase ${code(payload.actual_phase)} but ${code(payload.expected_phase)} was requested.`;
    case 'binding_missing':
      return 'The proof has no binding, failure kind, or file hashes — it was never sealed.';
    case 'binding_mismatch':
      return 'The binding no longer matches the recorded fields: the proof JSON (command, exit code, output hash, or file hashes) was edited after sealing.';
    case 'proof_inconsistent':
      return 'The proof contradicts itself: `passed` does not agree with `exit_code`.';
    case 'snapshot_mismatch':
      return `Files in the sealed snapshot no longer match their sealed hashes: ${(payload.files || []).map(code).join(', ') || '(unknown files)'}.`;
    case 'replay_source_missing':
      return `The sealed snapshot could not be replayed (${escapeMd(payload.error || '')}).`;
    case 'reexec_timeout':
      return 'The replayed test command timed out.';
    case 'reexec_exit_mismatch':
      return `Replay exit code ${code(payload.actual_exit)} differs from the claimed ${code(payload.expected_exit)}.`;
    case 'reexec_result_mismatch':
      return `Replay failure kind ${code(payload.actual_failure_kind)} differs from the claimed ${code(payload.expected_failure_kind)}.`;
    case 'green_tree_mismatch':
      return `Test files changed after the seal (unsealed edits): ${(payload.files || []).map(code).join(', ') || '(unknown files)'}.`;
    case 'tests_skipped_or_todo':
      return 'The replay shows skipped, todo, or focused tests — the green run did not really execute the tests.';
    case 'tests_counts_unknown':
      return 'The replay output carries no readable test counts.';
    case 'semantic_error':
      return `The proof claims ${code(payload.actual_passed)} for a ${code(payload.phase)} phase, which expects ${code(payload.expected_passed)}.`;
    case 'expectation_not_met':
      return 'The proof records `expectation_met: false`.';
    case 'missing_change_id':
    case 'validator_missing':
    case 'spawn_error':
    case 'unparseable_output':
      return 'The Action itself could not run the validator — this is an infrastructure failure, not a proof failure.';
    default:
      return `Validator verdict: ${code(verdict)}.`;
  }
}

/**
 * Render the ledger comment markdown.
 *
 * @param {object} args
 * @param {string} args.changeId
 * @param {string} args.phase
 * @param {number} args.attempt
 * @param {boolean} args.ok
 * @param {object} args.payload validator verdict payload (may be {})
 * @param {object|null} args.proof parsed proof JSON, or null when unreadable
 * @param {string} [args.runUrl] link to the workflow run
 * @param {string} [args.repo] owner/repo, shown in the footer
 */
export function renderLedger({
  changeId,
  phase,
  attempt = 0,
  ok,
  payload = {},
  proof = null,
  runUrl = '',
  repo = '',
}) {
  const verdict = payload.verdict || 'unknown';
  const marker = ledgerMarker(changeId, phase, attempt);
  const title = `## evalid proof ledger — ${changeId} · ${phase} #${attempt}`;
  const status = ok
    ? '✅ **valid** — seal verifies, replay matches the claim.'
    : `❌ **${verdict}** — ${explainVerdict(payload)}`;

  const rows = [];
  if (proof) {
    rows.push(['Command', code(proof.command || '(none)')]);
    rows.push(['Claimed exit code', code(proof.exit_code)]);
    rows.push(['Claimed result', proof.passed ? 'passed' : 'failed']);
    rows.push(['Claimed failure kind', code(proof.failure_kind || '(none)')]);
    rows.push(['Sealed at', code(proof.recorded_at || '(unknown)')]);
  } else {
    rows.push(['Claim', 'proof file unreadable or missing']);
  }
  rows.push(['Validator verdict', code(verdict)]);
  if (payload.expected_exit !== undefined || payload.actual_exit !== undefined) {
    rows.push(['Replay exit code', code(payload.actual_exit)]);
  }
  if (payload.expected_failure_kind !== undefined || payload.actual_failure_kind !== undefined) {
    rows.push(['Replay failure kind', code(payload.actual_failure_kind)]);
  }
  if (Array.isArray(payload.files) && payload.files.length > 0) {
    rows.push(['Mismatched files', payload.files.map(code).join('<br>')]);
  }
  if (payload.reread_count !== undefined) {
    rows.push(['Snapshot files re-read', code(payload.reread_count)]);
  }

  const table = [
    '| Claim vs evidence | |',
    '| --- | --- |',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
  ].join('\n');

  const breakage = !ok && verdict !== 'not_required'
    ? `\n### Breakage point\n\n${explainVerdict(payload)}\n`
    : '';

  const footerParts = ['_Posted by the evalid proof check._'];
  if (runUrl) footerParts.push(`[Workflow run](${runUrl})`);
  if (repo) footerParts.push(code(repo));
  const footer = `\n---\n\n${footerParts.join(' · ')}\n\n${marker}`;

  return `${title}\n\n${status}\n\n${table}${breakage}${footer}\n`;
}

/** Read and parse a sealed proof file; null when missing or invalid. */
export function readProof({ projectRoot, changeId, phase, attempt = 0 }) {
  try {
    const path = resolve(projectRoot, 'specs', 'changes', changeId, 'tdd', `${phase}-${attempt}.json`);
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolve the PR number: explicit input wins, then the event payload
 * (pull_request.number), then refs/pull/<n>/merge.
 */
export function resolvePrNumber({ prNumber = 0, eventPath = '', ref = '', readFile = readFileSync } = {}) {
  const explicit = Number(prNumber) || 0;
  if (explicit > 0) return explicit;
  if (eventPath) {
    try {
      const event = JSON.parse(readFile(eventPath, 'utf8'));
      const n = Number(event?.pull_request?.number) || 0;
      if (n > 0) return n;
    } catch {
      // Fall through to ref parsing.
    }
  }
  const match = String(ref || '').match(/^refs\/pull\/(\d+)\/(merge|head)$/);
  if (match) return Number(match[1]);
  return 0;
}

/**
 * Upsert the ledger comment on a PR via the GitHub REST API.
 * Returns { posted, updated, commentUrl }. Throws on transport/API errors.
 */
export async function postLedgerComment({
  token,
  apiBase = process.env.GITHUB_API_URL || 'https://api.github.com',
  owner,
  repo,
  prNumber,
  body,
  marker,
  fetchImpl = fetch,
}) {
  if (!token) throw new Error('github-token is required to post the ledger comment');
  if (!owner || !repo) throw new Error('owner/repo is required to post the ledger comment');
  if (!prNumber) throw new Error('pr-number is required to post the ledger comment');

  const base = String(apiBase).replace(/\/$/, '');
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'evalid-ledger-comment',
  };
  const listUrl = `${base}/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`;
  const listRes = await fetchImpl(listUrl, { headers });
  if (!listRes.ok) {
    throw new Error(`list PR comments failed: HTTP ${listRes.status}`);
  }
  const comments = await listRes.json();
  const existing = (Array.isArray(comments) ? comments : []).find(
    (c) => typeof c?.body === 'string' && c.body.includes(marker),
  );

  if (existing) {
    const res = await fetchImpl(`${base}/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`update ledger comment failed: HTTP ${res.status}`);
    const updated = await res.json();
    return { posted: true, updated: true, commentUrl: updated.html_url || '' };
  }

  const res = await fetchImpl(`${base}/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`create ledger comment failed: HTTP ${res.status}`);
  const created = await res.json();
  return { posted: true, updated: false, commentUrl: created.html_url || '' };
}
