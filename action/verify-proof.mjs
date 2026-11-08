#!/usr/bin/env node
/**
 * evalid GitHub Action entry: verify a TDD proof seal in CI.
 *
 * Runs the existing seal validator (xflow/atoms/i6b_tdd_proof_validate.py)
 * for one change-id / phase / attempt and exits non-zero unless the seal
 * verifies and the clean replay matches the claim. The validator does the
 * real work — binding recompute, snapshot hash check, replay in a copy of
 * the sealed snapshot, green-tree drift check — this entry only wires it
 * into the Actions runtime (inputs, JSON verdict, exit code, outputs).
 *
 * After the verdict it posts the claim-vs-evidence ledger as a PR comment
 * (action/ledger-comment.mjs, issue #73), upserting on a stable marker so
 * re-runs update the same comment. Posting is best-effort: a failed post
 * is reported in the JSON output but never changes the exit code, which
 * stays driven by the proof alone.
 *
 * Usage as an action (see action.yml):
 *   uses: surlymochan/evalid@v0.5.x
 *   with:
 *     change-id: my-change
 *     phase: green
 *
 * Usage locally:
 *   node action/verify-proof.mjs --project-root . --change-id my-change
 *
 * Exit codes: 0 = proof valid; 1 = proof invalid (missing, binding
 * mismatch, replay mismatch, drift after seal, ...); 2 = entry misuse
 * (missing change-id, validator not found, python spawn failure).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ledgerMarker,
  postLedgerComment,
  readProof,
  renderLedger,
  resolvePrNumber,
} from './ledger-comment.mjs';

export const VALIDATOR_RELATIVE_PATH = 'xflow/atoms/i6b_tdd_proof_validate.py';

export function defaultActionDir() {
  if (process.env.GITHUB_ACTION_PATH) return process.env.GITHUB_ACTION_PATH;
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/** Parse the validator's JSON verdict out of its stdout (last JSON line wins). */
export function parseVerdict(stdout) {
  const lines = String(stdout || '').split('\n').reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const payload = JSON.parse(trimmed);
      if (payload && typeof payload.verdict === 'string') return payload;
    } catch {
      // Not the verdict line; keep scanning.
    }
  }
  return null;
}

/**
 * Verify one sealed proof. Returns { ok, verdict, exitCode, stdout, stderr }.
 * Never throws for a failed proof — a failed proof is a normal result (exit 1).
 */
export function verifyProof(options = {}) {
  const {
    actionDir = defaultActionDir(),
    projectRoot = process.cwd(),
    changeId = '',
    phase = 'green',
    attempt = 0,
    tddMode = '',
    python = process.env.PYTHON || 'python3',
  } = options;

  if (!changeId) {
    return {
      ok: false,
      verdict: 'missing_change_id',
      exitCode: 2,
      stdout: '',
      stderr: 'change-id is required',
    };
  }

  const validator = resolve(actionDir, VALIDATOR_RELATIVE_PATH);
  if (!existsSync(validator)) {
    return {
      ok: false,
      verdict: 'validator_missing',
      exitCode: 2,
      stdout: '',
      stderr: `validator not found: ${validator}`,
    };
  }

  const args = [
    validator,
    '--project-root', resolve(projectRoot),
    '--change-id', changeId,
    '--phase', phase,
    '--attempt', String(attempt),
  ];
  if (tddMode) args.push('--tdd-mode', tddMode);

  const result = spawnSync(python, args, {
    cwd: resolve(projectRoot),
    encoding: 'utf8',
    timeout: 180000,
  });

  if (result.error) {
    return {
      ok: false,
      verdict: 'spawn_error',
      exitCode: 2,
      stdout: result.stdout || '',
      stderr: String(result.error.message || result.error),
    };
  }

  const payload = parseVerdict(result.stdout);
  if (!payload) {
    return {
      ok: false,
      verdict: 'unparseable_output',
      exitCode: 1,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  }

  const ok = payload.ok === true && result.status === 0;
  return {
    ok,
    verdict: payload.verdict,
    exitCode: ok ? 0 : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function parseCliArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      parsed[key] = next;
      i += 1;
    } else {
      parsed[key] = 'true';
    }
  }
  return parsed;
}

function writeGithubOutputs(result) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  appendFileSync(
    outputFile,
    `ok=${result.ok}\nverdict=${result.verdict}\ncomment_posted=${result.comment_posted === true}\ncomment_url=${result.comment_url || ''}\n`,
  );
}

/**
 * Post the claim-vs-evidence ledger as a PR comment (issue #73).
 * Best-effort by design: a failed post never changes the proof verdict —
 * the caller records comment_posted / comment_error and keeps the exit
 * code driven by the proof alone. Returns { posted, updated, url, error }.
 */
export async function postLedgerForResult(result, options = {}) {
  const {
    projectRoot = process.cwd(),
    changeId = '',
    phase = 'green',
    attempt = 0,
    postComment = true,
    githubToken = process.env.GITHUB_TOKEN || '',
    prNumber = 0,
    repo = process.env.GITHUB_REPOSITORY || '',
    apiBase = process.env.GITHUB_API_URL || 'https://api.github.com',
    fetchImpl = fetch,
  } = options;

  if (!postComment) return { posted: false, updated: false, url: '', error: 'post-comment disabled' };
  const pr = resolvePrNumber({
    prNumber,
    eventPath: process.env.GITHUB_EVENT_PATH || '',
    ref: process.env.GITHUB_REF || '',
  });
  if (!pr) return { posted: false, updated: false, url: '', error: 'no pull request number resolved' };
  if (!githubToken) return { posted: false, updated: false, url: '', error: 'no github token available' };
  const [owner, repoName] = String(repo).split('/');
  if (!owner || !repoName) return { posted: false, updated: false, url: '', error: 'no owner/repo resolved' };

  const runUrl = process.env.GITHUB_RUN_ID && repo
    ? `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : '';
  const payload = parseVerdict(result.stdout) || { ok: result.ok, verdict: result.verdict };
  const proof = readProof({ projectRoot, changeId, phase, attempt });
  const marker = ledgerMarker(changeId, phase, attempt);
  const body = renderLedger({
    changeId,
    phase,
    attempt,
    ok: result.ok,
    payload,
    proof,
    runUrl,
    repo,
  });
  try {
    const posted = await postLedgerComment({
      token: githubToken,
      apiBase,
      owner,
      repo: repoName,
      prNumber: pr,
      body,
      marker,
      fetchImpl,
    });
    return { posted: posted.posted, updated: posted.updated, url: posted.commentUrl, error: '' };
  } catch (err) {
    return { posted: false, updated: false, url: '', error: String(err?.message || err) };
  }
}

// CLI entry: only runs when invoked directly, not when imported by tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseCliArgs(process.argv.slice(2));
  const result = verifyProof({
    actionDir: args.action_dir || defaultActionDir(),
    projectRoot: args.project_root || process.cwd(),
    changeId: args.change_id || '',
    phase: args.phase || 'green',
    attempt: args.attempt === undefined ? 0 : Number(args.attempt),
    tddMode: args.tdd_mode || '',
    python: args.python || process.env.PYTHON || 'python3',
  });
  const postComment = args.post_comment === undefined
    ? true
    : String(args.post_comment).toLowerCase() !== 'false';
  const ledger = await postLedgerForResult(result, {
    projectRoot: args.project_root || process.cwd(),
    changeId: args.change_id || '',
    phase: args.phase || 'green',
    attempt: args.attempt === undefined ? 0 : Number(args.attempt),
    postComment,
    githubToken: args.github_token || process.env.GITHUB_TOKEN || '',
    prNumber: args.pr_number === undefined ? 0 : Number(args.pr_number),
    repo: args.repo || process.env.GITHUB_REPOSITORY || '',
    apiBase: args.api_base || process.env.GITHUB_API_URL || 'https://api.github.com',
  });
  const payload = parseVerdict(result.stdout) || { ok: result.ok, verdict: result.verdict };
  const output = {
    ...payload,
    comment_posted: ledger.posted,
    comment_url: ledger.url,
  };
  if (ledger.error) output.comment_error = ledger.error;
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (result.stderr) process.stderr.write(result.stderr);
  if (ledger.error) process.stderr.write(`ledger comment: ${ledger.error}\n`);
  writeGithubOutputs({ ...result, comment_posted: ledger.posted, comment_url: ledger.url });
  process.exit(result.exitCode);
}
