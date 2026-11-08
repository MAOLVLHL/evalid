import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { verifyProof } from '../action/verify-proof.mjs';

const REPO_ROOT = process.cwd();
const ENTRY = resolve(REPO_ROOT, 'action', 'verify-proof.mjs');
const CHANGE_ID = 'chg-action';

function makeChangeRoot() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'evalid-action-'));
  mkdirSync(resolve(projectRoot, 'specs', 'changes', CHANGE_ID), { recursive: true });
  return projectRoot;
}

function git(projectRoot, args) {
  const result = spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function runAtom(script, projectRoot, args = [], timeout = 60000) {
  return spawnSync('python3', [
    resolve(REPO_ROOT, script),
    '--project-root',
    projectRoot,
    '--change-id',
    CHANGE_ID,
    ...args,
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout,
  });
}

// Seals a real green proof: a one-assertion node test, committed, then a
// product file touched after the commit so the scoped snapshot is exercised.
// Same shape as the sealGreen helper in test/tdd-proof.test.js.
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

function verify(projectRoot) {
  return verifyProof({
    actionDir: REPO_ROOT,
    projectRoot,
    changeId: CHANGE_ID,
    phase: 'green',
    attempt: 0,
  });
}

describe('GitHub Action proof verification (issue #70)', () => {
  test('a valid sealed green proof verifies (exit 0, verdict valid)', () => {
    const projectRoot = makeChangeRoot();
    try {
      sealGreen(projectRoot);
      const result = verify(projectRoot);
      assert.equal(result.ok, true, result.stdout || result.stderr);
      assert.equal(result.verdict, 'valid');
      assert.equal(result.exitCode, 0);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('a tampered proof fails with binding_mismatch (exit non-zero)', () => {
    const projectRoot = makeChangeRoot();
    try {
      sealGreen(projectRoot);
      const proof = JSON.parse(readFileSync(proofPath(projectRoot), 'utf8'));
      proof.exit_code = 1;
      writeFileSync(proofPath(projectRoot), JSON.stringify(proof, null, 2));
      const result = verify(projectRoot);
      assert.equal(result.ok, false, result.stdout);
      assert.equal(result.verdict, 'binding_mismatch');
      assert.notEqual(result.exitCode, 0);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('a test file edited after the seal fails with green_tree_mismatch', () => {
    const projectRoot = makeChangeRoot();
    try {
      sealGreen(projectRoot);
      const testFile = resolve(projectRoot, 'test', 'add.test.js');
      writeFileSync(testFile, `${readFileSync(testFile, 'utf8')}// drifted after the seal\n`);
      const result = verify(projectRoot);
      assert.equal(result.ok, false, result.stdout);
      assert.equal(result.verdict, 'green_tree_mismatch');
      assert.notEqual(result.exitCode, 0);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('a missing proof fails with verdict missing (exit non-zero)', () => {
    const projectRoot = makeChangeRoot();
    try {
      const result = verify(projectRoot);
      assert.equal(result.ok, false, result.stdout);
      assert.equal(result.verdict, 'missing');
      assert.notEqual(result.exitCode, 0);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('the CLI entry exits 0 on a valid proof and 1 on a missing proof', () => {
    const projectRoot = makeChangeRoot();
    try {
      const baseArgs = [
        ENTRY,
        '--action-dir', REPO_ROOT,
        '--project-root', projectRoot,
        '--change-id', CHANGE_ID,
        '--phase', 'green',
      ];
      const missing = spawnSync(process.execPath, baseArgs, { encoding: 'utf8', timeout: 60000 });
      assert.equal(missing.status, 1, missing.stdout || missing.stderr);
      assert.match(missing.stdout, /"verdict":"missing"/);

      sealGreen(projectRoot);
      const valid = spawnSync(process.execPath, baseArgs, { encoding: 'utf8', timeout: 60000 });
      assert.equal(valid.status, 0, valid.stdout || valid.stderr);
      assert.match(valid.stdout, /"verdict":"valid"/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('action.yml declares the action inputs and points at the entry', () => {
    const actionYml = resolve(REPO_ROOT, 'action.yml');
    assert.ok(existsSync(actionYml), 'action.yml must exist at the repo root');
    const text = readFileSync(actionYml, 'utf8');
    for (const token of ['change-id', 'phase', 'attempt', 'project-root', 'tdd-mode']) {
      assert.ok(text.includes(token), `action.yml must declare input ${token}`);
    }
    assert.match(text, /using:\s*['"]?node22['"]?/);
    assert.ok(text.includes('action/verify-proof.mjs'), 'action.yml main must be action/verify-proof.mjs');
  });
});
