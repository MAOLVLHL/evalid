import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  auditReportToSarif,
  proofToSarif,
  validateSarif,
  writeSarifFile,
} from '../src/core/sarif.js';
import { runAudit } from '../src/core/audit.js';

const repoRoot = resolve(import.meta.dirname, '..');
const xflowBin = join(repoRoot, 'bin', 'xflow.js');

function cleanProof() {
  return {
    ok: true,
    track: 'corps',
    change_id: 'chg-clean',
    proof_file: '/tmp/proj/specs/changes/chg-clean/corps_proof.json',
    completed_event_seen: true,
    expected_phases: ['plan', 'build'],
    completed_phases: ['plan', 'build'],
    missing_phases: [],
    missing_artifacts: [],
    contract_failures: [],
    strict_runtime_failures: [],
  };
}

describe('proofToSarif', () => {
  test('a clean proof produces zero results', () => {
    const doc = proofToSarif(cleanProof(), { version: '0.5.28', projectRoot: '/tmp/proj' });
    assert.equal(doc.version, '2.1.0');
    assert.deepEqual(doc.runs[0].results, []);
    assert.deepEqual(doc.runs[0].tool.driver.rules, []);
    assert.deepEqual(validateSarif(doc), { ok: true, errors: [] });
  });

  test('a failed proof yields one finding per gap, located at the proof file', () => {
    const proof = {
      ...cleanProof(),
      ok: false,
      completed_event_seen: false,
      missing_phases: ['build'],
      missing_artifacts: ['plan.md'],
      contract_failures: ['status.json: goal drift'],
      strict_runtime_failures: [],
    };
    const doc = proofToSarif(proof, { version: '0.5.28', projectRoot: '/tmp/proj' });
    // completed event + 1 phase + 1 artifact + 1 contract failure = 4
    assert.equal(doc.runs[0].results.length, 4);
    for (const result of doc.runs[0].results) {
      assert.equal(result.ruleId, 'evalid/proof-incomplete');
      assert.equal(result.level, 'error');
      assert.match(result.properties['evalid/evidence'], /proof: specs\/changes\/chg-clean\/corps_proof\.json/);
      // No invented line numbers: file-level locations only.
      assert.equal(result.locations[0].physicalLocation.region, undefined);
    }
    const texts = doc.runs[0].results.map((r) => r.message.text);
    assert.match(texts.join('\n'), /missing phase 'build'/);
    assert.match(texts.join('\n'), /missing required artifact 'plan\.md'/);
    assert.match(texts.join('\n'), /goal drift/);
    // The missing artifact is located at the artifact itself.
    const artifactResult = doc.runs[0].results.find((r) => /plan\.md/.test(r.message.text));
    assert.equal(artifactResult.locations[0].physicalLocation.artifactLocation.uri, 'specs/changes/chg-clean/plan.md');
    assert.deepEqual(validateSarif(doc), { ok: true, errors: [] });
  });

  test('a failed proof with no recorded gap still yields one finding, never zero', () => {
    const doc = proofToSarif({ ...cleanProof(), ok: false }, { version: '0.5.28', projectRoot: '/tmp/proj' });
    assert.equal(doc.runs[0].results.length, 1);
    assert.match(doc.runs[0].results[0].message.text, /failed without a recorded gap/);
    assert.deepEqual(validateSarif(doc), { ok: true, errors: [] });
  });
});

describe('auditReportToSarif', () => {
  test('a verified audit produces zero results', () => {
    const doc = auditReportToSarif({
      ok: true,
      verdict: 'verified',
      claims: [{ command: 'node --test test/a.test.js', claimedPassed: 2, match: true, replay: { exit: 0, counts: { passed: 2, failed: 0 } } }],
      seals: [],
      i6d: { applicable: false, reason: 'no_python_test_changes' },
    });
    assert.deepEqual(doc.runs[0].results, []);
    assert.deepEqual(validateSarif(doc), { ok: true, errors: [] });
  });

  test('a claim/replay count mismatch carries the claimed and replayed numbers', () => {
    const doc = auditReportToSarif({
      ok: false,
      verdict: 'mismatch',
      claims: [{
        command: 'node --test test/x.test.js',
        claimedPassed: 5,
        claimedFailed: 0,
        claimedExit: 0,
        match: false,
        note: 'passed count: claimed 5, replayed 3',
        replay: { exit: 0, counts: { passed: 3, failed: 0 } },
      }],
      seals: [],
      files: ['test/x.test.js'],
      testFiles: ['test/x.test.js'],
    });
    assert.equal(doc.runs[0].results.length, 1);
    const [result] = doc.runs[0].results;
    assert.equal(result.ruleId, 'evalid/claim-replay-mismatch');
    assert.equal(result.level, 'error');
    assert.match(result.message.text, /claimed 5 passed, replayed 3 passed/);
    assert.equal(result.locations[0].physicalLocation.artifactLocation.uri, 'test/x.test.js');
    assert.equal(result.locations[0].physicalLocation.region, undefined);
    assert.equal(result.properties.claimedPassed, 5);
    assert.equal(result.properties.replayedPassed, 3);
    assert.match(result.properties['evalid/evidence'], /replay: node --test test\/x\.test\.js/);
    assert.deepEqual(validateSarif(doc), { ok: true, errors: [] });
  });

  test('a replay that could not run is a warning, not an error', () => {
    const doc = auditReportToSarif({
      ok: false,
      verdict: 'unverifiable',
      claims: [{
        command: 'npm test',
        claimedPassed: 4,
        claimedExit: 0,
        match: false,
        note: 'replay timed out after 300000ms',
        replay: { exit: null, timedOut: true, counts: null },
      }],
      seals: [],
      files: [],
      testFiles: [],
    });
    assert.equal(doc.runs[0].results.length, 1);
    assert.equal(doc.runs[0].results[0].ruleId, 'evalid/replay-unavailable');
    assert.equal(doc.runs[0].results[0].level, 'warning');
    assert.equal(doc.runs[0].results[0].locations, undefined);
    assert.deepEqual(validateSarif(doc), { ok: true, errors: [] });
  });

  test('a snapshot-mismatch seal yields one finding per broken file', () => {
    const doc = auditReportToSarif({
      ok: false,
      verdict: 'mismatch',
      claims: [],
      seals: [{
        changeId: 'demo-change',
        phase: 'green',
        attempt: 0,
        path: 'specs/changes/demo-change/tdd/green-0.json',
        ok: false,
        verdict: 'snapshot_mismatch',
        files: ['test/a.test.js', 'test/b.test.js'],
      }],
    });
    assert.equal(doc.runs[0].results.length, 2);
    const uris = doc.runs[0].results.map((r) => r.locations[0].physicalLocation.artifactLocation.uri);
    assert.deepEqual(uris, ['test/a.test.js', 'test/b.test.js']);
    for (const result of doc.runs[0].results) {
      assert.equal(result.ruleId, 'evalid/snapshot-mismatch');
      assert.match(result.message.text, /snapshot_mismatch/);
      assert.match(result.message.text, /Broken file: test\/[ab]\.test\.js/);
      assert.match(result.properties['evalid/evidence'], /seal: specs\/changes\/demo-change\/tdd\/green-0\.json/);
    }
    assert.deepEqual(validateSarif(doc), { ok: true, errors: [] });
  });

  test('an infrastructure seal verdict produces no finding', () => {
    const doc = auditReportToSarif({
      ok: false,
      verdict: 'unverifiable',
      claims: [],
      seals: [{
        changeId: 'demo-change', phase: 'green', attempt: 0,
        path: 'specs/changes/demo-change/tdd/green-0.json',
        ok: false, verdict: 'validator_missing',
        files: [],
      }],
    });
    assert.deepEqual(doc.runs[0].results, []);
    assert.deepEqual(validateSarif(doc), { ok: true, errors: [] });
  });

  test('an unexecuted assertion carries its real file and line', () => {
    const doc = auditReportToSarif({
      ok: false,
      verdict: 'mismatch',
      claims: [],
      seals: [],
      i6d: {
        applicable: true,
        verdict: 'unexecuted_assertions',
        executed: 1,
        total: 2,
        unexecuted: [{ file: 'test_dead.py', line: 3, test: 'test_callback_never_runs', source: 'assert value == 42' }],
      },
    });
    assert.equal(doc.runs[0].results.length, 1);
    const [result] = doc.runs[0].results;
    assert.equal(result.ruleId, 'evalid/unexecuted-assertion');
    assert.equal(result.locations[0].physicalLocation.artifactLocation.uri, 'test_dead.py');
    assert.equal(result.locations[0].physicalLocation.region.startLine, 3);
    assert.match(result.message.text, /test_callback_never_runs/);
    assert.match(result.message.text, /assert value == 42/);
    assert.deepEqual(validateSarif(doc), { ok: true, errors: [] });
  });
});

describe('validateSarif (offline)', () => {
  test('the local minimal schema file exists and names the enforced keys', () => {
    const schemaPath = join(repoRoot, 'schemas', 'sarif-2.1.0.minimal.schema.json');
    assert.equal(existsSync(schemaPath), true);
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    assert.equal(schema.properties.version.const, '2.1.0');
    assert.deepEqual(schema.required, ['$schema', 'version', 'runs']);
    assert.deepEqual(schema.properties.runs.items.properties.results.items.required, ['ruleId', 'message']);
  });

  test('rejects a wrong version, a missing message, an undeclared rule, and a line 0', () => {
    const base = proofToSarif(cleanProof(), { version: '0.5.28' });
    const wrongVersion = { ...base, version: '2.0.0' };
    assert.equal(validateSarif(wrongVersion).ok, false);
    assert.match(validateSarif(wrongVersion).errors.join('\n'), /version must be '2\.1\.0'/);

    const noMessage = auditReportToSarif({
      verdict: 'mismatch',
      claims: [{ command: 'npm test', claimedPassed: 1, claimedExit: 0, match: false, replay: { exit: 1, counts: { passed: 0, failed: 1 } } }],
      seals: [],
    });
    delete noMessage.runs[0].results[0].message;
    assert.match(validateSarif(noMessage).errors.join('\n'), /missing required property: message/);

    const undeclared = structuredClone(noMessage);
    undeclared.runs[0].results[0].message = { text: 'x' };
    undeclared.runs[0].results[0].ruleId = 'evalid/no-such-rule';
    assert.match(validateSarif(undeclared).errors.join('\n'), /not declared in tool\.driver\.rules/);

    const lineZero = structuredClone(undeclared);
    lineZero.runs[0].results[0].ruleId = 'evalid/claim-replay-mismatch';
    lineZero.runs[0].results[0].locations = [{ physicalLocation: { artifactLocation: { uri: 'test/x.test.js' }, region: { startLine: 0 } } }];
    assert.match(validateSarif(lineZero).errors.join('\n'), /startLine must be an integer >= 1/);
  });
});

describe('writeSarifFile', () => {
  test('writes a valid document and refuses a missing directory with an actionable error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evalid-sarif-write-'));
    try {
      const doc = proofToSarif(cleanProof(), { version: '0.5.28' });
      const path = join(dir, 'out.sarif');
      assert.equal(writeSarifFile(path, doc), resolve(path));
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), doc);

      const missingDir = join(dir, 'no-such-dir', 'out.sarif');
      assert.throws(
        () => writeSarifFile(missingDir, doc),
        /directory does not exist.*mkdir -p/s,
      );
      assert.equal(existsSync(missingDir), false);

      // A path under a regular file is not writable either.
      const blocker = join(dir, 'blocker');
      writeFileSync(blocker, 'x\n');
      assert.throws(
        () => writeSarifFile(join(blocker, 'out.sarif'), doc),
        /Cannot write SARIF/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses to write an invalid document', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evalid-sarif-write-'));
    try {
      const path = join(dir, 'bad.sarif');
      assert.throws(
        () => writeSarifFile(path, { version: '2.0.0', runs: [] }),
        /failed offline schema validation/,
      );
      assert.equal(existsSync(path), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── CLI end-to-end ──────────────────────────────────────────────────────────

function makeGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'evalid-sarif-cli-'));
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result;
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'sarif-fixture@example.test']);
  git(['config', 'user.name', 'sarif-fixture']);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  return { repo, base };
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [xflowBin, ...args], { cwd, encoding: 'utf8' });
}

describe('xflow audit --sarif (CLI)', () => {
  test('writes an empty-results SARIF for a no-claims audit', () => {
    const { repo, base } = makeGitRepo();
    const dir = mkdtempSync(join(tmpdir(), 'evalid-sarif-cli-'));
    try {
      const sarifPath = join(dir, 'out.sarif');
      const result = runCli(['audit', '--repo', repo, '--base', base, '--sarif', sarifPath], repoRoot);
      assert.equal(result.status, 3, result.stderr || result.stdout); // no_claims
      assert.match(result.stdout, /SARIF: .* \(0 findings\)/);
      const doc = JSON.parse(readFileSync(sarifPath, 'utf8'));
      assert.deepEqual(doc.runs[0].results, []);
      assert.deepEqual(validateSarif(doc), { ok: true, errors: [] });
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a --sarif path in a missing directory fails with an actionable error, exit 2', () => {
    const { repo, base } = makeGitRepo();
    try {
      const sarifPath = join(repo, 'no-such-dir', 'out.sarif');
      const result = runCli(['audit', '--repo', repo, '--base', base, '--sarif', sarifPath], repoRoot);
      assert.equal(result.status, 2, result.stdout || result.stderr);
      assert.match(result.stderr, /directory does not exist/);
      assert.match(result.stderr, /mkdir -p/);
      assert.equal(existsSync(sarifPath), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('a tampered seal yields a binding-mismatch finding naming the seal file', () => {
    const repo = mkdtempSync(join(tmpdir(), 'evalid-sarif-seal-'));
    const dir = mkdtempSync(join(tmpdir(), 'evalid-sarif-cli-'));
    try {
      const git = (args) => {
        const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        return result;
      };
      git(['init', '-q']);
      git(['config', 'user.email', 'sarif-fixture@example.test']);
      git(['config', 'user.name', 'sarif-fixture']);
      mkdirSync(join(repo, 'xflow', 'atoms'), { recursive: true });
      copyFileSync(join(repoRoot, 'xflow', 'atoms', 'i6b_tdd_proof_validate.py'), join(repo, 'xflow', 'atoms', 'i6b_tdd_proof_validate.py'));
      copyFileSync(join(repoRoot, 'xflow', 'atoms', 'tdd_lib.py'), join(repo, 'xflow', 'atoms', 'tdd_lib.py'));
      writeFileSync(join(repo, 'README.md'), '# fixture\n');
      git(['add', '.']);
      git(['commit', '-qm', 'base']);
      const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();

      // A seal whose binding is deliberately wrong (tampered after sealing):
      // all required fields present, but the recorded binding hash matches nothing.
      mkdirSync(join(repo, 'specs', 'changes', 'demo-change', 'tdd'), { recursive: true });
      writeFileSync(join(repo, 'specs', 'changes', 'demo-change', 'tdd', 'green-0.json'), JSON.stringify({
        phase: 'green',
        attempt: 0,
        command: 'node --test test/demo.test.js',
        exit_code: 0,
        passed: true,
        recorded_at: '2026-11-12T00:00:00.000Z',
        binding: '0'.repeat(64),
        failure_kind: 'pass',
        file_hashes: {},
      }, null, 2));
      spawnSync('git', ['add', '-N', 'specs/changes/demo-change/tdd/green-0.json'], { cwd: repo, encoding: 'utf8' });
      const diff = spawnSync('git', ['diff'], { cwd: repo, encoding: 'utf8' }).stdout;
      const diffPath = join(dir, 'audit.diff');
      writeFileSync(diffPath, diff);

      const report = runAudit({ repoDir: repo, diffText: diff, baseRef: base, claimsText: 'Docs only.' });
      assert.equal(report.verdict, 'mismatch', JSON.stringify(report, null, 2));
      assert.equal(report.seals[0].verdict, 'binding_mismatch');
      assert.equal(report.seals[0].ok, false);

      const doc = auditReportToSarif(report, { version: '0.5.28' });
      assert.equal(doc.runs[0].results.length, 1);
      const [result] = doc.runs[0].results;
      assert.equal(result.ruleId, 'evalid/binding-mismatch');
      assert.equal(result.locations[0].physicalLocation.artifactLocation.uri, 'specs/changes/demo-change/tdd/green-0.json');
      assert.match(result.message.text, /binding_mismatch/);
      assert.match(result.message.text, /demo-change\/green\/0/);
      assert.deepEqual(validateSarif(doc), { ok: true, errors: [] });

      // Same finding through the real CLI.
      const sarifPath = join(dir, 'out.sarif');
      const cli = runCli(['audit', '--repo', repo, '--diff', diffPath, '--base', base, '--sarif', sarifPath], repoRoot);
      assert.equal(cli.status, 1, cli.stderr || cli.stdout); // mismatch
      assert.match(cli.stdout, /SARIF: .* \(1 finding\)/);
      const written = JSON.parse(readFileSync(sarifPath, 'utf8'));
      assert.equal(written.runs[0].results.length, 1);
      assert.equal(written.runs[0].results[0].ruleId, 'evalid/binding-mismatch');
      assert.deepEqual(validateSarif(written), { ok: true, errors: [] });
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
