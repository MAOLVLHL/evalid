import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = process.cwd();

// M8 slice 1 (#144): the I6b replay tree is rebuilt from `git archive`,
// which never contains node_modules, so a test importing an npm
// dependency used to fail with no_test_evidence instead of its real
// red/green result (#111). The replay now runs the sealed install step
// inside the replay tree before the test command, and the seal covers
// the install result (lockfile + package.json hashes and the installed
// top-level versions). Any divergence is an explicit
// replay_install_failed, never a silent run without dependencies.

function runAtom(script, projectRoot, args = [], timeout = 20000) {
  return spawnSync('python3', [
    resolve(REPO_ROOT, script),
    '--project-root',
    projectRoot,
    '--change-id',
    'chg-tdd',
    ...args,
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout,
  });
}

function git(projectRoot, args) {
  const result = spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function npm(projectRoot, args, timeout = 60000) {
  const result = spawnSync('npm', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function writeDepFixture(projectRoot, version = '1.0.0', tag = 'v1') {
  mkdirSync(resolve(projectRoot, 'vendor', 'my-dep'), { recursive: true });
  mkdirSync(resolve(projectRoot, 'src'), { recursive: true });
  mkdirSync(resolve(projectRoot, 'test'), { recursive: true });
  mkdirSync(resolve(projectRoot, 'specs', 'changes', 'chg-tdd'), { recursive: true });
  writeFileSync(resolve(projectRoot, 'package.json'), JSON.stringify({
    name: 'replay-deps-fixture',
    type: 'module',
    dependencies: { 'my-dep': 'file:./vendor/my-dep' },
  }, null, 2) + '\n');
  writeFileSync(resolve(projectRoot, 'vendor', 'my-dep', 'package.json'), JSON.stringify({
    name: 'my-dep',
    version,
    type: 'module',
    main: 'index.js',
    exports: { '.': './index.js' },
  }, null, 2) + '\n');
  writeFileSync(resolve(projectRoot, 'vendor', 'my-dep', 'index.js'), `export function tag() { return '${tag}'; }\n`);
  writeFileSync(resolve(projectRoot, 'src', 'greet.js'), [
    "import { tag } from 'my-dep';",
    "export function greet() { return `hello-${tag()}`; }",
    '',
  ].join('\n'));
  writeFileSync(resolve(projectRoot, 'test', 'greet.test.js'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { greet } from '../src/greet.js';",
    "test('greets with the dependency tag', () => { assert.equal(greet(), 'hello-v1'); });",
    '',
  ].join('\n'));
}

function makeDepRepo() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'openflow-replay-deps-'));
  git(projectRoot, ['init']);
  git(projectRoot, ['config', 'user.email', 'xflow@example.test']);
  git(projectRoot, ['config', 'user.name', 'xflow test']);
  writeDepFixture(projectRoot);
  // file: dependencies install offline; this writes package-lock.json
  // and the seal-time node_modules the proof runs against.
  npm(projectRoot, ['install', '--no-audit', '--no-fund']);
  git(projectRoot, ['add', 'package.json', 'package-lock.json', 'vendor', 'src', 'test', 'specs']);
  git(projectRoot, ['commit', '-m', 'baseline with npm dep']);
  return projectRoot;
}

function readProof(projectRoot, phase = 'green') {
  return JSON.parse(readFileSync(
    resolve(projectRoot, 'specs', 'changes', 'chg-tdd', 'tdd', `${phase}-0.json`),
    'utf8',
  ));
}

function sealGreen(projectRoot) {
  const run = runAtom('xflow/atoms/i6a_tdd_run.py', projectRoot, [
    '--phase', 'green', '--test-command', 'node --test test/greet.test.js',
  ]);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return readProof(projectRoot);
}

describe('replay dependency supply (M8 slice 1, #144)', () => {
  test('detect_install_step picks the frozen step from the lockfile present', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'openflow-install-detect-'));
    try {
      const check = spawnSync('python3', ['-c', [
        'import sys, json',
        'sys.path.insert(0, "xflow/atoms")',
        'import tdd_lib',
        'from pathlib import Path',
        'root = Path(sys.argv[1])',
        'assert tdd_lib.detect_install_step(root) is None',
        '(root / "package.json").write_text("{}")',
        'step = tdd_lib.detect_install_step(root)',
        'assert step == {"tool": "npm", "command": "npm install --no-audit --no-fund", "lockfile": None}, step',
        'assert tdd_lib.seal_install_record(root)["installed"] is None',
        '(root / "package-lock.json").write_text("{}")',
        'step = tdd_lib.detect_install_step(root)',
        'assert step == {"tool": "npm", "command": "npm ci --no-audit --no-fund", "lockfile": "package-lock.json"}, step',
        '(root / "package-lock.json").unlink()',
        '(root / "bun.lock").write_text("")',
        'step = tdd_lib.detect_install_step(root)',
        'assert step == {"tool": "bun", "command": "bun install --frozen-lockfile", "lockfile": "bun.lock"}, step',
        '(root / "bun.lock").unlink()',
        '(root / "yarn.lock").write_text("")',
        'step = tdd_lib.detect_install_step(root)',
        'assert step["tool"] == "yarn" and step["lockfile"] == "yarn.lock", step',
      ].join('\n'), projectRoot], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000 });
      assert.equal(check.status, 0, check.stderr || check.stdout);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('a test importing an npm dep really executes in the replay tree', () => {
    const projectRoot = makeDepRepo();
    try {
      const proof = sealGreen(projectRoot);
      assert.equal(proof.install.command, 'npm ci --no-audit --no-fund');
      assert.equal(proof.install.lockfile, 'package-lock.json');
      assert.equal(proof.install.installed['my-dep'], '1.0.0');
      assert.equal(proof.failure_kind, 'passed');

      // The replay tree is rebuilt from `git archive` (no node_modules
      // in git): validation can only pass if the replay ran npm ci
      // first and the test really executed against the dep.
      const validate = runAtom('xflow/atoms/i6b_tdd_proof_validate.py', projectRoot, ['--phase', 'green']);
      assert.equal(validate.status, 0, validate.stderr || validate.stdout);
      assert.equal(JSON.parse(validate.stdout).verdict, 'valid');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('a lockfile out of sync with package.json fails the replay explicitly', () => {
    const projectRoot = makeDepRepo();
    try {
      sealGreen(projectRoot);
      // The seal ran against the stale node_modules, so it still passes;
      // the replay's `npm ci` must refuse the out-of-sync lockfile
      // instead of running the tests without dependencies.
      const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));
      pkg.dependencies['no-such-package-xyz'] = '^9.9.9';
      writeFileSync(resolve(projectRoot, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
      const rerun = runAtom('xflow/atoms/i6a_tdd_run.py', projectRoot, [
        '--phase', 'green', '--test-command', 'node --test test/greet.test.js',
      ]);
      assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
      const validate = runAtom('xflow/atoms/i6b_tdd_proof_validate.py', projectRoot, ['--phase', 'green']);
      assert.notEqual(validate.status, 0, validate.stdout);
      assert.match(validate.stdout, /replay_install_failed/);
      assert.match(validate.stdout, /npm ci/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('an installed version drift from the seal fails the replay explicitly', () => {
    const projectRoot = makeDepRepo();
    try {
      sealGreen(projectRoot);
      // Point the dep at a second vendored copy at 2.0.0 and refresh
      // only the lockfile; the seal-time node_modules still holds 1.0.0,
      // so the seal passes but the replay installs 2.0.0.
      mkdirSync(resolve(projectRoot, 'vendor', 'my-dep2'), { recursive: true });
      writeFileSync(resolve(projectRoot, 'vendor', 'my-dep2', 'package.json'), JSON.stringify({
        name: 'my-dep',
        version: '2.0.0',
        type: 'module',
        main: 'index.js',
        exports: { '.': './index.js' },
      }, null, 2) + '\n');
      writeFileSync(resolve(projectRoot, 'vendor', 'my-dep2', 'index.js'), "export function tag() { return 'v2'; }\n");
      const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));
      pkg.dependencies['my-dep'] = 'file:./vendor/my-dep2';
      writeFileSync(resolve(projectRoot, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
      npm(projectRoot, ['install', '--package-lock-only', '--no-audit', '--no-fund']);
      assert.equal(readProof(projectRoot).install.installed['my-dep'], '1.0.0');
      const rerun = runAtom('xflow/atoms/i6a_tdd_run.py', projectRoot, [
        '--phase', 'green', '--test-command', 'node --test test/greet.test.js',
      ]);
      assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
      const proof = readProof(projectRoot);
      assert.equal(proof.install.installed['my-dep'], '1.0.0');
      const validate = runAtom('xflow/atoms/i6b_tdd_proof_validate.py', projectRoot, ['--phase', 'green']);
      assert.notEqual(validate.status, 0, validate.stdout);
      assert.match(validate.stdout, /replay_install_failed/);
      assert.match(validate.stdout, /my-dep: sealed 1\.0\.0 vs replay 2\.0\.0/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('proofs sealed before the install field existed still validate', () => {
    const projectRoot = makeDepRepo();
    try {
      sealGreen(projectRoot);
      const proofPath = resolve(projectRoot, 'specs', 'changes', 'chg-tdd', 'tdd', 'green-0.json');
      const strip = spawnSync('python3', ['-c', [
        'import sys, json',
        'sys.path.insert(0, "xflow/atoms")',
        'import tdd_lib',
        'path = sys.argv[1]',
        'proof = json.load(open(path))',
        'proof.pop("install", None)',
        'proof["binding"] = tdd_lib.compute_binding(proof)',
        'json.dump(proof, open(path, "w"), indent=2)',
      ].join('\n'), proofPath], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000 });
      assert.equal(strip.status, 0, strip.stderr || strip.stdout);
      const validate = runAtom('xflow/atoms/i6b_tdd_proof_validate.py', projectRoot, ['--phase', 'green']);
      assert.equal(validate.status, 0, validate.stderr || validate.stdout);
      assert.equal(JSON.parse(validate.stdout).verdict, 'valid');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
