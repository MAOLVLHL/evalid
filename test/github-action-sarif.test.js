import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  buildSarif,
  emptySarif,
  mergeSarifForProof,
  proofFilePath,
  readSarif,
  resultFingerprint,
  verdictRule,
} from '../action/sarif.mjs';

const REPO_ROOT = process.cwd();
const ENTRY = resolve(REPO_ROOT, 'action', 'verify-proof.mjs');
const CHANGE_ID = 'chg-sarif';

function sarifFor(verdict, extra = {}) {
  return buildSarif({
    changeId: CHANGE_ID,
    phase: 'green',
    attempt: 0,
    payload: { verdict, ...extra },
    version: '0.5.17',
  });
}

describe('SARIF export for code scanning (issue #73)', () => {
  test('proof-failure verdicts map to rules with the right level', () => {
    const cases = [
      ['binding_mismatch', 'evalid/binding-mismatch', 'error'],
      ['snapshot_mismatch', 'evalid/snapshot-mismatch', 'error'],
      ['green_tree_mismatch', 'evalid/green-tree-mismatch', 'error'],
      ['reexec_timeout', 'evalid/reexec-timeout', 'error'],
      ['reexec_exit_mismatch', 'evalid/reexec-exit-mismatch', 'error'],
      ['reexec_result_mismatch', 'evalid/reexec-result-mismatch', 'error'],
      ['missing', 'evalid/proof-missing', 'error'],
      ['tests_skipped_or_todo', 'evalid/tests-skipped-or-todo', 'warning'],
      ['tests_counts_unknown', 'evalid/tests-counts-unknown', 'warning'],
    ];
    for (const [verdict, id, level] of cases) {
      const rule = verdictRule(verdict);
      assert.ok(rule, `${verdict} must map to a rule`);
      assert.equal(rule.id, id);
      assert.equal(rule.defaultConfiguration.level, level);
      assert.equal(rule.properties['evalid/verdict'], verdict);
    }
  });

  test('valid, not_required, and infrastructure verdicts produce no alert', () => {
    for (const verdict of ['valid', 'not_required', 'missing_change_id', 'validator_missing', 'spawn_error', 'unparseable_output', 'invalid_tdd_mode', 'unknown_verdict_xyz']) {
      const doc = sarifFor(verdict);
      assert.equal(doc.runs[0].results.length, 0, `${verdict} must produce zero results`);
      assert.equal(doc.runs[0].tool.driver.rules.length, 0, `${verdict} must produce zero rules`);
    }
  });

  test('a verdict naming files emits one result per file at that location', () => {
    const files = ['test/demo-tamper.test.js', 'test/other.test.js'];
    const doc = sarifFor('snapshot_mismatch', { files });
    assert.equal(doc.runs[0].results.length, 2);
    assert.deepEqual(
      doc.runs[0].results.map((r) => r.locations[0].physicalLocation.artifactLocation.uri),
      files,
    );
    for (const result of doc.runs[0].results) {
      assert.equal(result.ruleId, 'evalid/snapshot-mismatch');
      assert.equal(result.level, 'error');
      assert.match(result.message.text, /snapshot/i);
    }
  });

  test('a verdict with no file location degrades to the proof file', () => {
    const doc = sarifFor('binding_mismatch');
    assert.equal(doc.runs[0].results.length, 1);
    const result = doc.runs[0].results[0];
    assert.equal(
      result.locations[0].physicalLocation.artifactLocation.uri,
      proofFilePath(CHANGE_ID, 'green', 0),
    );
    assert.equal(result.ruleId, 'evalid/binding-mismatch');
  });

  test('the dedup fingerprint is stable for the same proof and differs across verdicts', () => {
    const a = sarifFor('green_tree_mismatch', { files: ['test/a.test.js'] });
    const b = sarifFor('green_tree_mismatch', { files: ['test/a.test.js'] });
    assert.equal(
      a.runs[0].results[0].partialFingerprints['evalid/proof'],
      b.runs[0].results[0].partialFingerprints['evalid/proof'],
    );
    const c = sarifFor('snapshot_mismatch', { files: ['test/a.test.js'] });
    assert.notEqual(
      a.runs[0].results[0].partialFingerprints['evalid/proof'],
      c.runs[0].results[0].partialFingerprints['evalid/proof'],
    );
    assert.equal(
      resultFingerprint({ changeId: CHANGE_ID, phase: 'green', attempt: 0, verdict: 'green_tree_mismatch', uri: 'test/a.test.js' }),
      a.runs[0].results[0].partialFingerprints['evalid/proof'],
    );
  });

  test('the SARIF document is 2.1.0 and names the evalid tool', () => {
    const doc = sarifFor('binding_mismatch');
    assert.equal(doc.$schema, 'https://json.schemastore.org/sarif-2.1.0.json');
    assert.equal(doc.version, '2.1.0');
    assert.equal(doc.runs[0].tool.driver.name, 'evalid');
    assert.equal(doc.runs[0].tool.driver.version, '0.5.17');
    assert.equal(doc.runs[0].tool.driver.rules.length, 1);
  });

  test('merging upserts per proof: re-run replaces, a valid proof clears its alert', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evalid-sarif-'));
    try {
      const path = resolve(dir, 'out.sarif');
      const proof = { changeId: CHANGE_ID, phase: 'green', attempt: 0 };
      mergeSarifForProof({ sarifPath: path, document: sarifFor('green_tree_mismatch', { files: ['test/a.test.js'] }), proof });
      let doc = readSarif(path);
      assert.equal(doc.runs[0].results.length, 1);
      assert.equal(doc.runs[0].tool.driver.rules.length, 1);

      // Re-running the same broken proof replaces, never duplicates.
      mergeSarifForProof({ sarifPath: path, document: sarifFor('green_tree_mismatch', { files: ['test/a.test.js'] }), proof });
      doc = readSarif(path);
      assert.equal(doc.runs[0].results.length, 1);

      // A second proof accumulates alongside the first.
      const proofB = { changeId: 'chg-other', phase: 'green', attempt: 0 };
      const docB = buildSarif({
        changeId: 'chg-other', phase: 'green', attempt: 0,
        payload: { verdict: 'snapshot_mismatch', files: ['src/x.js'] }, version: '0.5.17',
      });
      mergeSarifForProof({ sarifPath: path, document: docB, proof: proofB });
      doc = readSarif(path);
      assert.equal(doc.runs[0].results.length, 2);
      assert.equal(doc.runs[0].tool.driver.rules.length, 2);

      // The first proof turning valid clears only its own alert.
      mergeSarifForProof({ sarifPath: path, document: sarifFor('valid'), proof });
      doc = readSarif(path);
      assert.equal(doc.runs[0].results.length, 1);
      assert.equal(doc.runs[0].results[0].ruleId, 'evalid/snapshot-mismatch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('emptySarif / readSarif round-trip rejects foreign documents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evalid-sarif-'));
    try {
      const path = resolve(dir, 'empty.sarif');
      writeFileSync(path, JSON.stringify(emptySarif('0.5.17')));
      const doc = readSarif(path);
      assert.equal(doc.runs[0].results.length, 0);
      assert.equal(doc.runs[0].tool.driver.name, 'evalid');

      const foreign = resolve(dir, 'foreign.sarif');
      writeFileSync(foreign, JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'other' } }, results: [] }] }));
      assert.equal(readSarif(foreign), null);
      assert.equal(readSarif(resolve(dir, 'missing.sarif')), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('action.yml declares the sarif-out input and sarif outputs', () => {
    const text = readFileSync(resolve(REPO_ROOT, 'action.yml'), 'utf8');
    assert.ok(text.includes('sarif-out'), 'action.yml must declare input sarif-out');
    assert.ok(text.includes('sarif_path'), 'action.yml must declare output sarif_path');
    assert.ok(text.includes('sarif_written'), 'action.yml must declare output sarif_written');
  });
});

describe('SARIF export via the verify-proof CLI (issue #73)', () => {
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

  // Seals a real green proof; same shape as the sealGreen helper in
  // test/github-action-verify-proof.test.js.
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

  function cli(projectRoot, sarifOut) {
    return spawnSync(process.execPath, [
      ENTRY,
      '--action-dir', REPO_ROOT,
      '--project-root', projectRoot,
      '--change-id', CHANGE_ID,
      '--phase', 'green',
      '--post-comment', 'false',
      '--sarif-out', sarifOut,
    ], { encoding: 'utf8', timeout: 60000 });
  }

  test('a valid proof exports an empty-results SARIF and exits 0', () => {
    const projectRoot = makeChangeRoot();
    try {
      sealGreen(projectRoot);
      const sarifPath = resolve(projectRoot, 'evalid-proof.sarif');
      const run = cli(projectRoot, sarifPath);
      assert.equal(run.status, 0, run.stdout || run.stderr);
      assert.match(run.stdout, /"verdict":"valid"/);
      assert.match(run.stdout, /"sarif_written":true/);
      assert.ok(existsSync(sarifPath), 'SARIF file must be written for a valid proof');
      const doc = readSarif(sarifPath);
      assert.equal(doc.runs[0].results.length, 0);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('a drifted test file exports a green_tree_mismatch alert and exits 1', () => {
    const projectRoot = makeChangeRoot();
    try {
      sealGreen(projectRoot);
      const testFile = resolve(projectRoot, 'test', 'add.test.js');
      writeFileSync(testFile, `${readFileSync(testFile, 'utf8')}// drifted after the seal\n`);
      const sarifPath = resolve(projectRoot, 'evalid-proof.sarif');
      const run = cli(projectRoot, sarifPath);
      assert.equal(run.status, 1, run.stdout || run.stderr);
      assert.match(run.stdout, /"verdict":"green_tree_mismatch"/);
      assert.match(run.stdout, /"sarif_written":true/);
      const doc = readSarif(sarifPath);
      assert.equal(doc.runs[0].results.length, 1);
      const result = doc.runs[0].results[0];
      assert.equal(result.ruleId, 'evalid/green-tree-mismatch');
      assert.equal(result.level, 'error');
      assert.equal(result.locations[0].physicalLocation.artifactLocation.uri, 'test/add.test.js');
      assert.ok(result.partialFingerprints['evalid/proof'].includes('green_tree_mismatch'));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
