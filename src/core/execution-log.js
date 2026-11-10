import { appendFile, mkdir, open, readFile, stat } from 'node:fs/promises';
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildLogEntryHash, validateExecutionLogChain } from './workflow-integrity.js';

const TAIL_WINDOW_BYTES = 16_384;

// Tail anchors are cached per log file: an append only needs the previous entry_hash, and
// re-reading a multi-megabyte log for every event made appends O(n^2). The cache is keyed by
// (size, mtimeMs) so an external writer (another xflow process, a rotated or truncated log that
// lands on the same size) invalidates it instead of serving a stale anchor.
const tailStateCache = new Map();

function nowIso() {
  return new Date().toISOString();
}

let appendQueue = Promise.resolve();

export function resolveExecutionLogPath(projectRoot = process.cwd()) {
  return resolve(projectRoot, '.as-xflow', 'logs', 'execution.ndjson');
}

export async function appendExecutionLog(projectRoot, entry = {}) {
  const append = appendQueue.then(
    () => appendExecutionLogUnlocked(projectRoot, entry),
    () => appendExecutionLogUnlocked(projectRoot, entry),
  );
  appendQueue = append.catch(() => {});
  return append;
}

async function appendExecutionLogUnlocked(projectRoot, entry = {}) {
  const file = resolveExecutionLogPath(projectRoot);
  await mkdir(dirname(file), { recursive: true });
  const tail = await readTailState(file);
  const payload = {
    timestamp: nowIso(),
    ...entry,
    prev_hash: tail.hash,
  };
  payload.entry_hash = buildLogEntryHash(payload);
  // A crash can leave a partial trailing line; start a fresh line so the new entry stays
  // parseable instead of being glued onto the fragment.
  const line = `${tail.size > 0 && !tail.endsWithNewline ? '\n' : ''}${JSON.stringify(payload)}\n`;
  await appendFile(file, line, 'utf8');
  await rememberAppendedTail(file, payload.entry_hash);
  return file;
}

export function appendExecutionLogSync(projectRoot, entry = {}) {
  const file = resolveExecutionLogPath(projectRoot);
  mkdirSync(dirname(file), { recursive: true });
  const tail = readTailStateSync(file);
  const payload = {
    timestamp: nowIso(),
    ...entry,
    prev_hash: tail.hash,
  };
  payload.entry_hash = buildLogEntryHash(payload);
  const line = `${tail.size > 0 && !tail.endsWithNewline ? '\n' : ''}${JSON.stringify(payload)}\n`;
  appendFileSync(file, line, 'utf8');
  rememberAppendedTailSync(file, payload.entry_hash);
  return file;
}

export async function readExecutionLog(projectRoot, options = {}) {
  const file = resolveExecutionLogPath(projectRoot);
  const limit = Math.max(1, Number(options.limit || 20));

  try {
    const raw = await readFile(file, 'utf8');
    const chronological = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { kind: 'invalid_log_line', raw: line };
        }
      });
    const chain = validateExecutionLogChain(chronological);
    const entries = chronological.slice(-limit).reverse();

    return { file, entries, entries_chronological: chronological, chain };
  } catch {
    return { file, entries: [], entries_chronological: [], chain: { ok: true, issues: [], entries_checked: 0 } };
  }
}

export async function readLastEntryHash(file) {
  const tail = await readTailState(file);
  return tail.hash;
}

async function readTailState(file) {
  try {
    const info = await stat(file);
    const cached = tailStateCache.get(file);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
      return cached;
    }
    const state = {
      size: info.size,
      mtimeMs: info.mtimeMs,
      hash: await readTailHash(file, info.size),
      endsWithNewline: await tailEndsWithNewline(file, info.size),
    };
    tailStateCache.set(file, state);
    return state;
  } catch {
    return { size: 0, mtimeMs: null, hash: null, endsWithNewline: true };
  }
}

function readTailStateSync(file) {
  try {
    const info = statSync(file);
    const cached = tailStateCache.get(file);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
      return cached;
    }
    const state = {
      size: info.size,
      mtimeMs: info.mtimeMs,
      hash: readTailHashSync(file, info.size),
      endsWithNewline: tailEndsWithNewlineSync(file, info.size),
    };
    tailStateCache.set(file, state);
    return state;
  } catch {
    return { size: 0, mtimeMs: null, hash: null, endsWithNewline: true };
  }
}

async function readTailHash(file, size) {
  if (!size) return null;
  // The window must contain at least one complete line to anchor the chain. A single entry
  // larger than the window (an error or detail field is unbounded) leaves no complete line, so
  // the window grows until the previous entry comes into view. Returning null instead made the
  // next append pick up prev_hash: null, which permanently breaks the chain after a restart or
  // from a second process.
  let windowBytes = TAIL_WINDOW_BYTES;
  for (;;) {
    const start = Math.max(0, size - windowBytes);
    const hash = await readHashWindow(file, start, size);
    if (hash !== null || start === 0) return hash;
    windowBytes *= 4;
  }
}

function readTailHashSync(file, size) {
  if (!size) return null;
  let windowBytes = TAIL_WINDOW_BYTES;
  for (;;) {
    const start = Math.max(0, size - windowBytes);
    const hash = readHashWindowSync(file, start, size);
    if (hash !== null || start === 0) return hash;
    windowBytes *= 4;
  }
}

async function readHashWindow(file, start, size) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return lastEntryHashFromRaw(buffer.subarray(0, bytesRead).toString('utf8'), start > 0);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

function readHashWindowSync(file, start, size) {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    return lastEntryHashFromRaw(buffer.subarray(0, bytesRead).toString('utf8'), start > 0);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Record the anchor that was just written. One cheap stat keeps the cache key (size, mtimeMs)
 * honest, so a later writer that rewrites the file at the same size invalidates the entry.
 */
async function rememberAppendedTail(file, entryHash) {
  try {
    const info = await stat(file);
    tailStateCache.set(file, {
      size: info.size,
      mtimeMs: info.mtimeMs,
      hash: entryHash,
      endsWithNewline: true,
    });
  } catch {
    tailStateCache.delete(file);
  }
}

function rememberAppendedTailSync(file, entryHash) {
  try {
    const info = statSync(file);
    tailStateCache.set(file, {
      size: info.size,
      mtimeMs: info.mtimeMs,
      hash: entryHash,
      endsWithNewline: true,
    });
  } catch {
    tailStateCache.delete(file);
  }
}

async function tailEndsWithNewline(file, size) {
  if (!size) return true;
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(1);
    const { bytesRead } = await handle.read(buffer, 0, 1, size - 1);
    return bytesRead === 0 || buffer[0] === 0x0a;
  } catch {
    return true;
  } finally {
    await handle.close();
  }
}

function tailEndsWithNewlineSync(file, size) {
  if (!size) return true;
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1);
    const bytesRead = readSync(fd, buffer, 0, 1, size - 1);
    return bytesRead === 0 || buffer[0] === 0x0a;
  } catch {
    return true;
  } finally {
    closeSync(fd);
  }
}

function lastEntryHashFromRaw(raw, startedMidLine = false) {
  const lines = raw.split('\n');
  if (startedMidLine) {
    // The first line of a tail window is usually a fragment; it cannot anchor the chain.
    lines.shift();
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.entry_hash) return entry.entry_hash;
    } catch {
      // A corrupt or truncated trailing line must not reset the chain; keep scanning upwards.
    }
  }
  return null;
}
