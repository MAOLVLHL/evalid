import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// M3 slice 4: the acceptance demo (scripts/demo-i6d-gate.sh) must stay
// green — it drives the real `xflow audit` CLI end to end on two
// throwaway diffs, so a regression in the I6d gate wiring breaks this
// test instead of silently rotting the demo.
// Live pytest runs need a python with pytest importable (same approach as
// the i6d tests in test/xflow-audit.test.js: ambient interpreter, else a
// throwaway venv in tmpdir). If neither works, the test skips instead of
// failing on an environment gap.
const repoRoot = resolve(import.meta.dirname, '..');
const python = process.env.PYTHON || 'python3';

let pytestPython = null;
let pytestVenvDir = null;
// The venv is per test-file process; remove it when the process exits so
// repeated full-suite runs do not fill the 512M /tmp tmpfs (ENOSPC).
process.on('exit', () => {
  if (pytestVenvDir) rmSync(pytestVenvDir, { recursive: true, force: true });
});
function ensurePytestPython() {
  if (pytestPython !== null) return pytestPython;
  const check = spawnSync(python, ['-c', 'import pytest'], { encoding: 'utf8' });
  if (check.status === 0) {
    pytestPython = python;
    return pytestPython;
  }
  const venvDir = mkdtempSync(join(tmpdir(), 'evalid-i6d-demo-venv-'));
  const venv = spawnSync(python, ['-m', 'venv', venvDir], { encoding: 'utf8' });
  if (venv.status !== 0) {
    rmSync(venvDir, { recursive: true, force: true });
    return null;
  }
  const venvPython = join(venvDir, 'bin', 'python');
  const install = spawnSync(venvPython, ['-m', 'pip', 'install', '--quiet', 'pytest'], { encoding: 'utf8' });
  if (install.status !== 0) {
    rmSync(venvDir, { recursive: true, force: true });
    return null;
  }
  pytestVenvDir = venvDir;
  pytestPython = venvPython;
  return pytestPython;
}

const live = () => ensurePytestPython() === null && 'pytest unavailable and venv install failed';

test('M3 acceptance demo: dead-assert diff goes red, clean diff goes green (real xflow audit CLI)', { skip: live(), timeout: 300000 }, () => {
  const result = spawnSync('bash', [join(repoRoot, 'scripts', 'demo-i6d-gate.sh')], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 280000,
    env: { ...process.env, EVALID_I6D_PYTEST_PYTHON: ensurePytestPython() },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[RED\] PASS/);
  assert.match(result.stdout, /\[GREEN\] PASS/);
  assert.match(result.stdout, /M3 acceptance demo: PASS/);
});
