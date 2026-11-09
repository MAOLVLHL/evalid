import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { appendExecutionLog, resolveExecutionLogPath } from '../src/core/execution-log.js';
import { readEntriesFromOffset, readExecutionLogSize, resolveEntryOffset } from '../src/core/log-tail.js';

function makeProjectRoot() {
  const root = mkdtempSync(join(tmpdir(), 'openflow-log-tail-'));
  mkdirSync(resolve(root, '.as-xflow', 'logs'), { recursive: true });
  return root;
}

async function seed(root, atomIds) {
  for (const atomId of atomIds) {
    await appendExecutionLog(root, { kind: 'atom_run', atom_id: atomId, status: 'ok' });
  }
}

describe('Log tail', () => {
  test('treats a missing log as an empty, fully-read stream', async () => {
    const projectRoot = makeProjectRoot();
    try {
      const batch = await readEntriesFromOffset(projectRoot, 0);
      assert.deepEqual(batch.entries, []);
      assert.equal(batch.nextOffset, 0);
      assert.equal(batch.eof, true);
      assert.equal(await readExecutionLogSize(projectRoot), 0);
      assert.equal(await resolveEntryOffset(projectRoot, 'unknown-hash'), null);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('reads every entry after the offset and reports the end of the file', async () => {
    const projectRoot = makeProjectRoot();
    try {
      await seed(projectRoot, ['A', 'B', 'C']);
      const size = await readExecutionLogSize(projectRoot);
      const batch = await readEntriesFromOffset(projectRoot, 0);
      assert.deepEqual(batch.entries.map((entry) => entry.atom_id), ['A', 'B', 'C']);
      assert.equal(batch.nextOffset, size);
      assert.equal(batch.eof, true);
      assert.equal(batch.hasMore, false);

      const empty = await readEntriesFromOffset(projectRoot, batch.nextOffset);
      assert.deepEqual(empty.entries, []);
      assert.equal(empty.nextOffset, size);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('honours the limit and resumes exactly where it stopped', async () => {
    const projectRoot = makeProjectRoot();
    try {
      await seed(projectRoot, ['A', 'B', 'C']);
      const first = await readEntriesFromOffset(projectRoot, 0, { limit: 2 });
      assert.equal(first.entries.length, 2);
      assert.equal(first.hasMore, true);

      const second = await readEntriesFromOffset(projectRoot, first.nextOffset, { limit: 2 });
      assert.deepEqual(second.entries.map((entry) => entry.atom_id), ['C']);
      assert.equal(second.nextOffset, first.size);
      assert.equal(second.eof, true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('leaves a half-written trailing line for the next poll', async () => {
    const projectRoot = makeProjectRoot();
    try {
      await seed(projectRoot, ['DONE']);
      const logFile = resolveExecutionLogPath(projectRoot);
      appendFileSync(logFile, JSON.stringify({ kind: 'atom_run', atom_id: 'WRITING' }));

      const first = await readEntriesFromOffset(projectRoot, 0);
      assert.deepEqual(first.entries.map((entry) => entry.atom_id), ['DONE']);
      assert.equal(first.partial, true);
      assert.equal(first.eof, false);

      appendFileSync(logFile, '\n');
      const second = await readEntriesFromOffset(projectRoot, first.nextOffset);
      assert.deepEqual(second.entries.map((entry) => entry.atom_id), ['WRITING']);
      assert.equal(second.eof, true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('maps an entry hash to the byte offset just past that entry', async () => {
    const projectRoot = makeProjectRoot();
    try {
      // A multi-byte payload proves the returned offset is a byte offset, not a character index.
      await appendExecutionLog(projectRoot, { kind: 'atom_run', atom_id: 'A', note: '你好，世界' });
      await seed(projectRoot, ['B', 'C']);

      const all = await readEntriesFromOffset(projectRoot, 0);
      const offset = await resolveEntryOffset(projectRoot, all.entries[0].entry_hash);
      assert.equal(typeof offset, 'number');

      const rest = await readEntriesFromOffset(projectRoot, offset);
      assert.deepEqual(rest.entries.map((entry) => entry.atom_id), ['B', 'C']);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('reports a corrupt line as an invalid entry and still advances the cursor', async () => {
    const projectRoot = makeProjectRoot();
    try {
      await seed(projectRoot, ['A']);
      const logFile = resolveExecutionLogPath(projectRoot);
      const offsetAfterSeed = await readExecutionLogSize(projectRoot);
      appendFileSync(logFile, 'this is not json\n');
      await seed(projectRoot, ['B']);

      const batch = await readEntriesFromOffset(projectRoot, offsetAfterSeed);
      assert.equal(batch.entries[0].kind, 'invalid_log_line');
      assert.equal(batch.entries[0].reason, 'invalid_json');
      assert.deepEqual(batch.entries.slice(1).map((entry) => entry.atom_id), ['B']);
      assert.equal(batch.eof, true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
