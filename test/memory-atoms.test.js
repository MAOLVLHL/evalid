import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildMemoryMount,
  createMemoryItem,
  listMemoryItems,
  resolveMemoryMissionId,
} from '../src/core/memory-state.js';
import { memoryItemManage } from '../src/core/atoms/memory/manage.js';
import { memoryMount } from '../src/core/atoms/memory/mount.js';
import { readStore, resolveDataFile } from '../src/core/state-store.js';

function makeProjectRoot() {
  return mkdtempSync(join(tmpdir(), 'evalid-memory-atoms-'));
}

function cleanupProjectRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

function makeState() {
  return { memories: [] };
}

function seedItems(state, count, missionId = 'm-seed') {
  const items = [];
  for (let index = 0; index < count; index += 1) {
    items.push(createMemoryItem(state, { mission_id: missionId, canonical_text: `seed ${index}` }));
  }
  return items;
}

describe('memory-state createMemoryItem', () => {
  test('creates an item with project defaults and unshifts it first', () => {
    const state = makeState();
    const item = createMemoryItem(state, { canonical_text: 'first fact' });

    assert.match(item.memory_id, /^mem_/);
    assert.equal(item.mission_id, null);
    assert.equal(item.scope, 'project');
    assert.equal(item.scope_ref, 'default-workspace');
    assert.equal(item.kind, 'fact');
    assert.equal(item.category, 'workflow');
    assert.equal(item.status, 'active');
    assert.equal(item.canonical_text, 'first fact');
    assert.deepEqual(item.structured_payload, {});
    assert.deepEqual(item.source_events, []);
    assert.deepEqual(item.evidence_refs, []);
    assert.equal(typeof item.created_at, 'string');
    assert.equal(item.created_at, item.updated_at);
    assert.equal(state.memories[0], item);

    const second = createMemoryItem(state, { canonical_text: 'second fact' });
    assert.equal(state.memories[0], second);
    assert.equal(state.memories[1], item);
    assert.notEqual(second.memory_id, item.memory_id);
  });

  test('derives mission scope from mission_id and falls back to text', () => {
    const state = makeState();
    const item = createMemoryItem(state, {
      mission_id: 'm-1',
      text: 'plain text fallback',
    });

    assert.equal(item.scope, 'mission');
    assert.equal(item.scope_ref, 'm-1');
    assert.equal(item.canonical_text, 'plain text fallback');
  });

  test('honours explicit scope, scope_ref, kind, category, status and payload', () => {
    const state = makeState();
    const item = createMemoryItem(state, {
      mission_id: 'm-2',
      workspace_id: 'ws-9',
      scope: 'workspace',
      scope_ref: 'ws-9',
      kind: 'decision',
      category: 'design',
      status: 'archived',
      canonical_text: 'explicit text',
      text: 'ignored when canonical_text is set',
      structured_payload: { key: 'value' },
      source_events: 'evt-1',
      evidence_refs: ['ref-1', 'ref-2'],
    });

    assert.equal(item.scope, 'workspace');
    assert.equal(item.scope_ref, 'ws-9');
    assert.equal(item.kind, 'decision');
    assert.equal(item.category, 'design');
    assert.equal(item.status, 'archived');
    assert.equal(item.canonical_text, 'explicit text');
    assert.deepEqual(item.structured_payload, { key: 'value' });
    assert.deepEqual(item.source_events, ['evt-1']);
    assert.deepEqual(item.evidence_refs, ['ref-1', 'ref-2']);
  });

  test('falls back to workspace_id for scope_ref when no scope_ref or mission_id', () => {
    const state = makeState();
    const item = createMemoryItem(state, { workspace_id: 'ws-7' });

    assert.equal(item.scope, 'project');
    assert.equal(item.scope_ref, 'ws-7');
    assert.equal(item.canonical_text, '');
  });

  test('initialises a missing memories field and wraps a non-array value', () => {
    const noField = {};
    const item = createMemoryItem(noField, { canonical_text: 'fresh' });
    assert.deepEqual(noField.memories, [item]);

    const nonArray = { memories: 'not-an-array' };
    const second = createMemoryItem(nonArray, { canonical_text: 'reset' });
    assert.deepEqual(nonArray.memories, [second, 'not-an-array']);
  });
});

describe('memory-state listMemoryItems', () => {
  test('returns all items without a filter and filters by mission, scope and status', () => {
    const state = makeState();
    const activeMission = createMemoryItem(state, { mission_id: 'm-a', status: 'active' });
    const archivedMission = createMemoryItem(state, { mission_id: 'm-a', status: 'archived' });
    const project = createMemoryItem(state, { canonical_text: 'project item' });

    assert.deepEqual(listMemoryItems(state), [project, archivedMission, activeMission]);
    assert.deepEqual(listMemoryItems(state, { mission_id: 'm-a' }), [archivedMission, activeMission]);
    assert.deepEqual(listMemoryItems(state, { scope: 'project' }), [project]);
    assert.deepEqual(listMemoryItems(state, { status: 'archived' }), [archivedMission]);
    assert.deepEqual(
      listMemoryItems(state, { mission_id: 'm-a', status: 'active' }),
      [activeMission],
    );
    assert.deepEqual(listMemoryItems(state, { mission_id: 'm-none' }), []);
  });

  test('returns an empty list when the state has no memories', () => {
    assert.deepEqual(listMemoryItems({}), []);
    assert.deepEqual(listMemoryItems({ memories: null }), []);
    assert.deepEqual(listMemoryItems({ memories: 'not-an-array' }), ['not-an-array']);
  });
});

describe('memory-state buildMemoryMount', () => {
  test('returns mission, total and items capped at the default limit of 20', () => {
    const state = makeState();
    seedItems(state, 25);

    const mount = buildMemoryMount(state, { mission_id: 'm-seed' });
    assert.equal(mount.mission_id, 'm-seed');
    assert.equal(mount.total, 20);
    assert.equal(mount.items.length, 20);
    assert.equal(mount.items[0].canonical_text, 'seed 24');
  });

  test('honours an explicit limit and defaults mission_id to null', () => {
    const state = makeState();
    seedItems(state, 5);

    const mount = buildMemoryMount(state, { limit: 3 });
    assert.equal(mount.mission_id, null);
    assert.equal(mount.total, 3);
    assert.equal(mount.items.length, 3);
  });
});

describe('memory-state resolveMemoryMissionId', () => {
  test('prefers the input mission_id over the runtime mission id', () => {
    assert.equal(
      resolveMemoryMissionId({ mission_id: 'm-input' }, { runtime: { missionId: 'm-runtime' } }),
      'm-input',
    );
  });

  test('falls back to the runtime mission id and then to null', () => {
    assert.equal(
      resolveMemoryMissionId({}, { runtime: { missionId: 'm-runtime' } }),
      'm-runtime',
    );
    assert.equal(resolveMemoryMissionId({}, {}), null);
    assert.equal(resolveMemoryMissionId({}, { runtime: {} }), null);
  });

  test('resolves a bound mission id from the bindings file', () => {
    const projectRoot = makeProjectRoot();
    try {
      mkdirSync(join(projectRoot, '.as-xflow'), { recursive: true });
      writeFileSync(
        join(projectRoot, '.as-xflow', 'bindings.json'),
        JSON.stringify({ 'chg-1': { mission_id: 'm-bound' } }),
      );

      assert.equal(
        resolveMemoryMissionId({ change_id: 'chg-1' }, { projectRoot }),
        'm-bound',
      );
      assert.equal(
        resolveMemoryMissionId({ change_id: 'chg-unknown' }, { projectRoot }),
        null,
      );
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  test('returns null when no change id can resolve a binding', () => {
    const projectRoot = makeProjectRoot();
    try {
      assert.equal(resolveMemoryMissionId({ change_id: 'chg-1' }, { projectRoot }), null);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });
});

describe('memory atom manage', () => {
  test('creates an item with the default action and persists it to the temp store', async () => {
    const projectRoot = makeProjectRoot();
    try {
      const created = await memoryItemManage(
        { canonical_text: 'persisted fact', kind: 'decision' },
        { projectRoot },
      );

      assert.equal(created.ok, true);
      assert.match(created.item.memory_id, /^mem_/);
      assert.equal(created.item.canonical_text, 'persisted fact');
      assert.equal(created.item.kind, 'decision');
      assert.equal(created.item.scope, 'project');

      const listed = await memoryItemManage({ action: 'list' }, { projectRoot });
      assert.equal(listed.ok, true);
      assert.equal(listed.items.length, 1);
      assert.equal(listed.items[0].memory_id, created.item.memory_id);

      const stored = await readStore(resolveDataFile({ projectRoot }));
      assert.equal(stored.memories.length, 1);
      assert.equal(stored.memories[0].memory_id, created.item.memory_id);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  test('lists only items of the resolved mission', async () => {
    const projectRoot = makeProjectRoot();
    try {
      const first = await memoryItemManage(
        { mission_id: 'm-a', canonical_text: 'for a' },
        { projectRoot },
      );
      await memoryItemManage({ mission_id: 'm-b', canonical_text: 'for b' }, { projectRoot });

      const listed = await memoryItemManage(
        { action: 'list', mission_id: 'm-a' },
        { projectRoot },
      );
      assert.equal(listed.items.length, 1);
      assert.equal(listed.items[0].memory_id, first.item.memory_id);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  test('resolves the mission from the runtime context', async () => {
    const projectRoot = makeProjectRoot();
    try {
      const created = await memoryItemManage(
        { canonical_text: 'runtime mission item' },
        { projectRoot, runtime: { missionId: 'm-runtime' } },
      );
      assert.equal(created.item.mission_id, 'm-runtime');
      assert.equal(created.item.scope, 'mission');

      const listed = await memoryItemManage(
        { action: 'list' },
        { projectRoot, runtime: { missionId: 'm-runtime' } },
      );
      assert.equal(listed.items.length, 1);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  test('honours an explicit data_file path', async () => {
    const projectRoot = makeProjectRoot();
    try {
      const dataFile = join(projectRoot, 'custom', 'memories.sqlite');
      const created = await memoryItemManage(
        { canonical_text: 'custom file item', data_file: dataFile },
        { projectRoot },
      );
      assert.equal(created.ok, true);

      const listed = await memoryItemManage(
        { action: 'list', data_file: dataFile },
        { projectRoot },
      );
      assert.equal(listed.items.length, 1);
      assert.equal(listed.items[0].canonical_text, 'custom file item');
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  test('falls back to process.cwd() when no projectRoot is given', async () => {
    const projectRoot = makeProjectRoot();
    const dataFile = join(projectRoot, 'env', 'memories.sqlite');
    const previous = process.env.AS_XFLOW_DATA_FILE;
    process.env.AS_XFLOW_DATA_FILE = dataFile;
    try {
      const created = await memoryItemManage({ canonical_text: 'cwd fallback item' }, {});
      assert.equal(created.ok, true);
      assert.equal(created.item.canonical_text, 'cwd fallback item');

      const listed = await memoryItemManage({ action: 'list' }, {});
      assert.equal(listed.items.length, 1);
    } finally {
      if (previous === undefined) {
        delete process.env.AS_XFLOW_DATA_FILE;
      } else {
        process.env.AS_XFLOW_DATA_FILE = previous;
      }
      cleanupProjectRoot(projectRoot);
    }
  });
});

describe('memory atom mount', () => {
  test('returns an empty mount for a fresh store', async () => {
    const projectRoot = makeProjectRoot();
    try {
      const result = await memoryMount({}, { projectRoot });
      assert.equal(result.ok, true);
      assert.equal(result.mount.mission_id, null);
      assert.equal(result.mount.total, 0);
      assert.deepEqual(result.mount.items, []);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  test('mounts created items for the resolved mission with a limit', async () => {
    const projectRoot = makeProjectRoot();
    try {
      for (let index = 0; index < 3; index += 1) {
        await memoryItemManage(
          { mission_id: 'm-mount', canonical_text: `mount ${index}` },
          { projectRoot },
        );
      }
      await memoryItemManage(
        { mission_id: 'm-other', canonical_text: 'other mission' },
        { projectRoot },
      );

      const result = await memoryMount(
        { mission_id: 'm-mount', limit: 2 },
        { projectRoot },
      );
      assert.equal(result.ok, true);
      assert.equal(result.mount.mission_id, 'm-mount');
      assert.equal(result.mount.total, 2);
      assert.equal(result.mount.items.length, 2);
      assert.equal(result.mount.items[0].canonical_text, 'mount 2');
      assert.ok(result.mount.items.every((item) => item.mission_id === 'm-mount'));
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  test('falls back to process.cwd() and honours an explicit data_file', async () => {
    const projectRoot = makeProjectRoot();
    try {
      const dataFile = join(projectRoot, 'custom', 'mount.sqlite');
      await memoryItemManage(
        { mission_id: 'm-mount', canonical_text: 'cwd mount item', data_file: dataFile },
        {},
      );

      const result = await memoryMount({ mission_id: 'm-mount', data_file: dataFile }, {});
      assert.equal(result.ok, true);
      assert.equal(result.mount.total, 1);
      assert.equal(result.mount.items[0].canonical_text, 'cwd mount item');
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });
});
