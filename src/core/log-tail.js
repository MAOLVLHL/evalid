/**
 * log-tail — byte-offset reader for the hash-chained execution log.
 *
 * The execution log (.as-xflow/logs/execution.ndjson) is the single source of truth for
 * workflow progress: the CLI writes it, `xflow serve` reads it. Live consumers therefore tail
 * it by byte offset instead of re-reading it, and resume from the `entry_hash` they last saw
 * (SSE Last-Event-ID). Every offset returned here sits on a line boundary, so a consumer never
 * observes half an entry.
 */
import { open, readFile, stat } from 'node:fs/promises';
import { resolveExecutionLogPath } from './execution-log.js';

export const DEFAULT_TAIL_LIMIT = 200;
export const MAX_TAIL_READ_BYTES = 4 * 1024 * 1024;
const OVERSCAN_BYTES = 64 * 1024;
const MAX_OVERSCAN_BYTES = 64 * 1024 * 1024;

export async function readExecutionLogSize(projectRoot = process.cwd()) {
  try {
    return (await stat(resolveExecutionLogPath(projectRoot))).size;
  } catch {
    return 0;
  }
}

/**
 * Read the entries written after `offset`.
 *
 * Returns { entries, nextOffset, size, hasMore, partial, eof }. `nextOffset` only ever advances
 * past a complete line, so an entry that is still being written is re-read (not skipped) on the
 * next call. `limit` caps one call so a large backlog is drained over several calls instead of
 * one unbounded read.
 */
export async function readEntriesFromOffset(projectRoot = process.cwd(), offset = 0, options = {}) {
  const file = resolveExecutionLogPath(projectRoot);
  const limit = Math.max(1, Math.floor(Number(options.limit) || DEFAULT_TAIL_LIMIT));
  const size = await readExecutionLogSize(projectRoot);
  const requested = Math.floor(Number(offset) || 0);
  const start = Math.min(Math.max(0, requested), size);
  if (start >= size) {
    return { file, entries: [], nextOffset: size, size, hasMore: false, partial: false, eof: true };
  }

  const end = Math.min(size, start + MAX_TAIL_READ_BYTES);
  const window = await readRange(file, start, end);
  const entries = [];
  let cursor = 0;
  let nextOffset = start;
  let sawNewline = false;

  while (entries.length < limit) {
    const newlineAt = window.indexOf(0x0a, cursor);
    if (newlineAt === -1) break;
    sawNewline = true;
    const line = window.subarray(cursor, newlineAt).toString('utf8').trim();
    cursor = newlineAt + 1;
    nextOffset = start + cursor;
    if (!line) continue;
    entries.push(parseEntryLine(line));
  }

  if (!sawNewline && end < size) {
    // One entry larger than the read window would stall the tail forever (the same offset
    // would be returned on every poll). Skip to the next line boundary and tell the caller.
    const skippedTo = await skipOversizedLine(file, end, size);
    entries.push({
      kind: 'invalid_log_line',
      raw: 'line_exceeds_read_window',
      reason: 'entry_larger_than_read_window',
      truncated: true,
    });
    return {
      file,
      entries,
      nextOffset: skippedTo,
      size,
      hasMore: skippedTo < size,
      partial: false,
      eof: skippedTo >= size,
    };
  }

  return {
    file,
    entries,
    nextOffset,
    size,
    hasMore: nextOffset < size,
    // Anything left in the window sits after the last newline, i.e. an entry still being written.
    partial: cursor < window.length,
    eof: nextOffset >= size,
  };
}

/**
 * Map an entry_hash to the byte offset just past that entry.
 *
 * Returns null when the hash is unknown (rotated or deleted log), which callers treat as
 * "replay is impossible, fall back to a snapshot" rather than as an error.
 */
export async function resolveEntryOffset(projectRoot = process.cwd(), entryHash) {
  const wanted = String(entryHash || '').trim();
  if (!wanted) return null;
  const file = resolveExecutionLogPath(projectRoot);
  let raw;
  try {
    raw = await readFile(file);
  } catch {
    return null;
  }

  let cursor = 0;
  while (cursor < raw.length) {
    const newlineAt = raw.indexOf(0x0a, cursor);
    if (newlineAt === -1) break;
    const line = raw.subarray(cursor, newlineAt).toString('utf8').trim();
    cursor = newlineAt + 1;
    if (!line) continue;
    try {
      if (JSON.parse(line).entry_hash === wanted) return cursor;
    } catch {
      // Corrupt lines cannot match a hash; keep scanning.
    }
  }
  return null;
}

function parseEntryLine(line) {
  try {
    const entry = JSON.parse(line);
    return entry && typeof entry === 'object' ? entry : { kind: 'invalid_log_line', raw: line.slice(0, 512) };
  } catch {
    return { kind: 'invalid_log_line', raw: line.slice(0, 512), reason: 'invalid_json' };
  }
}

async function readRange(file, start, end) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function skipOversizedLine(file, from, size) {
  let position = from;
  while (position < size) {
    const chunkEnd = Math.min(size, position + OVERSCAN_BYTES);
    const chunk = await readRange(file, position, chunkEnd);
    const newlineAt = chunk.indexOf(0x0a);
    if (newlineAt !== -1) return position + newlineAt + 1;
    position = chunkEnd;
    if (position - from > MAX_OVERSCAN_BYTES) return position;
  }
  return size;
}
