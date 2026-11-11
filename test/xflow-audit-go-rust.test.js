import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  extractClaims,
  goRustDepManifests,
  parseReplayCounts,
  runAudit,
  supplyGoRustDeps,
} from '../src/core/audit.js';

// M10 slice 1 (#156): audit recognises `go test` / `cargo test` claims
// (output parsing + count extraction) and supplies Go/Rust
// dependencies inside the replay tree (`go mod download all`,
// verified against go.sum; `cargo fetch --locked`, honouring
// Cargo.lock). Fixture outputs below are real `go test -v` (go 1.23.4)
// and `cargo test` (cargo 1.99.1) output captured 2026-11-12; the
// fixture repos are built from literals so the suite does not depend
// on a checkout of any real Go/Rust project.

// The CI image (ubuntu-24.04) does not guarantee go/cargo on PATH, so
// the toolchain-dependent tests skip when the binary cannot be found —
// the same pattern the I6d gate tests use for pytest. The pure parsing
// tests always run.
const HOME = process.env.HOME || '';

function findToolchain(binary, versionArgs, fallbackDirs) {
  if (spawnSync(binary, versionArgs, { encoding: 'utf8', timeout: 15000 }).status === 0) return binary;
  for (const dir of fallbackDirs) {
    const candidate = join(HOME, dir, binary);
    if (!existsSync(candidate)) continue;
    if (spawnSync(candidate, versionArgs, { encoding: 'utf8', timeout: 15000 }).status !== 0) continue;
    const binDir = join(HOME, dir);
    if (!String(process.env.PATH || '').split(':').includes(binDir)) {
      process.env.PATH = `${binDir}:${process.env.PATH || ''}`;
    }
    return candidate;
  }
  return null;
}

const GO_BIN = findToolchain('go', ['version'], ['workspace/tools/go/bin']);
const CARGO_BIN = findToolchain('cargo', ['--version'], ['.cargo/bin']);
if (GO_BIN && GO_BIN !== 'go') process.env.GO = GO_BIN;
if (CARGO_BIN && CARGO_BIN !== 'cargo') process.env.CARGO = CARGO_BIN;

const goMissing = () => (GO_BIN ? false : 'go toolchain not installed');
const cargoMissing = () => (CARGO_BIN ? false : 'cargo toolchain not installed');

// --- Real captured outputs (see the header comment) ---------------------

const GO_VERBOSE_PASS = [
  '=== RUN   TestAdd',
  '=== RUN   TestAdd/negative',
  '--- PASS: TestAdd (0.00s)',
  '    --- PASS: TestAdd/negative (0.00s)',
  '=== RUN   TestNewID',
  '--- PASS: TestNewID (0.00s)',
  'PASS',
  'ok  \texample.test/gofixture\t0.005s',
  '',
].join('\n');

const GO_VERBOSE_FAIL = [
  '=== RUN   TestAdd',
  '    calc_test.go:10: 2+3 should be 6',
  '--- FAIL: TestAdd (0.00s)',
  '=== RUN   TestNewID',
  '--- PASS: TestNewID (0.00s)',
  'FAIL',
  'FAIL\texample.test/gofixture\t0.003s',
  '',
].join('\n');

const GO_VERBOSE_SKIP = [
  '=== RUN   TestAdd',
  '--- PASS: TestAdd (0.00s)',
  '=== RUN   TestFlaky',
  '--- SKIP: TestFlaky (0.00s)',
  'PASS',
  'ok  \texample.test/gofixture\t0.004s',
  '',
].join('\n');

const GO_NONVERBOSE = 'ok  \texample.test/gofixture\t0.004s\n';

// M11 slice 1 (#162): testify first-level subtest FAIL lines sit at
// column 0 (real output, #159). The first three lines are verbatim
// from #159; the extra top-level PASS line stands in for the rest of
// the suite (472 passing top-level tests in the real run).
const GO_TESTIFY_SNIPPET = [
  '--- FAIL: TestSuiteRequireTwice/SuiteRequireTwice (0.00s)',
  '    --- FAIL: TestSuiteRequireTwice/SuiteRequireTwice/TestRequireOne (0.00s)',
  '--- PASS: TestSuiteRequireTwice (0.00s)',
  '--- PASS: TestSuiteRequireOnce (0.00s)',
  'PASS',
  'ok  \texample.test/gofixture\t0.005s',
  '',
].join('\n');

const CARGO_LIB = [
  '     Running unittests src/lib.rs (target/debug/deps/rsfix-d93ed7527dcbd007)',
  '',
  'running 2 tests',
  'test tests::adds ... ok',
  'test tests::renders_with_dep ... ok',
  '',
  'test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  '',
  '   Doc-tests rsfix',
  '',
  'running 0 tests',
  '',
  'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  '',
].join('\n');

const CARGO_MULTI = [
  '     Running unittests src/lib.rs (target/debug/deps/rsfix-d93ed7527dcbd007)',
  'running 2 tests',
  'test tests::adds ... ok',
  'test tests::renders_with_dep ... ok',
  'test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  '     Running tests/integration_test.rs (target/debug/deps/integration_test-8c28cfe267a253be)',
  'running 1 test',
  'test integration_adds ... ok',
  'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  '   Doc-tests rsfix',
  'running 0 tests',
  'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  '',
].join('\n');

const CARGO_FAIL = [
  'running 2 tests',
  'test tests::renders_with_dep ... ok',
  'test tests::adds ... FAILED',
  '',
  'failures:',
  '',
  '    tests::adds',
  '',
  'test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  '',
  'error: test failed, to rerun pass `--lib`',
  '',
].join('\n');

// --- Fixture repos (literals; go.sum / Cargo.lock pinned) ---------------

const GO_MOD = 'module example.test/gofixture\n\ngo 1.23\n\nrequire github.com/google/uuid v1.6.0\n';
const GO_SUM = [
  'github.com/google/uuid v1.6.0 h1:NIvaJDMOsjHA8n1jAhLSgzrAzy1Hgr+hNrb57e+94F0=',
  'github.com/google/uuid v1.6.0/go.mod h1:TIyPZe4MgqvfeYDBFedMoGGpEw/LqOeaOT+nhxU+yHo=',
  '',
].join('\n');
const GO_CALC = [
  'package calc',
  '',
  'import "github.com/google/uuid"',
  '',
  'func Add(a, b int) int { return a + b }',
  '',
  'func NewID() string { return uuid.NewString() }',
  '',
].join('\n');
const GO_CALC_TEST = [
  'package calc',
  '',
  'import (',
  '\t"strings"',
  '\t"testing"',
  ')',
  '',
  'func TestAdd(t *testing.T) {',
  '\tif Add(2, 3) != 5 {',
  '\t\tt.Fatal("2+3 should be 5")',
  '\t}',
  '\tt.Run("negative", func(t *testing.T) {',
  '\t\tif Add(-1, 1) != 0 {',
  '\t\t\tt.Fatal("-1+1 should be 0")',
  '\t\t}',
  '\t})',
  '}',
  '',
  'func TestNewID(t *testing.T) {',
  '\tif id := NewID(); len(strings.Split(id, "-")) != 5 {',
  '\t\tt.Fatalf("uuid should have 5 segments, got %q", id)',
  '\t}',
  '}',
  '',
].join('\n');

const CARGO_TOML = [
  '[package]',
  'name = "rsfix"',
  'version = "0.1.0"',
  'edition = "2021"',
  '',
  '[dependencies]',
  'itoa = "=1.0.19"',
  '',
].join('\n');
const CARGO_LOCK = [
  '# This file is automatically @generated by Cargo.',
  '# It is not intended for manual editing.',
  'version = 4',
  '',
  '[[package]]',
  'name = "itoa"',
  'version = "1.0.19"',
  'source = "registry+https://github.com/rust-lang/crates.io-index"',
  'checksum = "3bd1574e617a9a6c1f8f8181bd7e841e1f20e4277607ef28945765188d6284d4"',
  '',
  '[[package]]',
  'name = "rsfix"',
  'version = "0.1.0"',
  'dependencies = [',
  ' "itoa",',
  ']',
  '',
].join('\n');
const RS_LIB = [
  'pub fn add(a: i32, b: i32) -> i32 {',
  '    a + b',
  '}',
  '',
  'pub fn render(n: i64) -> String {',
  '    let mut buf = itoa::Buffer::new();',
  '    buf.format(n).to_string()',
  '}',
  '',
  '#[cfg(test)]',
  'mod tests {',
  '    use super::*;',
  '',
  '    #[test]',
  '    fn adds() {',
  '        assert_eq!(add(2, 3), 5);',
  '    }',
  '',
  '    #[test]',
  '    fn renders_with_dep() {',
  '        assert_eq!(render(42), "42");',
  '    }',
  '}',
  '',
].join('\n');
const RS_INTEGRATION_TEST = [
  '#[test]',
  'fn integration_adds() {',
  '    assert_eq!(rsfix::add(1, 2), 3);',
  '}',
  '',
].join('\n');

function git(dir, args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function makeGoRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'evalid-audit-go-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'audit-fixture@example.test']);
  git(repo, ['config', 'user.name', 'audit-fixture']);
  writeFileSync(join(repo, 'go.mod'), GO_MOD);
  writeFileSync(join(repo, 'go.sum'), GO_SUM);
  writeFileSync(join(repo, 'calc.go'), GO_CALC);
  writeFileSync(join(repo, 'calc_test.go'), GO_CALC_TEST);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'go fixture with external dep']);
  return repo;
}

function makeRustRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'evalid-audit-rs-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'audit-fixture@example.test']);
  git(repo, ['config', 'user.name', 'audit-fixture']);
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'tests'), { recursive: true });
  writeFileSync(join(repo, 'Cargo.toml'), CARGO_TOML);
  writeFileSync(join(repo, 'Cargo.lock'), CARGO_LOCK);
  writeFileSync(join(repo, 'src', 'lib.rs'), RS_LIB);
  writeFileSync(join(repo, 'tests', 'integration_test.rs'), RS_INTEGRATION_TEST);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'rust fixture with external dep']);
  return repo;
}

function headOf(repo) {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
}

describe('parseReplayCounts for go test (M10 slice 1, #156)', () => {
  test('reads go test -v top-level PASS/FAIL lines; subtests do not count', () => {
    // Real output: TestAdd has one subtest (indented --- PASS), so the
    // suite counts 2 top-level tests, not 3.
    assert.deepEqual(parseReplayCounts(GO_VERBOSE_PASS), { passed: 2, failed: 0, total: 2 });
  });

  test('reads go test -v failures', () => {
    assert.deepEqual(parseReplayCounts(GO_VERBOSE_FAIL), { passed: 1, failed: 1, total: 2 });
  });

  test('column-0 first-level subtest FAIL lines do not count (M11 slice 1, #162)', () => {
    // testify puts a first-level subtest FAIL at column 0 (#159); the
    // top-level test itself passes, so the suite has 0 failures.
    const output = [
      '--- FAIL: TestSuiteRequireTwice/SuiteRequireTwice (0.00s)',
      '--- PASS: TestSuiteRequireTwice (0.00s)',
      'PASS',
      'ok  \texample.test/gofixture\t0.005s',
      '',
    ].join('\n');
    assert.deepEqual(parseReplayCounts(output), { passed: 1, failed: 0, total: 1 });
  });

  test('indented subtest lines do not count (M11 slice 1, #162)', () => {
    const output = [
      '=== RUN   TestAdd',
      '=== RUN   TestAdd/negative',
      '--- PASS: TestAdd (0.00s)',
      '    --- PASS: TestAdd/negative (0.00s)',
      '    --- FAIL: TestAdd/broken (0.00s)',
      'PASS',
      'ok  \texample.test/gofixture\t0.005s',
      '',
    ].join('\n');
    assert.deepEqual(parseReplayCounts(output), { passed: 1, failed: 0, total: 1 });
  });

  test('testify snippet from #159 counts 2 passed / 0 failed (M11 slice 1, #162)', () => {
    assert.deepEqual(parseReplayCounts(GO_TESTIFY_SNIPPET), { passed: 2, failed: 0, total: 2 });
  });

  test('test name with spaces counts as one top-level test (M11 slice 3, #166)', () => {
    // Verbatim from the testify replay output (#165): the inner test
    // name "signature validation" contains a space, so the old (\S+)
    // tokeniser truncated it to "signature" and counted the parent
    // FAIL plus three indented subtest FAILs as four top-level
    // failures (and the indented PASS as a top-level pass). With the
    // full name the parent has no "/" — but its package reports ok,
    // so the whole group is a phantom and only the outer PASS counts.
    const output = [
      '--- FAIL: signature validation (0.00s)',
      '    --- FAIL: signature validation/TestInvalidSignatureArg (0.00s)',
      '    --- FAIL: signature validation/TestInvalidSignatureBoth (0.00s)',
      '    --- FAIL: signature validation/TestInvalidSignatureReturnValue (0.00s)',
      '    --- PASS: signature validation/TestValidSignature (0.00s)',
      '--- PASS: TestSuiteSignatureValidation (0.00s)',
      'PASS',
      'ok  \tgithub.com/stretchr/testify/suite\t11.088s',
      '',
    ].join('\n');
    assert.deepEqual(parseReplayCounts(output), { passed: 1, failed: 0, total: 1 });
  });

  test('RunTests inner test without "/" in an ok package does not count (M11 slice 3, #166)', () => {
    // Verbatim shape from the testify replay output (#165): testify
    // runs the inner test through testing.RunTests with a name glued
    // without "/" ("TestSuiteRecoverPanicInBeforeTest"); the outer
    // test passes and the package reports ok, so the column-0 FAIL
    // line is a phantom, not a top-level failure.
    const output = [
      '--- FAIL: TestSuiteRecoverPanicInBeforeTest (0.00s)',
      '    --- FAIL: TestSuiteRecoverPanicInBeforeTest/Test (0.00s)',
      '--- PASS: TestSuiteRecoverPanic (0.00s)',
      'PASS',
      'ok  \tgithub.com/stretchr/testify/suite\t11.088s',
      '',
    ].join('\n');
    assert.deepEqual(parseReplayCounts(output), { passed: 1, failed: 0, total: 1 });
  });

  test('package attribution boundary: FAIL counts in a FAIL package, not in an ok one (M11 slice 3, #166)', () => {
    // A slash-less FAIL line in an ok package is excused, while the
    // same shape of line in a later FAIL package still counts; the
    // attribution follows the next package result line, not the
    // previous one.
    const output = [
      '=== RUN   TestOK',
      '--- PASS: TestOK (0.00s)',
      '--- FAIL: TestGlueNoSlash (0.00s)',
      'PASS',
      'ok  \texample.test/good\t0.005s',
      '=== RUN   TestBad',
      '--- FAIL: TestBad (0.00s)',
      '--- PASS: TestGood (0.00s)',
      'FAIL',
      'FAIL\texample.test/bad\t0.003s',
      '',
    ].join('\n');
    assert.deepEqual(parseReplayCounts(output), { passed: 2, failed: 1, total: 3 });
  });

  test('without package result lines, slash-less FAIL lines still count (M11 slice 3, #166)', () => {
    // No "ok"/"FAIL" package line means the attribution cannot be
    // made, so the top-level-only rule applies unchanged (a FAIL
    // line after the last package line is likewise counted: a
    // truncated tail must not silently excuse a real failure).
    const noPackageLines = [
      '--- FAIL: TestAdd (0.00s)',
      '--- PASS: TestNewID (0.00s)',
      '',
    ].join('\n');
    assert.deepEqual(parseReplayCounts(noPackageLines), { passed: 1, failed: 1, total: 2 });
    const trailingFail = [
      '--- PASS: TestA (0.00s)',
      'PASS',
      'ok  \texample.test/good\t0.005s',
      '--- FAIL: TestTrailing (0.00s)',
      '',
    ].join('\n');
    assert.deepEqual(parseReplayCounts(trailingFail), { passed: 1, failed: 1, total: 2 });
  });

  test('skipped tests are neither passed nor failed', () => {
    assert.deepEqual(parseReplayCounts(GO_VERBOSE_SKIP), { passed: 1, failed: 0, total: 1 });
  });

  test('non-verbose go test has no per-test counts (exit code decides)', () => {
    assert.equal(parseReplayCounts(GO_NONVERBOSE), null);
    assert.equal(parseReplayCounts('FAIL\texample.test/gofixture\t0.003s\n'), null);
  });
});

describe('parseReplayCounts for cargo test (M10 slice 1, #156)', () => {
  test('reads one test result summary (lib + empty doc-tests)', () => {
    assert.deepEqual(parseReplayCounts(CARGO_LIB), { passed: 2, failed: 0, total: 2 });
  });

  test('sums summaries across test binaries (disjoint test sets)', () => {
    // lib 2 + integration 1 + doc-tests 0 = 3.
    assert.deepEqual(parseReplayCounts(CARGO_MULTI), { passed: 3, failed: 0, total: 3 });
  });

  test('reads a FAILED summary', () => {
    assert.deepEqual(parseReplayCounts(CARGO_FAIL), { passed: 1, failed: 1, total: 2 });
  });
});

describe('extractClaims for go test / cargo test (M10 slice 1, #156)', () => {
  test('recognises go test claims with counts and exit', () => {
    const claims = extractClaims('Tests: `go test -v ./...` — 2 passed, 0 failed.');
    assert.equal(claims.length, 1);
    assert.equal(claims[0].command, 'go test -v ./...');
    assert.equal(claims[0].claimedPassed, 2);
    assert.equal(claims[0].claimedFailed, 0);
    assert.equal(claims[0].claimedExit, 0);
  });

  test('recognises cargo test claims', () => {
    const claims = extractClaims('Tests: `cargo test` 3 passed.');
    assert.equal(claims.length, 1);
    assert.equal(claims[0].command, 'cargo test');
    assert.equal(claims[0].claimedPassed, 3);
    assert.equal(claims[0].claimedExit, 0);
  });
});

describe('Go/Rust dependency supply (M10 slice 1, #156)', () => {
  test('goRustDepManifests detects manifests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evalid-audit-manifests-'));
    try {
      assert.deepEqual(goRustDepManifests(dir), { goMod: false, goSum: false, cargoToml: false, cargoLock: false });
      writeFileSync(join(dir, 'go.mod'), GO_MOD);
      writeFileSync(join(dir, 'go.sum'), GO_SUM);
      writeFileSync(join(dir, 'Cargo.toml'), CARGO_TOML);
      assert.deepEqual(goRustDepManifests(dir), { goMod: true, goSum: true, cargoToml: true, cargoLock: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('go mod download supplies a module sealed by go.sum', { skip: goMissing() }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'evalid-audit-supply-go-'));
    try {
      writeFileSync(join(dir, 'go.mod'), GO_MOD);
      writeFileSync(join(dir, 'go.sum'), GO_SUM);
      const supplied = supplyGoRustDeps(dir, { only: ['go'] });
      assert.deepEqual(supplied, { go: { status: 'supplied', command: 'go mod download all' } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cargo fetch --locked supplies a crate sealed by Cargo.lock', { skip: cargoMissing() }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'evalid-audit-supply-rs-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'lib.rs'), '');
      writeFileSync(join(dir, 'Cargo.toml'), CARGO_TOML);
      writeFileSync(join(dir, 'Cargo.lock'), CARGO_LOCK);
      const supplied = supplyGoRustDeps(dir, { only: ['cargo'] });
      assert.deepEqual(supplied, { cargo: { status: 'supplied', command: 'cargo fetch --locked' } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing toolchain reports missing_toolchain, never a silent skip', { skip: goMissing() }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'evalid-audit-supply-missing-'));
    try {
      writeFileSync(join(dir, 'go.mod'), GO_MOD);
      writeFileSync(join(dir, 'go.sum'), GO_SUM);
      const supplied = supplyGoRustDeps(dir, { go: 'no-such-go-xyz', only: ['go'] });
      assert.equal(supplied.go.status, 'missing_toolchain');
      assert.equal(supplied.go.command, 'go mod download all');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a go.sum hash drift fails the supply explicitly', { skip: goMissing() }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'evalid-audit-supply-tamper-go-'));
    try {
      writeFileSync(join(dir, 'go.mod'), GO_MOD);
      // One flipped hash character: the download must refuse the seal.
      writeFileSync(join(dir, 'go.sum'), GO_SUM.replace('h1:NIva', 'h1:AIva'));
      const supplied = supplyGoRustDeps(dir, { only: ['go'] });
      assert.equal(supplied.go.status, 'failed');
      assert.match(supplied.go.error, /does NOT match an earlier download recorded in go\.sum/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a Cargo.lock out of sync fails the supply explicitly', { skip: cargoMissing() }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'evalid-audit-supply-tamper-rs-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'lib.rs'), '');
      writeFileSync(join(dir, 'Cargo.toml'), CARGO_TOML);
      writeFileSync(join(dir, 'Cargo.lock'), CARGO_LOCK.replace('version = "1.0.19"', 'version = "1.0.20"'));
      const supplied = supplyGoRustDeps(dir, { only: ['cargo'] });
      assert.equal(supplied.cargo.status, 'failed');
      assert.match(supplied.cargo.error, /--locked|lock file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runAudit end-to-end on Go/Rust fixture repos (M10 slice 1, #156)', () => {
  test('verifies an honest go test claim with a real external dep', { skip: goMissing() }, () => {
    const repo = makeGoRepo();
    try {
      const report = runAudit({
        repoDir: repo,
        headRef: headOf(repo),
        claimsText: 'Tests: `go test -v ./...` — 2 passed, 0 failed.',
      });
      assert.equal(report.verdict, 'verified', JSON.stringify(report, null, 2));
      assert.equal(report.claims.length, 1);
      assert.equal(report.claims[0].match, true);
      assert.deepEqual(report.claims[0].replay.counts, { passed: 2, failed: 0, total: 2 });
      assert.equal(report.goRust.go.status, 'supplied');
      assert.match(report.setup.deps, /go mod download all/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('mismatches an inflated go test count', { skip: goMissing() }, () => {
    const repo = makeGoRepo();
    try {
      const report = runAudit({
        repoDir: repo,
        headRef: headOf(repo),
        claimsText: 'Tests: `go test -v ./...` — 3 passed, 0 failed.',
      });
      assert.equal(report.verdict, 'mismatch', JSON.stringify(report, null, 2));
      assert.equal(report.claims[0].match, false);
      assert.match(report.claims[0].note, /passed count: claimed 3, replayed 2/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('verifies an honest cargo test claim with a real external dep', { skip: cargoMissing() }, () => {
    const repo = makeRustRepo();
    try {
      const report = runAudit({
        repoDir: repo,
        headRef: headOf(repo),
        claimsText: 'Tests: `cargo test` — 3 passed, 0 failed.',
      });
      assert.equal(report.verdict, 'verified', JSON.stringify(report, null, 2));
      assert.equal(report.claims.length, 1);
      assert.equal(report.claims[0].match, true);
      assert.deepEqual(report.claims[0].replay.counts, { passed: 3, failed: 0, total: 3 });
      assert.equal(report.goRust.cargo.status, 'supplied');
      assert.match(report.setup.deps, /cargo fetch --locked/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('mismatches an understated cargo test count', { skip: cargoMissing() }, () => {
    const repo = makeRustRepo();
    try {
      const report = runAudit({
        repoDir: repo,
        headRef: headOf(repo),
        claimsText: 'Tests: `cargo test` — 2 passed, 0 failed.',
      });
      assert.equal(report.verdict, 'mismatch', JSON.stringify(report, null, 2));
      assert.equal(report.claims[0].match, false);
      assert.match(report.claims[0].note, /passed count: claimed 2, replayed 3/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('a JS-only claim does not attempt Go supply for a stray go.mod', () => {
    const repo = mkdtempSync(join(tmpdir(), 'evalid-audit-scope-'));
    try {
      git(repo, ['init', '-q', '-b', 'main']);
      git(repo, ['config', 'user.email', 'audit-fixture@example.test']);
      git(repo, ['config', 'user.name', 'audit-fixture']);
      mkdirSync(join(repo, 'test'), { recursive: true });
      writeFileSync(join(repo, 'test', 'a.test.js'), [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "test('one', () => { assert.equal(1 + 1, 2); });",
        '',
      ].join('\n'));
      // A stray manifest with no go claim: supply must not run, so a
      // missing go toolchain cannot turn this audit unverifiable.
      writeFileSync(join(repo, 'go.mod'), GO_MOD);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-qm', 'js fixture with stray go.mod']);
      const report = runAudit({
        repoDir: repo,
        headRef: headOf(repo),
        claimsText: 'Tests: `node --test test/a.test.js` — 1 passed.',
      });
      assert.equal(report.verdict, 'verified', JSON.stringify(report, null, 2));
      assert.deepEqual(report.goRust, {});
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
