#!/usr/bin/env node
/**
 * I6d assertion-execution gate, JS half (M3 slice 1, #120).
 *
 * The Python half (i6d_assertion_execution.py, M3 #86) proves pytest
 * assertions really executed. It silently passes a change that only
 * touches JavaScript tests (`notApplicable: no_python_test_changes`),
 * so a never-called callback assert in a node:test file counted as
 * green. This module closes that half:
 *
 * * statically, scan every `assert(...)` / `assert.<method>(...)` call
 *   in the collected JS test files (file, line, end line, source,
 *   enclosing test) -- a small masking scanner, no parser dependency;
 * * at runtime, run each target test file in its own plain `node`
 *   process under V8 coverage (`NODE_V8_COVERAGE`) and check each
 *   assert's offset against the innermost coverage range containing
 *   it (V8 offsets are UTF-16 code units, the same units JS string
 *   indices use, so non-ASCII sources map exactly). Plain `node`
 *   per file -- not `node --test`: a `node --test` process tree does
 *   not write NODE_V8_COVERAGE files when the gate itself runs under
 *   a test runner (the runner collects coverage over IPC and discards
 *   it), so the gate would judge every assert unexecuted exactly in
 *   the repo's own test suite.
 * * afterwards, write evidence JSON: which asserts executed, which did
 *   not, and which belong to skipped tests (`test.skip` /
 *   `{ skip: true }` / `describe.skip`, reported as skipped, not red).
 *
 * Diff scoping mirrors the Python half: `--only-changed` judges only
 * asserts added/changed vs a diff base (default `main`) or a diff file;
 * asserts outside the diff go to `outOfScope` and are never red; an
 * empty diff passes. The Python CLI orchestrates both halves and
 * merges the evidence into one `i6d-0.json`; this module is also
 * usable standalone:
 *
 *   node xflow/atoms/i6d_assertion_execution_js.js --root <dir> \
 *     --output <evidence.json> [--only-changed] [--diff-base main] \
 *     [--diff-file <diff>] [--include-uncommitted] [-- <test files>]
 *
 * Exit codes mirror the Python half: 0 pass, 1 unexecuted assertions
 * or a failing node:test run, 2 misuse/errors.
 *
 * Known limits (documented, not silent): only the `assert` identifier
 * (node:assert / node:assert/strict, as imported by convention) is
 * tracked -- `t.assert` and aliased imports are not; asserts inside
 * template-literal interpolations are masked with the literal; a
 * helper function shared by a skipped test and a live test is judged
 * by coverage alone; a module-level assert after a statement that
 * throws at import is judged by the module range, not the exact line.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VERSION = 1;

export function isJavaScriptTestFile(path) {
  const name = basename(String(path || ''));
  return (
    /\.test\.(js|mjs|cjs)$/.test(name) ||
    /^test-.*\.(js|mjs|cjs)$/.test(name)
  );
}

// ---------------------------------------------------------------------------
// Masked-source scanner: strings, comments, regex literals and template
// literals are blanked (newlines kept) so `assert` inside them is never
// mistaken for code, while every offset stays identical to the original.
// Template interpolations (${...}) stay live code.
// ---------------------------------------------------------------------------

function maskSource(source) {
  const out = source.split('');
  const n = source.length;
  let i = 0;
  // Frames: { kind: 'tpl' } inside a template literal, or
  // { kind: 'interp', depth } inside a ${...} interpolation.
  const stack = [];
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  const prevSignificant = (pos) => {
    for (let k = pos - 1; k >= 0; k -= 1) {
      const ch = out[k];
      if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') return ch;
    }
    return '';
  };
  const prevWord = (pos) => {
    let k = pos - 1;
    while (k >= 0 && /[\s]/.test(out[k])) k -= 1;
    const end = k + 1;
    while (k >= 0 && /[\w$]/.test(out[k])) k -= 1;
    return out.slice(k + 1, end).join('');
  };

  while (i < n) {
    const top = stack.length > 0 ? stack[stack.length - 1] : null;
    const ch = source[i];
    const next = source[i + 1] || '';
    if (top && top.kind === 'tpl') {
      if (ch === '`') {
        out[i] = ' ';
        stack.pop();
        i += 1;
      } else if (ch === '\\') {
        out[i] = ' ';
        if (i + 1 < n) {
          if (out[i + 1] !== '\n') out[i + 1] = ' ';
          i += 2;
        } else {
          i += 1;
        }
      } else if (ch === '$' && next === '{') {
        stack.push({ kind: 'interp', depth: 0 });
        i += 2;
      } else {
        if (ch !== '\n') out[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < n && source[i] !== quote && source[i] !== '\n') {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      if (i < n && source[i] === quote) i += 1;
      blank(start, i);
      continue;
    }
    if (ch === '`') {
      out[i] = ' ';
      stack.push({ kind: 'tpl' });
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      const start = i;
      while (i < n && source[i] !== '\n') i += 1;
      blank(start, i);
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      if (i < n) i += 2;
      blank(start, i);
      continue;
    }
    if (ch === '/') {
      const prev = prevSignificant(i);
      const word = prevWord(i);
      const regexOk =
        prev === '' ||
        '(,=:[!&|?{};+-*%<>^~'.includes(prev) ||
        ['return', 'typeof', 'case', 'delete', 'void', 'in', 'of', 'new', 'yield', 'await', 'else', 'do'].includes(word);
      if (regexOk) {
        const start = i;
        i += 1;
        let inClass = false;
        while (i < n && source[i] !== '\n') {
          if (source[i] === '\\') {
            i += 2;
            continue;
          }
          if (source[i] === '[') inClass = true;
          if (source[i] === ']') inClass = false;
          if (source[i] === '/' && !inClass) {
            i += 1;
            break;
          }
          i += 1;
        }
        while (i < n && /[a-z]/i.test(source[i])) i += 1;
        blank(start, i);
        continue;
      }
      i += 1;
      continue;
    }
    if (top && top.kind === 'interp') {
      if (ch === '{') {
        top.depth += 1;
        i += 1;
        continue;
      }
      if (ch === '}') {
        if (top.depth === 0) {
          stack.pop();
          i += 1;
          continue;
        }
        top.depth -= 1;
        i += 1;
        continue;
      }
    }
    i += 1;
  }
  return out.join('');
}

function lineStartsOf(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function offsetToLine(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function matchingParen(masked, openPos) {
  let depth = 0;
  for (let i = openPos; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function matchingBrace(masked, openPos) {
  let depth = 0;
  for (let i = openPos; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Find the `=>` or `function` that introduces a test callback, at brace /
// paren / bracket depth 0 inside the call header, and return the offset of
// the callback body's opening `{` (or -1 for an expression-body arrow,
// whose body runs to the call's closing paren).
function callbackBodyBrace(masked, headerStart, headerEnd) {
  // Scan inside the call's own parens (headerStart is the call's `(`):
  // depth is relative to the call, so the callback's `=>` sits at depth 0.
  let depth = 0;
  let lastArrow = -1;
  let lastFunction = -1;
  let i = headerStart + 1;
  while (i < headerEnd) {
    const ch = masked[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (depth === 0 && ch === '=' && masked[i + 1] === '>') lastArrow = i;
    else if (depth === 0 && masked.startsWith('function', i) && !/[\w$]/.test(masked[i - 1] || '') && !/[\w$]/.test(masked[i + 8] || '')) lastFunction = i;
    i += 1;
  }
  const anchor = Math.max(lastArrow, lastFunction);
  if (anchor === -1) return -1;
  const brace = masked.indexOf('{', anchor);
  if (brace === -1 || brace >= headerEnd) return -1;
  return brace;
}

function collectTestBlocks(source, masked) {
  const blocks = [];
  const re = /\b(test|it|describe)\s*(?:\.\s*(skip|only)\s*)?\(/g;
  let match;
  while ((match = re.exec(masked)) !== null) {
    const [, kind, modifier] = match;
    const openParen = masked.indexOf('(', match.index);
    const closeParen = matchingParen(masked, openParen);
    if (closeParen === -1) continue;
    const headerMasked = masked.slice(openParen, closeParen + 1);
    const headerSource = source.slice(openParen, closeParen + 1);
    const skipped =
      modifier === 'skip' || /\bskip\s*:\s*true\b/.test(headerMasked);
    const nameMatch = headerSource.match(/^\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/);
    const name = nameMatch ? nameMatch[2] : null;
    const brace = callbackBodyBrace(masked, openParen, closeParen + 1);
    if (brace === -1) continue;
    const bodyEnd = matchingBrace(masked, brace);
    if (bodyEnd === -1) continue;
    blocks.push({
      kind,
      name,
      skipped,
      startOffset: brace,
      endOffset: bodyEnd + 1,
    });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Static collection
// ---------------------------------------------------------------------------

export function collectAssertions(path) {
  const abspath = realpathSync(path);
  const source = readFileSync(abspath, 'utf8');
  const masked = maskSource(source);
  const starts = lineStartsOf(source);
  const blocks = collectTestBlocks(source, masked);
  const found = [];
  const re = /\bassert(?:\s*\.\s*[A-Za-z_$][\w$]*)?\s*\(/g;
  let match;
  while ((match = re.exec(masked)) !== null) {
    const callStart = match.index;
    const openParen = masked.indexOf('(', callStart);
    const closeParen = matchingParen(masked, openParen);
    const endOffset = closeParen === -1 ? openParen + 1 : closeParen + 1;
    const rawSource = source.slice(callStart, endOffset).replace(/\s+/g, ' ').trim();
    const sourceText = rawSource.length > 200 ? `${rawSource.slice(0, 197)}...` : rawSource;
    let enclosing = null;
    let skipped = false;
    let innermost = null;
    for (const block of blocks) {
      if (callStart >= block.startOffset && callStart < block.endOffset) {
        if (!innermost || (block.endOffset - block.startOffset) < (innermost.endOffset - innermost.startOffset)) {
          innermost = block;
        }
        if (block.skipped) skipped = true;
      }
    }
    if (innermost && (innermost.kind === 'test' || innermost.kind === 'it')) {
      enclosing = innermost.name;
    }
    found.push({
      file: abspath,
      line: offsetToLine(starts, callStart),
      endLine: offsetToLine(starts, endOffset - 1),
      offset: callStart,
      source: sourceText,
      test: enclosing,
      skipped,
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Diff scoping -- a port of the Python half's unified-diff parsing, same
// semantics: only added (`+`) lines count, context and removed lines do not.
// ---------------------------------------------------------------------------

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

function git(repo, ...argv) {
  const proc = spawnSync('git', argv, { cwd: repo, encoding: 'utf8', timeout: 30000 });
  if (proc.status !== 0) {
    throw new Error(`git ${argv.join(' ')} failed (${proc.status}): ${(proc.stderr || '').trim()}`);
  }
  return proc.stdout;
}

export function resolveDiffBase(repo, base = 'main') {
  return git(repo, 'merge-base', 'HEAD', base).trim();
}

function parseUnifiedDiff(diffText, repo) {
  const changed = {};
  let current = null;
  let newLineno = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      let target = line.slice(4).trim();
      if (target === '/dev/null' || target === '') {
        current = null;
        newLineno = null;
        continue;
      }
      if (target.startsWith('b/')) target = target.slice(2);
      if (target.length >= 2 && target.startsWith('"') && target.endsWith('"')) {
        target = JSON.parse(target);
      }
      current = resolve(repo, target);
      changed[current] = changed[current] || new Set();
      newLineno = null;
    } else if (line.startsWith('@@ ') && current !== null) {
      const m = HUNK_RE.exec(line);
      newLineno = m ? parseInt(m[1], 10) : null;
    } else if (current === null || newLineno === null) {
      continue;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      changed[current].add(newLineno);
      newLineno += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // deleted line: the new-side number does not advance
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file": no advance
    } else {
      newLineno += 1; // context line
    }
  }
  const out = {};
  for (const [path, lines] of Object.entries(changed)) {
    if (lines.size > 0) out[path] = [...lines].sort((a, b) => a - b);
  }
  return out;
}

export function changedLinesFromDiff(diffText, repo) {
  return parseUnifiedDiff(diffText, resolve(repo));
}

export function changedLines(repo, base = 'main', uncommitted = false) {
  const mergeBase = resolveDiffBase(repo, base);
  const raw = git(repo, 'diff', mergeBase, 'HEAD', '-U0', '--');
  const changed = parseUnifiedDiff(raw, repo);
  if (uncommitted) {
    const rawWt = git(repo, 'diff', 'HEAD', '-U0', '--');
    for (const [path, lines] of Object.entries(parseUnifiedDiff(rawWt, repo))) {
      changed[path] = [...new Set([...(changed[path] || []), ...lines])].sort((a, b) => a - b);
    }
  }
  return { base: mergeBase, changed };
}

export function assertInScope(entry, changed) {
  const lines = changed[resolve(entry.file)];
  if (!lines || lines.length === 0) return false;
  const end = entry.endLine || entry.line;
  return lines.some((n) => n >= entry.line && n <= end);
}

// ---------------------------------------------------------------------------
// V8 coverage: run node --test under NODE_V8_COVERAGE, then judge each
// assert by the innermost coverage range containing its start offset.
// ---------------------------------------------------------------------------

function walkTestFiles(root) {
  const found = [];
  const skipDirs = new Set(['node_modules', '.git']);
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(path);
      } else if (entry.isFile() && isJavaScriptTestFile(path)) {
        found.push(path);
      }
    }
  };
  walk(resolve(root));
  return found.sort();
}

function coverageRangesForFile(covDir, file) {
  const ranges = [];
  let entries;
  try {
    entries = readdirSync(covDir);
  } catch {
    return ranges;
  }
  for (const name of entries) {
    if (!name.startsWith('coverage-') || !name.endsWith('.json')) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(covDir, name), 'utf8'));
    } catch {
      continue;
    }
    for (const script of parsed.result || []) {
      if (!script.url || !script.url.startsWith('file://')) continue;
      let scriptPath;
      try {
        scriptPath = realpathSync(fileURLToPath(script.url));
      } catch {
        continue;
      }
      if (scriptPath !== file) continue;
      for (const fn of script.functions || []) {
        for (const range of fn.ranges || []) {
          ranges.push({ start: range.startOffset, end: range.endOffset, count: range.count });
        }
      }
    }
  }
  return ranges;
}

function assertExecuted(assertEntry, rangesByFile) {
  // V8 coverage offsets are UTF-16 code units, the same units JS string
  // indices use, so the recorded keyword offset maps exactly -- including
  // in non-ASCII sources.
  const offset = assertEntry.offset;
  const ranges = rangesByFile.get(assertEntry.file) || [];
  let bestLen = Infinity;
  let executed = false;
  for (const range of ranges) {
    if (offset >= range.start && offset < range.end) {
      const len = range.end - range.start;
      if (len < bestLen) {
        bestLen = len;
        executed = range.count > 0;
      } else if (len === bestLen && range.count > 0) {
        executed = true;
      }
    }
  }
  return executed;
}

function publicEntry(entry) {
  return {
    file: entry.file,
    line: entry.line,
    endLine: entry.endLine,
    source: entry.source,
    test: entry.test,
  };
}

export function buildEvidence({ rootdir, asserts, executed, skipped, nodeExit, changed = null, diffBase = null, diffError = null }) {
  const executedList = [];
  const unexecuted = [];
  const skippedList = [];
  const outOfScope = [];
  for (const entry of asserts) {
    if (changed !== null && !assertInScope(entry, changed)) {
      outOfScope.push(publicEntry(entry));
      continue;
    }
    const key = `${entry.file}:${entry.line}`;
    if (executed.has(key)) {
      executedList.push(publicEntry(entry));
    } else if (skipped.has(key)) {
      skippedList.push(publicEntry(entry));
    } else {
      unexecuted.push(publicEntry(entry));
    }
  }
  let verdict;
  if (diffError !== null && diffError !== undefined) verdict = 'diff_error';
  else if (unexecuted.length > 0) verdict = 'unexecuted_assertions';
  else if (nodeExit !== 0 && nodeExit !== null && nodeExit !== undefined) verdict = 'js_test_failed';
  else verdict = 'pass';
  const evidence = {
    tool: 'i6d_assertion_execution_js',
    version: VERSION,
    root: resolve(rootdir),
    nodeExit: nodeExit ?? null,
    verdict,
    total: asserts.length,
    executed: executedList.length,
    unexecuted,
    skipped: skippedList,
  };
  if (changed !== null || diffBase !== null || diffError !== null) {
    evidence.diffBase = diffBase;
    evidence.inScope = executedList.length + unexecuted.length + skippedList.length;
    evidence.outOfScope = outOfScope;
  }
  if (diffError !== null && diffError !== undefined) evidence.diffError = diffError;
  return evidence;
}

// ---------------------------------------------------------------------------
// CLI: run node --test under V8 coverage, then judge the evidence
// ---------------------------------------------------------------------------

export function runGate({ root, output, testArgs = [], onlyChanged = false, diffBase = 'main', diffFile = null, includeUncommitted = false }) {
  const rootAbs = resolve(root);
  const outputAbs = resolve(output);
  const parent = dirname(outputAbs);
  if (parent) mkdirSync(parent, { recursive: true });

  let changed = null;
  let diffBaseOut = null;
  let diffSource = null;
  let diffError = null;
  if (onlyChanged) {
    try {
      if (diffFile !== null) {
        changed = changedLinesFromDiff(readFileSync(diffFile, 'utf8'), rootAbs);
        diffSource = 'diff-file';
      } else {
        const resolved = changedLines(rootAbs, diffBase, includeUncommitted);
        diffBaseOut = resolved.base;
        changed = resolved.changed;
        diffSource = includeUncommitted ? 'git-range+uncommitted' : 'git-range';
      }
    } catch (err) {
      diffError = String(err && err.message ? err.message : err);
    }
  }

  // Targets: explicit JS test files from the args, else (scoped mode) the
  // changed JS test files, else whole-root discovery by node --test.
  let targets = [];
  if (testArgs.length > 0) {
    targets = testArgs.filter((arg) => !arg.startsWith('-') && isJavaScriptTestFile(arg));
  } else if (onlyChanged && changed !== null) {
    targets = Object.keys(changed)
      .filter((path) => isJavaScriptTestFile(path) && existsSync(path))
      .map((path) => path);
  }
  const collectFiles = targets.length > 0
    ? targets.map((t) => resolve(rootAbs, t))
    : walkTestFiles(rootAbs);

  if (diffError !== null) {
    const evidence = {
      tool: 'i6d_assertion_execution_js',
      version: VERSION,
      root: rootAbs,
      nodeExit: null,
      verdict: 'diff_error',
      total: 0,
      executed: 0,
      unexecuted: [],
      skipped: [],
      diffBase: diffBaseOut,
      diffSource,
      diffError,
    };
    writeFileSync(outputAbs, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    process.stderr.write(`i6d-js: diff_error: ${diffError}\n`);
    return 2;
  }

  const asserts = [];
  for (const file of collectFiles) {
    try {
      asserts.push(...collectAssertions(file));
    } catch {
      // A file that cannot be read contributes nothing; the test run
      // itself will fail loudly if the file matters.
    }
  }

  // Each target file runs in its own plain `node` process (see the
  // header note: `node --test` swallows NODE_V8_COVERAGE files under a
  // test runner). A failing file does not stop the other files: its
  // asserts may still have executed, and the gate judges them all.
  const covDir = mkdtempSync(join(tmpdir(), 'evalid-i6d-js-cov-'));
  let nodeExit = 0;
  let spawnError = null;
  try {
    const env = { ...process.env, NODE_V8_COVERAGE: covDir };
    for (const file of collectFiles) {
      const proc = spawnSync(process.execPath, [file], {
        cwd: rootAbs,
        env,
        encoding: 'utf8',
        timeout: 600000,
      });
      if (proc.error) {
        spawnError = proc.error;
        nodeExit = 1;
        break;
      }
      if (proc.status !== 0 && nodeExit === 0) nodeExit = proc.status;
    }
  } finally {
    // Coverage is parsed before the directory is removed below.
    try {
      const rangesByFile = new Map();
      for (const entry of asserts) {
        if (!rangesByFile.has(entry.file)) {
          rangesByFile.set(entry.file, coverageRangesForFile(covDir, entry.file));
        }
      }
      const executed = new Set();
      const skipped = new Set();
      for (const entry of asserts) {
        const key = `${entry.file}:${entry.line}`;
        if (entry.skipped) skipped.add(key);
        if (assertExecuted(entry, rangesByFile)) executed.add(key);
      }
      const evidence = buildEvidence({
        rootdir: rootAbs,
        asserts,
        executed,
        skipped,
        nodeExit,
        changed,
        diffBase: diffBaseOut,
        diffError: null,
      });
      evidence.diffSource = diffSource;
      writeFileSync(outputAbs, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
      const summary = `i6d-js: ${evidence.verdict} (${evidence.executed}/${evidence.total} assertions executed, `
        + `${evidence.unexecuted.length} unexecuted, ${evidence.skipped.length} skipped; node exit ${nodeExit})`
        + ('outOfScope' in evidence ? ` [${evidence.outOfScope.length} out of diff scope, base ${evidence.diffBase}]` : '');
      process.stdout.write(`${summary}\n`);
      for (const entry of evidence.unexecuted) {
        process.stdout.write(`  unexecuted: ${entry.file}:${entry.line}: ${entry.source}\n`);
      }
      if (spawnError) return 2;
      return evidence.verdict === 'pass' ? 0 : 1;
    } finally {
      rmSync(covDir, { recursive: true, force: true });
    }
  }
}

function parseArgs(argv) {
  const args = { root: process.cwd(), output: null, testArgs: [], onlyChanged: false, diffBase: 'main', diffFile: null, includeUncommitted: false };
  let i = 0;
  let rest = false;
  while (i < argv.length) {
    const arg = argv[i];
    if (rest) {
      args.testArgs.push(arg);
      i += 1;
      continue;
    }
    if (arg === '--') {
      rest = true;
      i += 1;
      continue;
    }
    const [flag, inline] = arg.split(/=(.*)/s, 2);
    const value = inline !== undefined ? inline : argv[i + 1];
    const takesValue = ['--root', '--output', '--diff-base', '--diff-file'].includes(flag);
    if (takesValue && inline === undefined) i += 1;
    if (flag === '--root') args.root = value;
    else if (flag === '--output') args.output = value;
    else if (flag === '--only-changed') args.onlyChanged = true;
    else if (flag === '--diff-base') args.diffBase = value;
    else if (flag === '--diff-file') args.diffFile = value;
    else if (flag === '--include-uncommitted') args.includeUncommitted = true;
    else if (flag === '--help') {
      process.stdout.write('Usage: i6d_assertion_execution_js.js --root <dir> --output <evidence.json> [--only-changed] [--diff-base main] [--diff-file <diff>] [--include-uncommitted] [-- <test files>]\n');
      process.exit(0);
    } else {
      process.stderr.write(`i6d-js: unknown argument: ${arg}\n`);
      process.exit(2);
    }
    i += 1;
  }
  if (!args.output) {
    process.stderr.write('i6d-js: --output is required\n');
    process.exit(2);
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  return runGate(args);
}

const invokedAsScript =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  process.exitCode = main();
}
