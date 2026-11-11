import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = process.cwd();

describe('J1 tests runner', () => {
  test('falls back to tdd_green_command from change contract when plan has no bash block', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'openflow-j1-'));
    try {
      const changeRoot = resolve(projectRoot, 'specs', 'changes', 'chg-j1-contract');
      mkdirSync(changeRoot, { recursive: true });
      writeFileSync(resolve(changeRoot, 'plan.md'), '# Plan\n\nNo command block here.\n', 'utf8');
      writeFileSync(resolve(changeRoot, 'corps-input.json'), JSON.stringify({
        tdd_green_command: 'node -e "process.exit(0)"',
      }, null, 2), 'utf8');

      const result = spawnSync('python3', [
        'xflow/atoms/j1_tests_run.py',
        '--project-root',
        projectRoot,
        '--change-id',
        'chg-j1-contract',
      ], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const proof = JSON.parse(readFileSync(resolve(changeRoot, 'verify_proof.json'), 'utf8'));
      assert.equal(proof.all_passed, true);
      assert.equal(proof.results[0].command, 'node -e "process.exit(0)"');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('does not leak its orchestration CHANGE_ID into verification commands', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'openflow-j1-'));
    try {
      const changeRoot = resolve(projectRoot, 'specs', 'changes', 'chg-j1-env');
      mkdirSync(changeRoot, { recursive: true });
      writeFileSync(resolve(changeRoot, 'plan.md'), [
        '# Plan',
        '',
        '## Verification Commands',
        '',
        '```bash',
        'python3 -c "import os, sys; sys.exit(1 if os.environ.get(\'CHANGE_ID\') else 0)"',
        '```',
        '',
      ].join('\n'), 'utf8');

      const result = spawnSync('python3', [
        'xflow/atoms/j1_tests_run.py',
        '--project-root',
        projectRoot,
        '--change-id',
        'chg-j1-env',
      ], {
        cwd: REPO_ROOT,
        env: { ...process.env, CHANGE_ID: 'outer-orchestration-change' },
        encoding: 'utf8',
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const proof = JSON.parse(readFileSync(resolve(changeRoot, 'verify_proof.json'), 'utf8'));
      assert.equal(proof.all_passed, true);
      assert.equal(proof.results[0].passed, true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('J1 agent/model identity (M7 slice 1, #139)', () => {
  function runJ1(projectRoot, changeId, { args = [], env = {} } = {}) {
    return spawnSync('python3', [
      'xflow/atoms/j1_tests_run.py',
      '--project-root',
      projectRoot,
      '--change-id',
      changeId,
      ...args,
    ], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
  }

  function seedChange(projectRoot, changeId) {
    const changeRoot = resolve(projectRoot, 'specs', 'changes', changeId);
    mkdirSync(changeRoot, { recursive: true });
    writeFileSync(resolve(changeRoot, 'plan.md'), [
      '# Plan',
      '',
      '```bash',
      'node -e "process.exit(0)"',
      '```',
      '',
    ].join('\n'), 'utf8');
    return changeRoot;
  }

  test('writes explicit --agent/--model flags into verify_proof.json', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'openflow-j1-agent-'));
    try {
      const changeRoot = seedChange(projectRoot, 'chg-j1-flags');
      const result = runJ1(projectRoot, 'chg-j1-flags', {
        args: ['--agent', 'pi', '--model', 'minimax-m3.1-flash'],
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const proof = JSON.parse(readFileSync(resolve(changeRoot, 'verify_proof.json'), 'utf8'));
      assert.equal(proof.agent, 'pi');
      assert.equal(proof.model, 'minimax-m3.1-flash');
      assert.equal(proof.all_passed, true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('falls back to EVALID_AGENT/EVALID_MODEL env vars when no flags given', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'openflow-j1-agent-'));
    try {
      const changeRoot = seedChange(projectRoot, 'chg-j1-envvars');
      const result = runJ1(projectRoot, 'chg-j1-envvars', {
        env: { EVALID_AGENT: 'codex', EVALID_MODEL: 'gpt-5' },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const proof = JSON.parse(readFileSync(resolve(changeRoot, 'verify_proof.json'), 'utf8'));
      assert.equal(proof.agent, 'codex');
      assert.equal(proof.model, 'gpt-5');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('explicit flags win over env vars, per-field', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'openflow-j1-agent-'));
    try {
      const changeRoot = seedChange(projectRoot, 'chg-j1-precedence');
      const result = runJ1(projectRoot, 'chg-j1-precedence', {
        args: ['--agent', 'pi'],
        env: { EVALID_AGENT: 'codex', EVALID_MODEL: 'gpt-5' },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const proof = JSON.parse(readFileSync(resolve(changeRoot, 'verify_proof.json'), 'utf8'));
      assert.equal(proof.agent, 'pi');
      assert.equal(proof.model, 'gpt-5');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('missing identity writes unknown, never invents a value; blank values count as missing', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'openflow-j1-agent-'));
    try {
      const changeRoot = seedChange(projectRoot, 'chg-j1-unknown');
      const env = { ...process.env };
      delete env.EVALID_AGENT;
      delete env.EVALID_MODEL;
      const result = spawnSync('python3', [
        'xflow/atoms/j1_tests_run.py',
        '--project-root',
        projectRoot,
        '--change-id',
        'chg-j1-unknown',
      ], { cwd: REPO_ROOT, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      let proof = JSON.parse(readFileSync(resolve(changeRoot, 'verify_proof.json'), 'utf8'));
      assert.equal(proof.agent, 'unknown');
      assert.equal(proof.model, 'unknown');

      const blank = runJ1(projectRoot, 'chg-j1-unknown', {
        args: ['--agent', '  ', '--model', ''],
        env: { EVALID_AGENT: ' ', EVALID_MODEL: '' },
      });
      assert.equal(blank.status, 0, blank.stderr || blank.stdout);
      proof = JSON.parse(readFileSync(resolve(changeRoot, 'verify_proof.json'), 'utf8'));
      assert.equal(proof.agent, 'unknown');
      assert.equal(proof.model, 'unknown');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
