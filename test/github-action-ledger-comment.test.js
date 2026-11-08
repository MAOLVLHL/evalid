import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

import { verifyProof } from '../action/verify-proof.mjs';
import {
  explainVerdict,
  ledgerMarker,
  postLedgerComment,
  readProof,
  renderLedger,
  resolvePrNumber,
} from '../action/ledger-comment.mjs';

const REPO_ROOT = process.cwd();
const ENTRY = resolve(REPO_ROOT, 'action', 'verify-proof.mjs');
const CHANGE_ID = 'chg-ledger';
const MARKER = ledgerMarker(CHANGE_ID, 'green', 0);

const VALID_PROOF = {
  phase: 'green',
  attempt: 0,
  command: 'node --test test/add.test.js',
  exit_code: 0,
  passed: true,
  failure_kind: 'pass',
  recorded_at: '2026-11-09T01:00:00+08:00',
  binding: 'deadbeef',
  file_hashes: { 'test/add.test.js': 'abc' },
};

/** Minimal stub of the GitHub issues-comments API; records every request. */
function startStubApi(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      handler(req, res, body, requests);
    });
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => done({
      server,
      requests,
      base: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

describe('ledger rendering (issue #73)', () => {
  test('a valid proof renders a green ledger with the claim table', () => {
    const body = renderLedger({
      changeId: CHANGE_ID,
      phase: 'green',
      attempt: 0,
      ok: true,
      payload: { ok: true, verdict: 'valid', reread_count: 3 },
      proof: VALID_PROOF,
      runUrl: 'https://github.com/o/r/actions/runs/1',
      repo: 'o/r',
    });
    assert.match(body, /✅ \*\*valid\*\*/);
    assert.match(body, /node --test test\/add\.test\.js/);
    assert.match(body, /Claimed exit code \| `0`/);
    assert.match(body, /Snapshot files re-read \| `3`/);
    assert.doesNotMatch(body, /Breakage point/);
    assert.ok(body.includes(MARKER), 'ledger carries its upsert marker');
    assert.match(body, /Workflow run/);
  });

  test('a binding mismatch renders a red ledger naming the breakage point', () => {
    const body = renderLedger({
      changeId: CHANGE_ID,
      phase: 'green',
      attempt: 0,
      ok: false,
      payload: { ok: false, verdict: 'binding_mismatch' },
      proof: { ...VALID_PROOF, exit_code: 1 },
    });
    assert.match(body, /❌ \*\*binding_mismatch\*\*/);
    assert.match(body, /### Breakage point/);
    assert.match(body, /edited after sealing/);
  });

  test('a green-tree mismatch lists the drifted test files', () => {
    const body = renderLedger({
      changeId: CHANGE_ID,
      phase: 'green',
      attempt: 0,
      ok: false,
      payload: { ok: false, verdict: 'green_tree_mismatch', files: ['test/add.test.js'] },
      proof: VALID_PROOF,
    });
    assert.match(body, /❌ \*\*green_tree_mismatch\*\*/);
    assert.match(body, /test\/add\.test\.js/);
    assert.match(body, /changed after the seal/);
  });

  test('a replay exit mismatch shows claimed vs actual exit codes', () => {
    const body = renderLedger({
      changeId: CHANGE_ID,
      phase: 'green',
      attempt: 0,
      ok: false,
      payload: { ok: false, verdict: 'reexec_exit_mismatch', expected_exit: 0, actual_exit: 1 },
      proof: VALID_PROOF,
    });
    assert.match(body, /Replay exit code \| `1`/);
    assert.match(body, /differs from the claimed `0`/);
  });

  test('an unreadable proof still renders a ledger that says so', () => {
    const body = renderLedger({
      changeId: CHANGE_ID,
      phase: 'green',
      attempt: 0,
      ok: false,
      payload: { ok: false, verdict: 'missing', file: 'specs/changes/chg-ledger/tdd/green-0.json' },
      proof: null,
    });
    assert.match(body, /proof file unreadable or missing/);
    assert.match(body, /never sealed/);
  });

  test('explainVerdict covers every validator verdict without crashing', () => {
    for (const verdict of [
      'valid', 'not_required', 'missing', 'invalid_json', 'schema_error',
      'phase_mismatch', 'binding_missing', 'binding_mismatch',
      'proof_inconsistent', 'snapshot_mismatch', 'replay_source_missing',
      'reexec_timeout', 'reexec_exit_mismatch', 'reexec_result_mismatch',
      'green_tree_mismatch', 'tests_skipped_or_todo', 'tests_counts_unknown',
      'semantic_error', 'expectation_not_met', 'missing_change_id',
      'validator_missing', 'spawn_error', 'unparseable_output', 'totally_new',
    ]) {
      const text = explainVerdict({ verdict, files: ['a.js'], error: 'boom' });
      assert.equal(typeof text, 'string');
      assert.ok(text.length > 0, verdict);
    }
  });

  test('readProof returns null for a missing proof file', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'evalid-ledger-'));
    try {
      assert.equal(readProof({ projectRoot, changeId: CHANGE_ID, phase: 'green', attempt: 0 }), null);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('PR number resolution', () => {
  test('explicit pr-number wins over event and ref', () => {
    assert.equal(resolvePrNumber({ prNumber: 42, ref: 'refs/pull/7/merge' }), 42);
  });

  test('event payload pull_request.number is used when no explicit number', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evalid-ledger-'));
    try {
      const eventPath = join(dir, 'event.json');
      writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 99 } }));
      assert.equal(resolvePrNumber({ eventPath }), 99);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refs/pull/<n>/merge is parsed as a fallback', () => {
    assert.equal(resolvePrNumber({ ref: 'refs/pull/123/merge' }), 123);
    assert.equal(resolvePrNumber({ ref: 'refs/heads/main' }), 0);
    assert.equal(resolvePrNumber({}), 0);
  });
});

describe('ledger comment upsert', () => {
  const baseArgs = {
    token: 'test-token',
    owner: 'surlymochan',
    repo: 'evalid',
    prNumber: 123,
    marker: MARKER,
  };

  test('creates a new comment when no ledger comment exists', async () => {
    const api = await startStubApi((req, res) => {
      if (req.method === 'GET') return json(res, 200, []);
      if (req.method === 'POST') {
        return json(res, 201, { html_url: 'https://github.com/surlymochan/evalid/pull/123#issuecomment-1' });
      }
      return json(res, 404, {});
    });
    try {
      const result = await postLedgerComment({
        ...baseArgs,
        apiBase: api.base,
        body: `ledger body\n\n${MARKER}`,
      });
      assert.equal(result.posted, true);
      assert.equal(result.updated, false);
      assert.match(result.commentUrl, /issuecomment-1/);
      assert.equal(api.requests.filter((r) => r.method === 'POST').length, 1);
      assert.equal(api.requests.filter((r) => r.method === 'PATCH').length, 0);
    } finally {
      api.server.close();
    }
  });

  test('updates the existing ledger comment instead of creating a second one', async () => {
    const api = await startStubApi((req, res) => {
      if (req.method === 'GET') {
        return json(res, 200, [
          { id: 7, body: `old ledger\n\n${MARKER}` },
          { id: 8, body: 'someone else' },
        ]);
      }
      if (req.method === 'PATCH') {
        return json(res, 200, { html_url: 'https://github.com/surlymochan/evalid/pull/123#issuecomment-7' });
      }
      return json(res, 404, {});
    });
    try {
      const result = await postLedgerComment({
        ...baseArgs,
        apiBase: api.base,
        body: `new ledger\n\n${MARKER}`,
      });
      assert.equal(result.posted, true);
      assert.equal(result.updated, true);
      assert.match(result.commentUrl, /issuecomment-7/);
      assert.equal(api.requests.filter((r) => r.method === 'POST').length, 0);
      const patch = api.requests.find((r) => r.method === 'PATCH');
      assert.ok(patch.url.includes('/issues/comments/7'));
      assert.ok(JSON.parse(patch.body).body.includes('new ledger'));
    } finally {
      api.server.close();
    }
  });

  test('an API failure throws so the caller can record it without masking the verdict', async () => {
    const api = await startStubApi((req, res) => json(res, 500, { message: 'boom' }));
    try {
      await assert.rejects(
        postLedgerComment({ ...baseArgs, apiBase: api.base, body: 'x' }),
        /list PR comments failed: HTTP 500/,
      );
    } finally {
      api.server.close();
    }
  });

  test('missing token / repo / pr number throw before any request', async () => {
    await assert.rejects(
      postLedgerComment({ ...baseArgs, token: '' }),
      /github-token is required/,
    );
    await assert.rejects(
      postLedgerComment({ ...baseArgs, prNumber: 0 }),
      /pr-number is required/,
    );
  });
});

// --- CLI end-to-end: seal a real proof, run the entry, check the comment ---

function makeChangeRoot() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'evalid-action-'));
  mkdirSync(resolve(projectRoot, 'specs', 'changes', CHANGE_ID), { recursive: true });
  return projectRoot;
}

function git(projectRoot, args) {
  const result = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function runAtom(script, projectRoot, args = [], timeout = 60000) {
  return spawnSync('python3', [
    resolve(REPO_ROOT, script),
    '--project-root', projectRoot,
    '--change-id', CHANGE_ID,
    ...args,
  ], { cwd: REPO_ROOT, encoding: 'utf8', timeout });
}

function sealGreen(projectRoot) {
  mkdirSync(resolve(projectRoot, 'src'), { recursive: true });
  mkdirSync(resolve(projectRoot, 'test'), { recursive: true });
  writeFileSync(resolve(projectRoot, 'src', 'add.js'), 'export function add(a, b) { return a + b; }\n');
  writeFileSync(resolve(projectRoot, 'test', 'add.test.js'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from '../src/add.js';",
    "test('adds', () => { assert.equal(add(2, 2), 4); });",
    '',
  ].join('\n'));
  git(projectRoot, ['init']);
  git(projectRoot, ['config', 'user.email', 'xflow@example.test']);
  git(projectRoot, ['config', 'user.name', 'xflow test']);
  git(projectRoot, ['add', '.']);
  git(projectRoot, ['commit', '-m', 'baseline product']);
  writeFileSync(resolve(projectRoot, 'src', 'add.js'), 'export function add(a, b) { return a + b; } // touched\n');
  const run = runAtom('xflow/atoms/i6a_tdd_run.py', projectRoot, [
    '--phase', 'green', '--test-command', 'node --test test/add.test.js',
  ]);
  assert.equal(run.status, 0, run.stderr || run.stdout);
}

function proofPath(projectRoot) {
  return resolve(projectRoot, 'specs', 'changes', CHANGE_ID, 'tdd', 'green-0.json');
}

function cliArgs(projectRoot) {
  return [
    ENTRY,
    '--action-dir', REPO_ROOT,
    '--project-root', projectRoot,
    '--change-id', CHANGE_ID,
    '--phase', 'green',
  ];
}

// Async spawn: the stub API server lives in this process, so the test
// event loop must stay free to answer the CLI child's requests —
// spawnSync would deadlock the child against the server.
function runCli(args, env) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

function writeEventFile(dir, number) {
  const eventPath = join(dir, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ pull_request: { number } }));
  return eventPath;
}

describe('CLI entry with ledger posting', () => {
  test('post-comment=false keeps the old behaviour (exit 0, comment_posted false)', () => {
    const projectRoot = makeChangeRoot();
    try {
      sealGreen(projectRoot);
      const run = spawnSync(process.execPath, [...cliArgs(projectRoot), '--post-comment', 'false'], {
        encoding: 'utf8',
        timeout: 60000,
      });
      assert.equal(run.status, 0, run.stdout || run.stderr);
      const payload = JSON.parse(run.stdout.trim().split('\n').at(-1));
      assert.equal(payload.verdict, 'valid');
      assert.equal(payload.comment_posted, false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('a valid proof posts a green ledger comment (exit 0)', async () => {
    const projectRoot = makeChangeRoot();
    const api = await startStubApi((req, res, body) => {
      if (req.method === 'GET') return json(res, 200, []);
      if (req.method === 'POST') {
        assert.ok(JSON.parse(body).body.includes('✅ **valid**'));
        return json(res, 201, { html_url: 'https://github.com/surlymochan/evalid/pull/123#issuecomment-1' });
      }
      return json(res, 404, {});
    });
    try {
      sealGreen(projectRoot);
      const eventPath = writeEventFile(projectRoot, 123);
      const run = await runCli(cliArgs(projectRoot), {
        ...process.env,
        GITHUB_TOKEN: 'test-token',
        GITHUB_REPOSITORY: 'surlymochan/evalid',
        GITHUB_API_URL: api.base,
        GITHUB_EVENT_PATH: eventPath,
      });
      assert.equal(run.status, 0, run.stdout || run.stderr);
      const payload = JSON.parse(run.stdout.trim().split('\n').at(-1));
      assert.equal(payload.verdict, 'valid');
      assert.equal(payload.comment_posted, true);
      assert.match(payload.comment_url, /issuecomment-1/);
      assert.equal(api.requests.filter((r) => r.method === 'POST').length, 1);
    } finally {
      api.server.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('a tampered proof still posts a red ledger comment, then exits 1', async () => {
    const projectRoot = makeChangeRoot();
    const api = await startStubApi((req, res, body) => {
      if (req.method === 'GET') return json(res, 200, []);
      if (req.method === 'POST') {
        assert.ok(JSON.parse(body).body.includes('❌ **binding_mismatch**'));
        return json(res, 201, { html_url: 'https://github.com/surlymochan/evalid/pull/123#issuecomment-2' });
      }
      return json(res, 404, {});
    });
    try {
      sealGreen(projectRoot);
      const proof = JSON.parse(readFileSync(proofPath(projectRoot), 'utf8'));
      proof.exit_code = 1;
      writeFileSync(proofPath(projectRoot), JSON.stringify(proof, null, 2));
      // Sanity: the proof itself is now invalid.
      assert.equal(verifyProof({
        actionDir: REPO_ROOT, projectRoot, changeId: CHANGE_ID, phase: 'green', attempt: 0,
      }).verdict, 'binding_mismatch');
      const eventPath = writeEventFile(projectRoot, 123);
      const run = await runCli(cliArgs(projectRoot), {
        ...process.env,
        GITHUB_TOKEN: 'test-token',
        GITHUB_REPOSITORY: 'surlymochan/evalid',
        GITHUB_API_URL: api.base,
        GITHUB_EVENT_PATH: eventPath,
      });
      assert.equal(run.status, 1, run.stdout || run.stderr);
      const payload = JSON.parse(run.stdout.trim().split('\n').at(-1));
      assert.equal(payload.verdict, 'binding_mismatch');
      assert.equal(payload.comment_posted, true);
      assert.match(payload.comment_url, /issuecomment-2/);
    } finally {
      api.server.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('action.yml declares the new ledger inputs and outputs', () => {
    const actionYml = resolve(REPO_ROOT, 'action.yml');
    assert.ok(existsSync(actionYml), 'action.yml must exist at the repo root');
    const text = readFileSync(actionYml, 'utf8');
    for (const token of ['post-comment', 'github-token', 'pr-number', 'comment_posted', 'comment_url']) {
      assert.ok(text.includes(token), `action.yml must declare ${token}`);
    }
  });
});
