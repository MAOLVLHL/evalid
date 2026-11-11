/**
 * xflow audit — standalone audit of any git diff / PR, without adopting
 * evalid workflows.
 *
 * An audit answers one question: do the test runs this change *claims* to
 * have passed actually pass when replayed from a clean copy at the change's
 * head? It extracts claimed test commands from the PR body / claims text,
 * replays each command in a scratch clone (base commit + diff applied, or
 * the PR's merge commit checked out directly), and compares exit codes and
 * pass/fail counts against the claim. Diffs that carry an evalid proof seal
 * (specs/changes/<id>/tdd/<phase>-<attempt>.json) are additionally replayed
 * through the existing i6b seal validator — the seal semantics are reused,
 * not rebuilt.
 *
 * Verdicts:
 *   verified     — every claim replayed as claimed (and every seal valid)
 *   mismatch     — a replay contradicts a claim, or a seal is invalid
 *   no_claims    — no test claims found in the supplied text
 *   unverifiable — a claimed command could not run (missing runner, timeout)
 *
 * Slice 3 (M3, issue #86) adds the I6d assertion-execution gate to the
 * replay: when the diff touches Python test files (or a pytest run is
 * claimed) and the audited repo carries the I6d plugin
 * (xflow/atoms/i6d_assertion_execution.py), the gate runs in the scratch
 * clone, scoped to the diff. A pytest run can exit 0 while an assertion
 * inside a never-called callback never executes -- that change must not
 * count as green, so unexecuted in-diff assertions flip the verdict to
 * mismatch. When the plugin is absent, the diff touches no Python tests,
 * or pytest is unavailable, the gate reports not applicable and the
 * verdict is unchanged (the audit stays usable for any repo).
 *
 * Exit codes mirror the verdicts: 0 verified, 1 mismatch/unverifiable,
 * 2 misuse, 3 no_claims (inconclusive, not a failure of the change).
 *
 * Slice 1 (M6, issue #132) adds bun test recognition (claim extraction
 * and replay-count parsing for `bun test` / `bun run test`, whose
 * summary is count-first: " N pass / N fail / Ran N tests across M
 * files") and a node_modules snapshot-consistency judgement on the
 * replay tree: a missing snapshot with unchanged dependencies is an
 * environment gap, not a mismatch (the #111 root cause, classified at
 * the audit level), while a real inconsistency names the exact
 * differing files. The judgement only classifies — it never flips a
 * verdict by itself.
 *
 * Slice 3 (M6, issue #135) fixes two slice-1 precision gaps in that
 * judgement: optional packages a successful install legitimately
 * skips (platform packages, pruned optional transitives) no longer
 * count as inconsistencies, bun.lock is parsed as a lockfile
 * authority, and a repo with no trustworthy lockfile reports
 * cannot-determine instead of a hollow consistent.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Commands that count as claimed test runs. */
export const TEST_COMMAND_PATTERNS = [
  /npm\s+test\b/,
  /npm\s+run\s+[\w:.-]+/,
  /pnpm\s+test\b/,
  /yarn\s+test\b/,
  /node\s+--test\b/,
  /pytest\b/,
  /python3?\s+-m\s+pytest\b/,
  /python3?\s+-m\s+unittest\b/,
  /go\s+test\b/,
  /cargo\s+test\b/,
  /mvn\s+(?:-[^ ]+\s+)*test\b/,
  /npx\s+[\w@./-]+/,
  /bun\s+test\b/,
  /bun\s+run\s+[\w:.-]+/,
];

const COMMAND_CHARS = String.raw`[\w@./:+\-='"]`;
const COMMAND_TAIL = new RegExp(
  String.raw`(?:npm\s+test|npm\s+run\s+[\w:.-]+|pnpm\s+test|yarn\s+test|node\s+--test(?:\s+${COMMAND_CHARS}+)*|pytest(?:\s+${COMMAND_CHARS}+)*|python3?\s+-m\s+pytest(?:\s+${COMMAND_CHARS}+)*|python3?\s+-m\s+unittest(?:\s+${COMMAND_CHARS}+)*|go\s+test(?:\s+${COMMAND_CHARS}+)*|cargo\s+test(?:\s+${COMMAND_CHARS}+)*|mvn\s+(?:-[^\s]+\s+)*test|npx\s+[\w@./-]+(?:\s+${COMMAND_CHARS}+)*|bun\s+test(?:\s+${COMMAND_CHARS}+)*|bun\s+run\s+[\w:.-]+)`,
);

export function isTestCommand(text) {
  return TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(text));
}

export function isTestFile(path) {
  return /(^|\/)test(s)?\/|\.test\.[cm]?[jt]sx?$|_test\.go$|^test_[^/]*\.py$|_test\.py$|\.spec\.[cm]?[jt]sx?$/.test(path);
}

/** Python files pytest collects as tests by default (test_*.py / *_test.py). */
export function isPythonTestFile(path) {
  const name = String(path || '').split('/').pop();
  return /\.py$/.test(name) && (name.startsWith('test_') || name.endsWith('_test.py'));
}

/**
 * JS files node --test collects as tests by default
 * (*.test.{js,mjs,cjs} / test-*.{js,mjs,cjs}). Kept in sync with
 * is_javascript_test_file in xflow/atoms/i6d_assertion_execution.py
 * and isJavaScriptTestFile in i6d_assertion_execution_js.js (M3 #120).
 */
export function isJavaScriptTestFile(path) {
  const name = String(path || '').split('/').pop();
  return /\.test\.(js|mjs|cjs)$/.test(name) || /^test-.*\.(js|mjs|cjs)$/.test(name);
}

/**
 * Run the I6d assertion-execution gate in an audit scratch clone.
 * Scope comes from the audit's diff text (--diff-file in the I6d CLI),
 * so uncommitted diffs work without committing anything.
 *
 * Returns `{ applicable: false, reason }` when the gate cannot apply
 * (no plugin in the audited repo, no Python test changes and no pytest
 * claim, pytest unavailable), and `{ applicable: true, verdict, ... }`
 * otherwise. `pytest_failed` in the gate run does NOT flip the audit
 * verdict by itself -- a failing pytest run is the claim replay's job
 * to judge; only `unexecuted_assertions` (and gate errors) change it.
 */
export function runI6dCheck(workdir, options = {}) {
  const {
    diffText = '',
    claims = [],
    python = process.env.PYTHON || 'python3',
    timeoutMs = 300000,
  } = options;
  const plugin = join(workdir, 'xflow', 'atoms', 'i6d_assertion_execution.py');
  if (!existsSync(plugin)) {
    return { applicable: false, reason: 'plugin_not_present' };
  }
  const { files } = parseDiffFiles(diffText);
  const changedPyTests = files.filter(isPythonTestFile);
  const changedJsTests = files.filter(isJavaScriptTestFile);
  const hasPytestClaim = claims.some((claim) => /\bpytest\b/.test(claim.command || ''));
  const hasNodeTestClaim = claims.some((claim) => /(\bnode\b[^\n]*\b--test\b|\bnpm\b[^\n]*\btest\b)/.test(claim.command || ''));
  if (changedPyTests.length === 0 && changedJsTests.length === 0 && !hasPytestClaim && !hasNodeTestClaim) {
    return { applicable: false, reason: 'no_python_test_changes' };
  }
  const targets = changedPyTests.filter((file) => existsSync(join(workdir, file)));
  if (targets.length === 0 && changedJsTests.length === 0 && !hasPytestClaim && !hasNodeTestClaim) {
    return { applicable: false, reason: 'no_python_test_changes' };
  }
  // pytest is only required when the Python half has something to judge;
  // a JS-only diff is judged by the node half without it (M3 #120).
  const needsPytest = targets.length > 0 || hasPytestClaim;
  if (needsPytest) {
    const pytestCheck = spawnSync(python, ['-c', 'import pytest'], { cwd: workdir, encoding: 'utf8', timeout: 60000 });
    if (pytestCheck.status !== 0) {
      return { applicable: false, reason: 'pytest_unavailable' };
    }
  }
  const scratch = mkdtempSync(join(tmpdir(), 'evalid-audit-i6d-'));
  try {
    const diffPath = join(scratch, 'audit.diff');
    const evidencePath = join(scratch, 'i6d-evidence.json');
    writeFileSync(diffPath, diffText);
    const result = spawnSync(python, [
      plugin,
      '--root', workdir,
      '--output', evidencePath,
      '--pytest-python', python,
      '--only-changed',
      '--diff-file', diffPath,
      '--',
      ...targets,
    ], { cwd: workdir, encoding: 'utf8', timeout: timeoutMs });
    if (!existsSync(evidencePath)) {
      return {
        applicable: true,
        verdict: 'i6d_error',
        error: `i6d gate wrote no evidence (exit ${result.status}): ${(result.stderr || result.stdout || '').trim().slice(-300)}`,
      };
    }
    let evidence;
    try {
      evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    } catch {
      return { applicable: true, verdict: 'i6d_error', error: 'i6d evidence JSON unparseable' };
    }
    const unexecuted = (evidence.unexecuted || []).map((entry) => ({
      file: String(entry.file || '').startsWith(workdir)
        ? String(entry.file).slice(workdir.length + 1)
        : entry.file,
      line: entry.line,
      test: entry.test,
      source: entry.source,
    }));
    return {
      applicable: true,
      verdict: evidence.verdict,
      exit: result.status,
      executed: evidence.executed ?? 0,
      total: evidence.total ?? 0,
      unexecuted,
      skipped: (evidence.skipped || []).length,
      outOfScope: (evidence.outOfScope || []).length,
      pytestExit: evidence.pytestExit ?? null,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function normalizeCommand(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

/**
 * Pull pass/fail/total counts out of one line of claim text.
 * Handles English ("18 tests, all pass", "6/6 pass", "439 pass, 0 fail")
 * and the Chinese phrasing used in evalid PR bodies ("440 项、439 通过、0 失败").
 */
export function parseClaimCounts(line) {
  const text = String(line || '');
  const counts = {};
  let m = text.match(/(\d+)\s*\/\s*(\d+)\s*(?:pass|passed|通过|✔|✅)?/);
  if (m) {
    counts.passed = Number(m[1]);
    counts.total = Number(m[2]);
    counts.failed = counts.total - counts.passed;
    return counts;
  }
  m = text.match(/(\d+)\s*(?:tests?|items?|项)[^0-9]{0,20}?(?:all\s+pass|pass|passed|通过)/i);
  if (m) counts.passed = Number(m[1]);
  // No \b after 通过/失败/项: \b is an ASCII word boundary and never
  // fires after a CJK character, so "439 通过" would silently not match.
  m = text.match(/(\d+)\s*(?:pass|passed|通过)/i);
  if (m && counts.passed === undefined) counts.passed = Number(m[1]);
  // "18 tests (long parenthetical ...) — all pass": the count and the
  // verdict may be far apart, so an explicit all-pass fallback reads the
  // first test/item count on the line as the passed count.
  if (/all\s+pass(?:ing|es)?\b/i.test(text) && counts.passed === undefined) {
    const n = text.match(/(\d+)\s*(?:tests?|items?|项)/);
    if (n) counts.passed = Number(n[1]);
  }
  m = text.match(/(\d+)\s*(?:fail|failed|failures?|失败)/i);
  if (m) counts.failed = Number(m[1]);
  // Label-first counts ("pass 8", "fail 0"): the node --test summary style
  // real PRs use ("reports `pass 8`, `fail 0`"). Only fill fields the
  // count-first patterns above did not already set, so "9 passed" keeps
  // winning over a later "pass 8" on the same line.
  if (counts.passed === undefined) {
    m = text.match(/pass(?:ed)?\s+(\d+)/i);
    if (m) counts.passed = Number(m[1]);
  }
  if (counts.failed === undefined) {
    m = text.match(/fail(?:ed|ures?)?\s+(\d+)/i);
    if (m) counts.failed = Number(m[1]);
  }
  if (/all\s+pass(?:ing|es)?\b/i.test(text) || /全部通过/.test(text)) {
    if (counts.failed === undefined) counts.failed = 0;
  }
  m = text.match(/(\d+)\s*(?:tests?|items?|项)/);
  if (m && counts.total === undefined) counts.total = Number(m[1]);
  return counts;
}

function parseClaimExit(line) {
  const m = String(line || '').match(/exit(?:\s+code)?\s+(\d+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * Extract claimed test runs from free text (a PR body, commit message, or
 * a --claims file). Returns one claim per distinct command, with any
 * counts/exit found on the same line or in the same paragraph attached.
 * A line that names a test file plus counts ("18 tests ... all pass") is
 * attached to the command claim that runs that file.
 */
export function extractClaims(text) {
  const lines = String(text || '').split('\n');
  const claims = [];
  const byCommand = new Map();

  function upsert(command, source, counts, exitCode) {
    const key = normalizeCommand(command);
    if (!key) return null;
    let claim = byCommand.get(key);
    if (!claim) {
      claim = { command: key, claimedExit: null, claimedPassed: null, claimedFailed: null, claimedTotal: null, source };
      byCommand.set(key, claim);
      claims.push(claim);
    }
    if (counts) {
      if (counts.passed !== undefined && claim.claimedPassed === null) claim.claimedPassed = counts.passed;
      if (counts.failed !== undefined && claim.claimedFailed === null) claim.claimedFailed = counts.failed;
      if (counts.total !== undefined && claim.claimedTotal === null) claim.claimedTotal = counts.total;
    }
    if (exitCode !== null && exitCode !== undefined && claim.claimedExit === null) claim.claimedExit = exitCode;
    return claim;
  }

  // Counts/exit attach line-by-line, and within a line only within the
  // same clause: one line may state two claims ("...passed 6/6 after.
  // Full `npm test` passes (exit 0...)") and the first file's counts must
  // not leak onto the second command. Clauses split on ". " / "; ".
  // (File paths contain dots but never ". ", so this does not split them.)
  for (const line of lines) {
    const clauses = line.split(/(?:[.;]\s+|\s+;\s*)/);
    for (const clause of clauses) {
      const commands = new Set();
      const spans = [...clause.matchAll(/`([^`]+)`/g)].map((span) => span[1]);
      for (const span of spans) {
        const found = span.match(COMMAND_TAIL);
        if (found) commands.add(normalizeCommand(found[0]));
      }
      const bare = clause.match(COMMAND_TAIL);
      if (bare) commands.add(normalizeCommand(bare[0]));
      if (commands.size === 0) continue;
      const counts = parseClaimCounts(clause);
      const exitCode = parseClaimExit(clause);
      const hasCounts = Object.keys(counts).length > 0;
      for (const command of commands) {
        upsert(command, clause.trim().slice(0, 200), hasCounts ? counts : null, exitCode);
      }
    }
  }

  // File-scoped counts: "test/foo.test.js: 18 tests, all pass" attaches to
  // the command claim whose argv names that file. A command that runs
  // several files sums their per-file counts (18 + 6 = 24 for the combined
  // run), and only fills claims that have no same-line counts.
  const fileSums = new Map();
  for (const line of lines) {
    const fileMatch = line.match(/([^\s`'"]+\.test\.[cm]?[jt]sx?|[^\s`'"]+_test\.go|[^\s`'"]+test_[^/\s`'"]*\.py)/);
    if (!fileMatch) continue;
    const counts = parseClaimCounts(line);
    if (Object.keys(counts).length === 0) continue;
    for (const claim of claims) {
      if (!claim.command.includes(fileMatch[1])) continue;
      const sum = fileSums.get(claim.command) || { passed: 0, failed: 0, total: 0, hasPassed: false, hasFailed: false, hasTotal: false };
      if (counts.passed !== undefined) { sum.passed += counts.passed; sum.hasPassed = true; }
      if (counts.failed !== undefined) { sum.failed += counts.failed; sum.hasFailed = true; }
      if (counts.total !== undefined) { sum.total += counts.total; sum.hasTotal = true; }
      fileSums.set(claim.command, sum);
    }
  }
  for (const claim of claims) {
    const sum = fileSums.get(claim.command);
    if (!sum) continue;
    if (claim.claimedPassed === null && sum.hasPassed) claim.claimedPassed = sum.passed;
    if (claim.claimedFailed === null && sum.hasFailed) claim.claimedFailed = sum.failed;
    if (claim.claimedTotal === null && sum.hasTotal) claim.claimedTotal = sum.total;
  }

  // A claim that says tests pass but states no exit code is a claim of exit 0.
  for (const claim of claims) {
    if (claim.claimedExit === null && (claim.claimedPassed !== null || claim.claimedFailed === 0)) {
      claim.claimedExit = 0;
    }
  }
  return claims;
}

/**
 * Classify the single positional argument of `xflow audit <diff|PR>`
 * (M2 slice 1, issue #114). Returns one of:
 *   { kind: 'pr', number, repo }   — bare number, owner/repo#n, or a
 *                                    github.com/.../pull/n URL (repo null
 *                                    for a bare number: the PR lives in
 *                                    the repo under audit)
 *   { kind: 'diff', path }         — '-' (stdin), an existing file, or a
 *                                    .patch/.diff path
 *   { kind: 'unknown', raw }       — anything else (caller reports misuse)
 * A bare number that is also an existing file is read as a PR number.
 */
export function parseAuditTarget(arg) {
  const text = String(arg || '').trim();
  if (!text) return { kind: 'unknown', raw: arg };
  if (/^\d+$/.test(text)) return { kind: 'pr', number: text, repo: null, raw: arg };
  let m = text.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (m) return { kind: 'pr', number: m[2], repo: m[1], raw: arg };
  m = text.match(/^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:\/.*)?$/);
  if (m) return { kind: 'pr', number: m[2], repo: m[1], raw: arg };
  if (text === '-') return { kind: 'diff', path: '-', raw: arg };
  if (/\.(patch|diff)$/i.test(text) || existsSync(resolve(text))) {
    return { kind: 'diff', path: text, raw: arg };
  }
  return { kind: 'unknown', raw: arg };
}

/** Parse a unified diff: touched files, touched test files, added evalid seals. */
export function parseDiffFiles(diffText) {
  const files = [];
  const seals = [];
  for (const line of String(diffText || '').split('\n')) {
    const m = line.match(/^\+\+\+ b\/(.+)$/) || line.match(/^\+\+\+ (.+)$/);
    if (!m || m[1] === '/dev/null') continue;
    const path = m[1].trim();
    files.push(path);
    const seal = path.match(/^specs\/changes\/([^/]+)\/tdd\/([a-z]+)-(\d+)\.json$/);
    if (seal) seals.push({ changeId: seal[1], phase: seal[2], attempt: Number(seal[3]), path });
  }
  return { files, testFiles: files.filter(isTestFile), seals };
}

/**
 * Parse pass/fail counts out of a test runner's output.
 * node --test ("# pass 18", "# fail 0"), pytest ("18 passed, 0 failed"),
 * python -m unittest ("Ran 18 tests" + "OK" / "FAILED (failures=1, errors=0)"),
 * mocha ("18 passing"), npm-wrapped node --test (same "# pass" lines).
 */
export function parseReplayCounts(output, command) {
  const text = String(output || '');
  // node --test prints one summary block per invocation, but multi-file
  // runners (npm test -> run-tests.mjs, one node --test per file) print one
  // per file. A single summary is a comparable count; several are not a
  // total, so report unparsed and let the caller compare on exit code only.
  const nodePasses = [...text.matchAll(/(?:#|ℹ)\s*pass\s+(\d+)/g)];
  const nodeFails = [...text.matchAll(/(?:#|ℹ)\s*fail\s+(\d+)/g)];
  if (nodePasses.length === 1 && nodeFails.length <= 1) {
    const nodePass = Number(nodePasses[0][1]);
    const nodeFail = nodeFails.length === 1 ? Number(nodeFails[0][1]) : null;
    return { passed: nodePass, failed: nodeFail, total: nodeFail !== null ? nodePass + nodeFail : null };
  }
  if (nodePasses.length > 1 || nodeFails.length > 1) return null;
  // bun test prints one aggregated totals block per invocation:
  // " 18 pass\n 0 fail\n ... \nRan 18 tests across 2 files."
  // (verified against bun v1.4.4, 2026-11-11; M6 slice 1, #132).
  // Count-first, unlike the "# pass N" lines node --test prints, so
  // the two never collide; "(pass)" per-test lines do not match either
  // (they carry no leading count). Multi-file runs still aggregate
  // into one block, so a single pair is a comparable total.
  const bunPasses = [...text.matchAll(/^\s*(\d+)\s+pass\s*$/gm)];
  const bunFails = [...text.matchAll(/^\s*(\d+)\s+fail\s*$/gm)];
  if (bunPasses.length === 1 && bunFails.length <= 1) {
    const bunPass = Number(bunPasses[0][1]);
    const bunFail = bunFails.length === 1 ? Number(bunFails[0][1]) : null;
    const ranAcross = text.match(/Ran (\d+) tests? across \d+ files?/);
    const total = ranAcross ? Number(ranAcross[1]) : (bunFail !== null ? bunPass + bunFail : null);
    return { passed: bunPass, failed: bunFail, total };
  }
  if (bunPasses.length > 1 || bunFails.length > 1) return null;
  // python -m unittest prints one summary per run: "Ran N tests in ...",
  // then "OK" (optionally "OK (skipped=S)") or "FAILED (failures=F,
  // errors=E)". Same count semantics as the pytest branch below:
  // passed = ran - failed (- skipped on an OK run).
  const ran = text.match(/Ran (\d+) tests? in /);
  if (ran) {
    const total = Number(ran[1]);
    const ok = text.match(/\nOK(?: \(skipped=(\d+)\))?\s*$/);
    if (ok) {
      const skipped = ok[1] !== undefined ? Number(ok[1]) : 0;
      return { passed: total - skipped, failed: 0, total };
    }
    let m = text.match(/FAILED \(failures=(\d+)(?:, errors=(\d+))?\)/);
    if (m) {
      const failed = Number(m[1]) + (m[2] !== undefined ? Number(m[2]) : 0);
      return { passed: total - failed, failed, total };
    }
    m = text.match(/FAILED \(errors=(\d+)\)/);
    if (m) {
      const failed = Number(m[1]);
      return { passed: total - failed, failed, total };
    }
    return null;
  }
  let m = text.match(/(\d+)\s+passed?(?:,\s*(\d+)\s+failed?)?/);
  if (m) {
    return { passed: Number(m[1]), failed: m[2] !== undefined ? Number(m[2]) : null, total: null };
  }
  m = text.match(/(\d+)\s+passing(?:,\s*(\d+)\s+failing)?/);
  if (m) {
    return { passed: Number(m[1]), failed: m[2] !== undefined ? Number(m[2]) : null, total: null };
  }
  if (/test[s]?\s+passed/i.test(text) && /0\s+failed/i.test(text)) return { passed: null, failed: 0, total: null };
  return null;
}

/**
 * Files whose change means the dependency tree changed (M6 slice 1,
 * issue #132). A diff touching one of these changes what the replay
 * tree must install; a diff touching none of them leaves the tree alone.
 */
export const NODE_MODULES_LOCKFILES = ['package-lock.json', 'bun.lockb', 'bun.lock', 'yarn.lock', 'pnpm-lock.yaml'];

export function isDependencyFile(path) {
  const name = String(path || '').split('/').pop();
  return name === 'package.json' || NODE_MODULES_LOCKFILES.includes(name);
}

/**
 * Minimal JSONC reader: `//` and `/* *\/` comments plus trailing commas,
 * all outside strings. Integrity hashes contain `//` inside strings
 * (sha512-...), so comment detection must be string-aware — a naive
 * regex strip would corrupt the file.
 */
export function parseJsonc(text) {
  let out = '';
  let i = 0;
  const n = String(text).length;
  let inString = false;
  let escaped = false;
  while (i < n) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; i += 1; continue; }
    if (ch === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i += 1; continue; }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i = Math.min(n, i + 2);
      continue;
    }
    if (ch === ',') {
      // Drop a trailing comma: `,` followed only by whitespace then `}`/`]`.
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j += 1;
      if (text[j] === '}' || text[j] === ']') { i += 1; continue; }
      out += ch; i += 1; continue;
    }
    out += ch; i += 1;
  }
  return JSON.parse(out);
}

/**
 * Declared dependency entries from a package-lock.json (npm v7+
 * `packages` map, or the legacy `dependencies` map). Returns a Map of
 * name -> { version, optional, cpu, os, libc }, or null when there is
 * no (parseable) lockfile. `optional` is the lockfile's own flag: npm
 * sets it on packages reachable only through optionalDependencies
 * (platform packages and their pruned transitives). bun.lockb is
 * binary and yarn/pnpm lockfiles use their own format, so they are
 * not parsed here — their presence still marks the deps as changed
 * (see isDependencyFile), but version-level comparison needs a
 * package-lock.json or a bun.lock (see readBunLockEntries).
 */
export function readPackageLockEntries(dir) {
  const lockPath = join(dir, 'package-lock.json');
  if (!existsSync(lockPath)) return null;
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
  const toEntry = (raw) => {
    if (!raw || typeof raw !== 'object' || typeof raw.version !== 'string') return null;
    return {
      version: raw.version,
      optional: raw.optional === true,
      cpu: raw.cpu ?? null,
      os: raw.os ?? null,
      libc: raw.libc ?? null,
    };
  };
  const entries = new Map();
  const packages = lock && lock.packages;
  if (packages && typeof packages === 'object') {
    for (const [key, raw] of Object.entries(packages)) {
      if (!key.startsWith('node_modules/')) continue;
      const rest = key.slice('node_modules/'.length);
      // Skip nested installs (node_modules/a/node_modules/b): only the
      // top-level tree is the snapshot under judgement.
      if (rest.includes('node_modules/')) continue;
      const entry = toEntry(raw);
      if (entry) entries.set(rest, entry);
    }
  } else if (lock && lock.dependencies && typeof lock.dependencies === 'object') {
    for (const [name, raw] of Object.entries(lock.dependencies)) {
      const entry = toEntry(raw);
      if (entry) entries.set(name, entry);
    }
  }
  return entries;
}

/**
 * Declared dependency versions from a package-lock.json (npm v7+
 * `packages` map, or the legacy `dependencies` map). Returns a Map of
 * name -> version, or null when there is no (parseable) lockfile.
 * (Package-lock only; for bun.lock see readBunLockEntries, for the
 * combined authority see readLockfileEntries.)
 */
export function readLockfileVersions(dir) {
  const entries = readPackageLockEntries(dir);
  if (entries === null) return null;
  const versions = new Map();
  for (const [name, entry] of entries) versions.set(name, entry.version);
  return versions;
}

/**
 * Declared dependency entries from a bun.lock (text JSONC, lockfile
 * version 1). Returns a Map of name -> { version, optional, cpu, os,
 * libc: null }, or null when there is no (parseable) bun.lock.
 *
 * Format (verified against code-yeongyu/oh-my-openagent#8014, merge
 * 51ddf958): top-level `packages` maps a name to
 * `[name@version, resolved, meta, integrity]`; `meta` carries `os` /
 * `cpu` for platform packages and `optionalDependencies` for their
 * parents. A package counts as optional when any workspace or any
 * package entry lists it under `optionalDependencies` — that is how
 * bun records platform packages (e.g. @esbuild/win32-x64 is an
 * optionalDependency of esbuild, not of the root workspace).
 */
export function readBunLockEntries(dir) {
  const lockPath = join(dir, 'bun.lock');
  if (!existsSync(lockPath)) return null;
  let lock;
  try {
    lock = parseJsonc(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
  const packages = lock && lock.packages;
  if (!packages || typeof packages !== 'object') return null;
  const optionalNames = new Set();
  const collectOptional = (obj) => {
    if (obj && typeof obj === 'object' && obj.optionalDependencies && typeof obj.optionalDependencies === 'object') {
      for (const name of Object.keys(obj.optionalDependencies)) optionalNames.add(name);
    }
  };
  const workspaces = lock.workspaces;
  if (workspaces && typeof workspaces === 'object') {
    for (const ws of Object.values(workspaces)) collectOptional(ws);
  }
  const metas = new Map();
  for (const [name, value] of Object.entries(packages)) {
    if (Array.isArray(value) && value.length >= 3 && value[2] && typeof value[2] === 'object') {
      metas.set(name, value[2]);
      collectOptional(value[2]);
    }
  }
  const entries = new Map();
  for (const [name, value] of Object.entries(packages)) {
    if (!Array.isArray(value) || typeof value[0] !== 'string') continue;
    // value[0] is "name@version" (scoped: "@scope/name@version").
    const at = value[0].lastIndexOf('@');
    if (at <= 0) continue;
    const version = value[0].slice(at + 1);
    if (!version) continue;
    const meta = metas.get(name) || {};
    entries.set(name, {
      version,
      optional: optionalNames.has(name),
      cpu: meta.cpu ?? null,
      os: meta.os ?? null,
      libc: meta.libc ?? null,
    });
  }
  return entries;
}

/**
 * Declared dependency entries from the audited lockfile:
 * package-lock.json first, else bun.lock, else null. This is the
 * snapshot authority used by checkNodeModulesSnapshot.
 */
export function readLockfileEntries(dir) {
  return readPackageLockEntries(dir) ?? readBunLockEntries(dir);
}

/**
 * Bun's install layout: packages live in `node_modules/.bun/` as
 * content-addressed dirs (`name@version`, scoped names with `/`
 * written as `+`, plus an optional `+<hash>` disambiguator), and only
 * a subset is symlinked to the top level. A top-level-only scan
 * therefore undercounts a bun-installed tree (omo#8014: 66 top-level
 * entries vs 661 cache dirs). Returns a Map of name -> Set of
 * versions found in the cache, or an empty Map when there is no
 * `.bun` dir (npm trees).
 */
export function listBunCachePackages(nodeModulesDir) {
  const found = new Map();
  const cacheDir = join(nodeModulesDir, '.bun');
  let entries;
  try {
    entries = readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const raw = entry.name;
    const at = raw.lastIndexOf('@');
    if (at <= 0) continue;
    // The version part may carry a `+<hash>` disambiguator (or semver
    // build metadata); the version is the part before the first `+`.
    const version = raw.slice(at + 1).split('+')[0];
    if (!version) continue;
    // Scoped names are written with `+` for `/` (`@ai-sdk+provider`
    // is `@ai-sdk/provider`); unscoped names contain no `+`.
    const name = raw.startsWith('@') ? raw.slice(0, at).replace('+', '/') : raw.slice(0, at);
    if (!found.has(name)) found.set(name, new Set());
    found.get(name).add(version);
  }
  return found;
}

/** Top-level installed packages under a node_modules dir: name -> { version }. */
export function listInstalledPackages(nodeModulesDir) {
  const installed = new Map();
  if (!existsSync(nodeModulesDir)) return installed;
  let entries;
  try {
    entries = readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch {
    return installed;
  }
  const readOne = (name, dir) => {
    const manifest = join(dir, 'package.json');
    let version = null;
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
      if (parsed && typeof parsed.version === 'string') version = parsed.version;
    } catch { /* unreadable manifest: version stays null, still listed */ }
    installed.set(name, { version });
  };
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      let scoped;
      try {
        scoped = readdirSync(join(nodeModulesDir, entry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of scoped) {
        if (!sub.isDirectory()) continue;
        readOne(`${entry.name}/${sub.name}`, join(nodeModulesDir, entry.name, sub.name));
      }
    } else {
      readOne(entry.name, join(nodeModulesDir, entry.name));
    }
  }
  return installed;
}

/**
 * Compare two installed node_modules trees and name the exact
 * differences. Returns { differences, checked, truncated } where each
 * difference names one file or package, e.g.
 * "node_modules/js-yaml/package.json: version 4.1.1 (replay) vs 4.1.0
 * (reference)". `onlyNames` restricts the comparison to declared
 * dependencies; `reportMissing: false` reports version drift only.
 */
export function compareNodeModulesTrees(replayDir, referenceDir, options = {}) {
  const { onlyNames = null, reportMissing = true, maxDifferences = 50 } = options;
  const replay = listInstalledPackages(replayDir);
  const reference = listInstalledPackages(referenceDir);
  const names = new Set([...replay.keys(), ...reference.keys()]);
  if (onlyNames) {
    for (const name of [...names]) if (!onlyNames.has(name)) names.delete(name);
  }
  const all = [];
  for (const name of [...names].sort()) {
    const inReplay = replay.get(name);
    const inReference = reference.get(name);
    if (!inReplay && inReference) {
      if (reportMissing) all.push(`node_modules/${name}: missing in replay tree (expected ${inReference.version ?? 'unknown version'})`);
    } else if (inReplay && !inReference) {
      if (reportMissing) all.push(`node_modules/${name}: only in replay tree (not in reference snapshot)`);
    } else if (inReplay && inReference && inReplay.version !== null && inReference.version !== null && inReplay.version !== inReference.version) {
      all.push(`node_modules/${name}/package.json: version ${inReplay.version} (replay) vs ${inReference.version} (reference)`);
    }
  }
  return { differences: all.slice(0, maxDifferences), checked: names.size, truncated: all.length > maxDifferences };
}

/**
 * Judge whether a replay tree's node_modules snapshot is consistent
 * with what the change declares (M6 slice 1, issue #132; #111 root
 * cause: the replay tree is built without node_modules).
 *
 *   workdir   — the replay tree (scratch clone, deps installed or not)
 *   sourceDir — the repo the claim was produced against (its installed
 *               tree is the claim-time snapshot), or null
 *   options   — { diffFiles, lockfileVersions, lockfileEntries,
 *               replayCopiedFromSource } (lockfileEntries may be passed
 *               in: runAudit captures it before the install step, so a
 *               lockfile npm generates cannot masquerade as the
 *               audited one; lockfileVersions is the legacy shape,
 *               Map name -> version string, with no optional metadata)
 *
 * Statuses:
 *   no_package_json                  — nothing to install, nothing to judge
 *   deps_unchanged_missing_snapshot  — no node_modules, but the diff
 *     touches no dependency file: the absence is an environment gap,
 *     NOT a mismatch signal (consistent: true)
 *   deps_changed_missing_snapshot    — no node_modules and the diff
 *     changes dependencies: cannot judge (consistent: null)
 *   consistent / inconsistent       — the installed tree matches, or
 *     differs from, the lockfile. Differences name the exact files.
 *     A lockfile entry flagged `optional` that is missing from the
 *     replay tree is NOT a difference (M6 slice 3, #135): a
 *     successful install legitimately skips optional packages that do
 *     not apply to this platform (os/cpu/libc mismatch) or whose
 *     optional parent was skipped (pruned transitives). The
 *     lockfile's own `optional` flag is the authority; such entries
 *     are counted in `optionalExempted` / `exemptedPackages`
 *     instead. A version drift on an installed optional package is
 *     still a real difference. When a lockfile is present it is the
 *     authority: a stale source tree does not make a lockfile-exact
 *     replay "inconsistent".
 *   cannot-determine                 — a tree is installed but there
 *     is no trustworthy lockfile (no package-lock.json and no
 *     parseable bun.lock) to judge it against (consistent: null).
 *     The old replay-vs-source-tree comparison is gone: it
 *     degenerated into self-comparison whenever the replay tree was
 *     copied from the source tree (omo#8014: hollow "consistent", 0
 *     differences), and a stale source tree makes it untrustworthy
 *     even when the replay tree was installed fresh (M2 G4).
 *
 * This function only classifies; it never flips an audit verdict by
 * itself. runAudit renders the differences and annotates a failing
 * claim with them, so a snapshot-caused mismatch is classified instead
 * of silently blamed on the change.
 */
export function checkNodeModulesSnapshot(workdir, sourceDir, options = {}) {
  const { diffFiles = [], lockfileVersions = undefined, lockfileEntries = undefined, replayCopiedFromSource = false } = options;
  const depsChanged = (diffFiles || []).some(isDependencyFile);
  if (!existsSync(join(workdir, 'package.json'))) {
    return { status: 'no_package_json', consistent: null, depsChanged, differences: [], replayPresent: false, sourcePresent: false, optionalExempted: 0, exemptedPackages: [] };
  }
  const replayDir = join(workdir, 'node_modules');
  const replayPresent = existsSync(replayDir);
  const sourceResolved = sourceDir ? resolve(sourceDir) : null;
  const sourcePresent = !!sourceResolved && existsSync(join(sourceResolved, 'node_modules'));
  // Lockfile authority: explicit entries first, then the legacy
  // version-only map, then read from the workdir (package-lock.json,
  // else bun.lock). A zero-entry map is a real lockfile (zero declared
  // deps), not an absent one — only null means "no lockfile".
  let expected = null;
  if (lockfileEntries !== undefined) expected = lockfileEntries;
  else if (lockfileVersions !== undefined) expected = lockfileVersions;
  else expected = readLockfileEntries(workdir);
  if (!replayPresent) {
    if (expected && expected.size === 0) {
      // Zero declared dependencies: `npm ci` installs nothing and
      // creates no node_modules dir at all (verified 2026-11-11) — the
      // absent tree IS the expected tree, not a missing snapshot.
      return { status: 'consistent', consistent: true, depsChanged, differences: [], replayPresent, sourcePresent, optionalExempted: 0, exemptedPackages: [] };
    }
    if (!depsChanged) {
      return { status: 'deps_unchanged_missing_snapshot', consistent: true, depsChanged, differences: [], replayPresent, sourcePresent, optionalExempted: 0, exemptedPackages: [] };
    }
    return { status: 'deps_changed_missing_snapshot', consistent: null, depsChanged, differences: ['node_modules: missing in replay tree (dependencies changed in diff)'], replayPresent, sourcePresent, optionalExempted: 0, exemptedPackages: [] };
  }
  const differences = [];
  const exemptedPackages = [];
  if (expected) {
    const installed = listInstalledPackages(replayDir);
    // Bun-installed trees keep most packages in node_modules/.bun
    // (see listBunCachePackages); a package present there at the
    // lockfile version counts as installed.
    const bunCache = listBunCachePackages(replayDir);
    for (const [name, entry] of expected) {
      const version = typeof entry === 'string' ? entry : entry?.version;
      const optional = entry && typeof entry === 'object' && entry.optional === true;
      const got = installed.get(name);
      if (!got) {
        // M6 slice 3 (#135): a missing optional entry is a legitimate
        // installer skip, never evidence against the change (see the
        // status list above). Verified on senpi#2606 (92/92) and
        // senpi#4801 (162/162): every recorded difference was an
        // optional entry — platform packages (os/cpu/libc mismatch on
        // linux-x64/glibc) plus pruned optional transitives
        // (buildcheck/cpu-features/nan, @emnapi/*).
        if (optional) { exemptedPackages.push(name); continue; }
        const cached = bunCache.get(name);
        if (cached && cached.has(version)) continue;
        if (cached && cached.size > 0) {
          differences.push(`node_modules/${name}/package.json: version ${[...cached].sort().join(', ')} (bun .bun store) vs ${version} (lockfile)`);
          continue;
        }
        differences.push(`node_modules/${name}: missing in replay tree (expected ${version})`);
      } else if (got.version !== null && version !== undefined && got.version !== version) {
        differences.push(`node_modules/${name}/package.json: version ${got.version} (replay) vs ${version} (lockfile)`);
      }
    }
  } else {
    const reason = replayCopiedFromSource
      ? 'node_modules: replay tree was copied from the source tree and no lockfile (package-lock.json or bun.lock) is available to judge it against (cannot-determine)'
      : 'node_modules: no lockfile (package-lock.json or bun.lock) available to judge the installed tree against (cannot-determine)';
    return { status: 'cannot-determine', consistent: null, depsChanged, differences: [reason], replayPresent, sourcePresent, optionalExempted: 0, exemptedPackages: [] };
  }
  const consistent = differences.length === 0;
  return { status: consistent ? 'consistent' : 'inconsistent', consistent, depsChanged, differences, replayPresent, sourcePresent, optionalExempted: exemptedPackages.length, exemptedPackages: exemptedPackages.slice(0, 50) };
}

function splitCommand(command) {
  const parts = [];
  let current = '';
  let quote = null;
  for (const char of String(command)) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) { parts.push(current); current = ''; }
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** Argv tokens that look like repo-relative file paths (not flags, not packages). */
export function isPathLikeArg(token) {
  const text = String(token || '');
  return text.includes('/')
    && !text.startsWith('-')
    && !text.startsWith('/')
    && !text.includes('=')
    && !text.includes('://');
}

/**
 * Find the subdirectory a claimed command must run in. Real PRs scope
 * commands to a package ("`npm test` in `packages/lsp-daemon`",
 * `node --test test/foo.test.ts` from `packages/tui/`), but the claim
 * text rarely states the directory. When every path-like argv token is
 * missing at the repo root yet all of them exist under exactly one
 * subdirectory, replay from there; otherwise stay at the root (including
 * when the paths resolve at the root, or when two subdirectories both
 * fit). Never guesses: an ambiguous or unresolvable layout keeps root.
 */
export function resolveClaimCwd(workdir, argv) {
  const tokens = (argv || [])
    .filter(isPathLikeArg)
    .map((token) => String(token).replace(/^\.\//, ''));
  if (tokens.length === 0) return '';
  if (tokens.every((token) => existsSync(join(workdir, token)))) return '';
  const first = tokens[0];
  const basename = first.split('/').pop();
  const found = findFilesByBasename(workdir, basename);
  const dirs = new Set();
  for (const file of found) {
    if (file !== first && !file.endsWith(`/${first}`)) continue;
    const dir = file.slice(0, file.length - first.length).replace(/\/$/, '');
    if (!dir) continue;
    if (tokens.every((token) => existsSync(join(workdir, dir, token)))) dirs.add(dir);
  }
  return dirs.size === 1 ? [...dirs][0] : '';
}

const CLAIM_CWD_SKIP_DIRS = new Set(['node_modules', '.git']);

/** Relative paths of files named `basename` under `root` (bounded walk). */
export function findFilesByBasename(root, basename, maxDepth = 6, maxDirs = 3000) {
  const results = [];
  let visited = 0;
  function walk(dir, depth, prefix) {
    if (depth > maxDepth || visited >= maxDirs) return;
    visited += 1;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (CLAIM_CWD_SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), depth + 1, rel);
      } else if (entry.name === basename) {
        results.push(rel);
      }
    }
  }
  walk(root, 0, '');
  return results;
}

function runShell(cwd, argv, timeoutMs) {
  const started = Date.now();
  // A replay must run in a clean test-runner context: when audit itself runs
  // under `node --test` (unit tests, or CI invoking it from a test file),
  // NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID leak into the child and make
  // `node --test` refuse to run files ("called recursively within a test
  // file", exit 0, zero tests). Strip them so the replay really runs.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const result = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', timeout: timeoutMs, env });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return {
    exit: result.status === null ? null : result.status,
    timedOut: result.status === null && result.error && /timed out/i.test(String(result.error.message || '')),
    spawnError: result.error && result.status === null ? String(result.error.message || result.error) : null,
    output,
    outputTail: output.split('\n').slice(-40).join('\n'),
    durationMs: Date.now() - started,
  };
}

function replaySeal(workdir, repoRoot, seal, python, timeoutMs) {
  const validator = resolve(repoRoot, 'xflow', 'atoms', 'i6b_tdd_proof_validate.py');
  if (!existsSync(validator)) {
    return { ...seal, ok: false, verdict: 'validator_missing', error: `validator not found: ${validator}` };
  }
  const result = spawnSync(python, [
    validator,
    '--project-root', workdir,
    '--change-id', seal.changeId,
    '--phase', seal.phase,
    '--attempt', String(seal.attempt),
  ], { cwd: workdir, encoding: 'utf8', timeout: timeoutMs });
  const lines = String(result.stdout || '').split('\n').reverse();
  let payload = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.verdict === 'string') { payload = parsed; break; }
    } catch { /* not the verdict line */ }
  }
  return {
    ...seal,
    ok: payload?.ok === true && result.status === 0,
    verdict: payload?.verdict || 'unparseable_output',
    exit: result.status,
    stderr: String(result.stderr || '').slice(-500),
  };
}

/**
 * Run a full audit. Options:
 *   repoDir    — local repo to clone from (required)
 *   diffText   — unified diff to apply on top of baseRef (or '' when headRef is checked out directly)
 *   baseRef    — commit to check out before applying diffText
 *   headRef    — commit to check out directly (diffText ignored; used for merged PRs)
 *   claimsText — PR body / claims text to extract claims from
 *   timeoutMs  — per-command timeout (default 300_000)
 *   python     — python binary for the i6b validator (default 'python3')
 *   keepWorkdir — keep the scratch clone for debugging (default false)
 *   python     — python binary for the i6b validator and the i6d gate
 *               (default 'python3' / $PYTHON)
 *   i6d        — run the I6d assertion-execution gate when it applies
 *               (default true; --no-i6d on the CLI disables it)
 *
 * The report carries a `nodeModules` snapshot-consistency judgement
 * (M6 slice 1, #132): status, whether the diff changes dependencies,
 * and the exact differing files, if any.
 */
export function runAudit(options = {}) {
  const {
    repoDir,
    diffText = '',
    baseRef = null,
    headRef = null,
    claimsText = '',
    timeoutMs = 300000,
    python = process.env.PYTHON || 'python3',
    keepWorkdir = false,
    i6d = true,
  } = options;
  if (!repoDir || !existsSync(repoDir)) {
    return { ok: false, verdict: 'misuse', error: `repo not found: ${repoDir}`, exitCode: 2 };
  }
  if (!headRef && !baseRef) {
    return { ok: false, verdict: 'misuse', error: 'one of --head or --base is required', exitCode: 2 };
  }

  const started = Date.now();
  const claims = extractClaims(claimsText);
  const diff = parseDiffFiles(diffText);
  const workdir = mkdtempSync(join(tmpdir(), 'evalid-audit-'));
  try {
    // --no-hardlinks: /tmp may live on another filesystem than the repo,
    // and a hardlinked local clone then fails with "Invalid cross-device link".
    const clone = runShell(tmpdir(), ['git', 'clone', '--quiet', '--no-hardlinks', '--local', resolve(repoDir), workdir], 120000);
    if (clone.exit !== 0) {
      return { ok: false, verdict: 'unverifiable', error: `git clone failed: ${clone.outputTail.slice(-300)}`, claims, diff, exitCode: 1 };
    }
    const checkoutRef = headRef || baseRef;
    const checkout = runShell(workdir, ['git', 'checkout', '--quiet', checkoutRef], 60000);
    if (checkout.exit !== 0) {
      return { ok: false, verdict: 'unverifiable', error: `git checkout ${checkoutRef} failed: ${checkout.outputTail.slice(-300)}`, claims, diff, exitCode: 1 };
    }
    if (diffText && !headRef) {
      const diffFile = join(workdir, '.audit.diff');
      writeFileSync(diffFile, diffText);
      const apply = runShell(workdir, ['git', 'apply', '--whitespace=nowarn', diffFile], 60000);
      rmSync(diffFile, { force: true });
      if (apply.exit !== 0) {
        return { ok: false, verdict: 'unverifiable', error: `git apply failed: ${apply.outputTail.slice(-300)}`, claims, diff, exitCode: 1 };
      }
    }

    // Capture the audited lockfile before the install step: `npm
    // install` (no-lockfile repos) writes a fresh package-lock.json
    // into the scratch clone, which must not masquerade as the audited
    // one when the snapshot is judged (M6 slice 1, #132). Entries
    // carry the lockfile's optional/cpu/os metadata (M6 slice 3,
    // #135); bun.lock is accepted as an authority alongside
    // package-lock.json.
    const lockfileEntries = readLockfileEntries(workdir);

    // Replay setup: a fresh clone has no node_modules, so a claimed command
    // that imports a dependency would fail for environmental reasons, not
    // because the change is broken. Install deps when package.json exists
    // and node_modules is absent (npm ci with a lockfile, npm install
    // without one); fall back to copying the source repo's node_modules.
    // Skipped entirely when there is nothing to replay (no claims, no seals).
    let setup = { deps: 'none' };
    if ((claims.length > 0 || diff.seals.length > 0)
      && existsSync(join(workdir, 'package.json')) && !existsSync(join(workdir, 'node_modules'))) {
      const hasLock = existsSync(join(workdir, 'package-lock.json'));
      const installArgs = hasLock
        ? ['npm', 'ci', '--no-audit', '--no-fund']
        : ['npm', 'install', '--no-audit', '--no-fund'];
      const install = runShell(workdir, installArgs, 300000);
      if (install.exit === 0) {
        setup = { deps: hasLock ? 'npm ci' : 'npm install' };
      } else if (existsSync(join(resolve(repoDir), 'node_modules'))) {
        const copy = runShell(tmpdir(), ['cp', '-r', join(resolve(repoDir), 'node_modules'), join(workdir, 'node_modules')], 120000);
        setup = copy.exit === 0
          ? { deps: 'copied from source repo node_modules' }
          : { deps: 'none', error: `${installArgs[1]} failed and node_modules copy failed` };
      } else {
        setup = { deps: 'none', error: `${installArgs[1]} failed: ${install.outputTail.slice(-300)}` };
      }
    }
    // M6 slice 1 (#132): judge the replay tree's node_modules snapshot
    // against the audited lockfile / source snapshot. A missing snapshot
    // with unchanged dependencies is an environment gap, not a mismatch;
    // a real inconsistency names the exact differing files.
    // M6 slice 3 (#135): when the replay tree was copied from the
    // source tree there is no independent tree to compare against —
    // say so (cannot-determine) instead of reporting a hollow
    // consistent.
    const nodeModules = checkNodeModulesSnapshot(workdir, resolve(repoDir), {
      diffFiles: diff.files,
      lockfileEntries,
      replayCopiedFromSource: setup.deps === 'copied from source repo node_modules',
    });
    if (setup.error) {
      return { ok: false, verdict: 'unverifiable', error: `replay setup failed (${setup.error})`, claims, diff, setup, nodeModules, exitCode: 1 };
    }

    const claimResults = [];
    let mismatch = null;
    for (const claim of claims) {
      const argv = splitCommand(claim.command);
      if (argv.length === 0) {
        claimResults.push({ ...claim, replay: null, match: false, note: 'empty command', cwd: '' });
        mismatch = mismatch || 'empty command';
        continue;
      }
      const claimCwd = resolveClaimCwd(workdir, argv);
      const replay = runShell(claimCwd ? join(workdir, claimCwd) : workdir, argv, timeoutMs);
      const counts = parseReplayCounts(replay.output, claim.command);
      const expectedExit = claim.claimedExit ?? 0;
      let match = replay.exit === expectedExit && !replay.timedOut && !replay.spawnError;
      let note = null;
      if (match && counts) {
        if (claim.claimedPassed !== null && counts.passed !== null && counts.passed !== claim.claimedPassed) {
          match = false;
          note = `passed count: claimed ${claim.claimedPassed}, replayed ${counts.passed}`;
        }
        if (match && claim.claimedFailed !== null && counts.failed !== null && counts.failed !== claim.claimedFailed) {
          match = false;
          note = `failed count: claimed ${claim.claimedFailed}, replayed ${counts.failed}`;
        }
      } else if (match && !counts && (claim.claimedPassed !== null || claim.claimedFailed !== null)) {
        note = 'counts_unparsed: exit matches, counts could not be parsed from replay output';
      }
      if (replay.timedOut) note = `replay timed out after ${timeoutMs}ms`;
      if (replay.spawnError) note = `could not run claimed command: ${replay.spawnError}`;
      if (!match && !note) note = `exit: claimed ${expectedExit}, replayed ${replay.exit}`;
      if (!match && nodeModules.status === 'inconsistent' && nodeModules.differences.length > 0) {
        const shown = nodeModules.differences.slice(0, 3).join('; ');
        const more = nodeModules.differences.length > 3 ? ` (+${nodeModules.differences.length - 3} more)` : '';
        const snapshotNote = `node_modules snapshot differs: ${shown}${more}`;
        note = note ? `${note}; ${snapshotNote}` : snapshotNote;
      }
      claimResults.push({ ...claim, replay: { ...replay, counts }, match, note, cwd: claimCwd });
      if (!match) mismatch = mismatch || note || 'claim mismatch';
    }

    const sealResults = diff.seals.map((seal) => replaySeal(workdir, resolve(repoDir), seal, python, timeoutMs));
    const badSeal = sealResults.find((seal) => !seal.ok);

    // Slice 3 (M3): the I6d gate judges whether the diff's new/changed
    // assertions really executed during the green run. A replay can exit 0
    // while an assertion in a never-called callback never ran -- that
    // change must not count as green.
    const i6dResult = i6d === false
      ? { applicable: false, reason: 'disabled' }
      : runI6dCheck(workdir, { diffText, claims, python, timeoutMs });

    let verdict;
    let exitCode;
    if (i6dResult.applicable && i6dResult.verdict === 'unexecuted_assertions') {
      verdict = 'mismatch';
      exitCode = 1;
    } else if (claims.length === 0 && sealResults.length === 0) {
      verdict = 'no_claims';
      exitCode = 3;
    } else if (mismatch || badSeal) {
      verdict = 'mismatch';
      exitCode = 1;
    } else if (i6dResult.applicable && (i6dResult.verdict === 'diff_error' || i6dResult.verdict === 'i6d_error')) {
      verdict = 'unverifiable';
      exitCode = 1;
    } else if (claimResults.some((entry) => entry.replay && (entry.replay.timedOut || entry.replay.spawnError))) {
      verdict = 'unverifiable';
      exitCode = 1;
    } else {
      verdict = 'verified';
      exitCode = 0;
    }

    return {
      ok: verdict === 'verified',
      verdict,
      exitCode,
      claims: claimResults,
      seals: sealResults,
      i6d: i6dResult,
      nodeModules,
      files: diff.files,
      testFiles: diff.testFiles,
      setup,
      workdir: keepWorkdir ? workdir : null,
      durationMs: Date.now() - started,
    };
  } finally {
    if (!keepWorkdir) rmSync(workdir, { recursive: true, force: true });
  }
}

export function auditExitCode(verdict) {
  return { verified: 0, mismatch: 1, unverifiable: 1, misuse: 2, no_claims: 3 }[verdict] ?? 1;
}

export function renderAuditReport(report) {
  const lines = [`xflow audit: ${report.verdict}`];
  if (report.error) lines.push(`error: ${report.error}`);
  if (report.setup?.deps && report.setup.deps !== 'none') lines.push(`replay deps: ${report.setup.deps}`);
  if (report.nodeModules) {
    const nm = report.nodeModules;
    const exempted = nm.optionalExempted ? ` (${nm.optionalExempted} optional package${nm.optionalExempted === 1 ? '' : 's'} exempted)` : '';
    lines.push(`node_modules snapshot: ${nm.status}${nm.depsChanged ? ' (dependencies changed in diff)' : ''}${exempted}`);
    for (const d of nm.differences || []) lines.push(`  snapshot diff: ${d}`);
  }
  if (report.files) {
    lines.push(`files touched: ${report.files.length} (${report.testFiles?.length ?? 0} test files)`);
    for (const file of report.testFiles || []) lines.push(`  test: ${file}`);
  }
  for (const claim of report.claims || []) {
    const replay = claim.replay;
    const replayText = replay
      ? `replay exit ${replay.exit}${replay.counts && replay.counts.passed !== null ? `, pass ${replay.counts.passed}` : ''}${replay.counts && replay.counts.failed !== null ? `, fail ${replay.counts.failed}` : ''}`
      : 'not replayed';
    const claimedText = [
      claim.claimedExit !== null ? `exit ${claim.claimedExit}` : null,
      claim.claimedPassed !== null ? `${claim.claimedPassed} passed` : null,
      claim.claimedFailed !== null ? `${claim.claimedFailed} failed` : null,
    ].filter(Boolean).join(', ') || 'no counts stated';
    lines.push(`- ${claim.match ? '✓' : '✗'} ${claim.command}${claim.cwd ? ` [cwd: ${claim.cwd}]` : ''} (claimed ${claimedText}; ${replayText})${claim.note ? ` — ${claim.note}` : ''}`);
  }
  for (const seal of report.seals || []) {
    lines.push(`- ${seal.ok ? '✓' : '✗'} seal ${seal.changeId}/${seal.phase}/${seal.attempt}: ${seal.verdict}`);
  }
  const gate = report.i6d;
  if (gate) {
    if (!gate.applicable) {
      lines.push(`i6d: not applicable (${gate.reason})`);
    } else if (gate.verdict === 'pass') {
      lines.push(`i6d: pass (${gate.executed}/${gate.total} assertions executed, ${gate.skipped} skipped, ${gate.outOfScope} out of scope)`);
    } else if (gate.verdict === 'unexecuted_assertions') {
      lines.push(`i6d: ✗ unexecuted_assertions (${gate.executed}/${gate.total} executed, ${gate.unexecuted.length} unexecuted)`);
      for (const entry of gate.unexecuted) {
        lines.push(`  unexecuted: ${entry.file}:${entry.line}: ${entry.source}`);
      }
    } else {
      lines.push(`i6d: ${gate.verdict}${gate.error ? `: ${gate.error}` : ''}`);
    }
  }
  if (report.durationMs !== undefined) lines.push(`duration: ${(report.durationMs / 1000).toFixed(1)}s`);
  return lines.join('\n');
}
