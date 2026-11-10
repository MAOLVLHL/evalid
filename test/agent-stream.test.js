import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createAgentEventSink,
  createLineSplitter,
  normalizeAgentEvent,
  normalizeAgentEvents,
} from '../src/core/agent-stream.js';
import { readExecutionLog } from '../src/core/execution-log.js';

const FIXTURES = resolve(import.meta.dirname, 'fixtures', 'agent-stream');
const codexFixture = readFileSync(join(FIXTURES, 'codex.ndjson'), 'utf8');
const claudeFixture = readFileSync(join(FIXTURES, 'claude.ndjson'), 'utf8');

function makeProjectRoot() {
  const root = mkdtempSync(join(tmpdir(), 'openflow-agent-stream-'));
  mkdirSync(resolve(root, '.as-xflow'), { recursive: true });
  return root;
}

function linesOf(fixture) {
  return fixture.trim().split('\n');
}

function collect(fixture, adapter) {
  const events = [];
  for (const line of linesOf(fixture)) {
    events.push(...normalizeAgentEvents(line, { adapter, seq: events.length }));
  }
  return events;
}

describe('Agent stream', () => {
  describe('createLineSplitter', () => {
    test('reassembles a line whose chunk boundary falls inside it', () => {
      const lines = [];
      const splitter = createLineSplitter((line) => lines.push(line));
      splitter.push('{"type":"thread.sta');
      splitter.push('rted"}\n{"type":"turn.completed"}\n');
      assert.deepEqual(lines, ['{"type":"thread.started"}', '{"type":"turn.completed"}']);
    });

    test('flush emits a trailing line that never received a newline', () => {
      const lines = [];
      const splitter = createLineSplitter((line) => lines.push(line));
      splitter.push('{"type":"turn.completed"}');
      assert.equal(lines.length, 0);
      assert.equal(splitter.pending, 25);
      splitter.flush();
      assert.deepEqual(lines, ['{"type":"turn.completed"}']);
    });

    test('strips a trailing carriage return so JSON.parse still succeeds', () => {
      const lines = [];
      const splitter = createLineSplitter((line) => lines.push(line));
      splitter.push('{"type":"thread.started"}\r\n');
      assert.deepEqual(lines, ['{"type":"thread.started"}']);
    });

    test('replaces an oversized line with one marker and recovers at the next newline', () => {
      const lines = [];
      const splitter = createLineSplitter((line) => lines.push(line), { maxLineBytes: 1024 });
      splitter.push('x'.repeat(4000));
      splitter.push('\n{"type":"thread.started"}\n');
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[0]).type, 'xflow.line_truncated');
      assert.equal(JSON.parse(lines[0]).bytes, 4000);
      assert.equal(lines[1], '{"type":"thread.started"}');
    });

    test('truncates an oversized line that arrives together with its newline', () => {
      const lines = [];
      const splitter = createLineSplitter((line) => lines.push(line), { maxLineBytes: 1024 });
      splitter.push(`${'y'.repeat(4000)}\n`);
      assert.equal(lines.length, 1);
      assert.equal(JSON.parse(lines[0]).type, 'xflow.line_truncated');
    });

    test('keeps memory bounded when the stream never sends a newline', () => {
      const lines = [];
      const splitter = createLineSplitter((line) => lines.push(line), { maxLineBytes: 1024 });
      for (let index = 0; index < 200; index += 1) splitter.push('z'.repeat(4096));
      assert.equal(lines.length, 1, 'one marker per runaway line, not one per chunk');
      assert.equal(JSON.parse(lines[0]).type, 'xflow.line_truncated');
      assert.ok(splitter.pending <= 1024, `pending grew to ${splitter.pending} characters`);

      splitter.push('\n{"type":"thread.started"}\n');
      assert.equal(lines.at(-1), '{"type":"thread.started"}');
      assert.equal(splitter.pending, 0);
    });
  });

  describe('normalizeAgentEvents', () => {
    test('maps a codex --json run onto the event vocabulary', () => {
      const events = collect(codexFixture, 'codex_cli');
      assert.deepEqual(events.map((event) => event.event), [
        'agent_start',
        'tool_start',
        'tool_end',
        'message_end',
        'agent_end',
      ]);
      assert.equal(events[1].tool, 'shell');
      assert.equal(events[1].args_preview, 'npm test');
      assert.equal(events[1].args_digest.length, 16);
      assert.equal(events[2].exit_code, 0);
      assert.equal(events[3].text, 'Tests pass; writing the artifact now.');
      assert.deepEqual(events[4].usage, { input: 1200, output: 340, cache_read: 800 });
    });

    test('maps a claude stream-json run onto the event vocabulary', () => {
      const events = collect(claudeFixture, 'claude_cli');
      assert.deepEqual(events.map((event) => event.event), [
        'agent_start',
        'message_end',
        'tool_start',
        'tool_start',
        'agent_end',
      ]);
      assert.equal(events[1].text, 'Reading the phase artifact template.');
      assert.equal(events[2].tool, 'Read');
      assert.equal(events[2].args_digest.length, 16);
      assert.equal(events[4].cost_usd, 0.0412);
      assert.equal(events[4].duration_ms, 184000);
      assert.deepEqual(events[4].usage, { input: 900, output: 210, cache_read: 400 });
    });

    test('degrades unknown and malformed lines to raw events instead of throwing', () => {
      assert.equal(normalizeAgentEvent('{"type":"some_future_event"}', { adapter: 'codex_cli' }), null);
      const invalid = normalizeAgentEvent('not json at all', { adapter: 'codex_cli' });
      assert.equal(invalid.event, 'raw');
      assert.equal(invalid.reason, 'invalid_json');
      const failed = normalizeAgentEvent('{"type":"turn.failed","message":"model overloaded"}', { adapter: 'codex_cli' });
      assert.equal(failed.event, 'raw');
      assert.equal(failed.level, 'error');
      assert.match(failed.text, /model overloaded/);
    });
  });

  describe('createAgentEventSink', () => {
    test('batches CLI output into hash-chained execution log entries', async () => {
      const projectRoot = makeProjectRoot();
      try {
        const sink = createAgentEventSink({
          projectRoot,
          changeId: 'chg-stream',
          missionId: 'mis-1',
          phase: 'implement',
          atom: 'I3.agent.execute',
          adapter: 'codex_cli',
          flushIntervalMs: 5,
        });
        // Split at deliberately awkward byte offsets so the splitter has to reassemble lines.
        sink.push(codexFixture.slice(0, 37));
        sink.push(codexFixture.slice(37, 411));
        sink.push(codexFixture.slice(411));
        const stats = await sink.close();

        assert.equal(stats.events, 5);
        assert.equal(stats.written, 5);
        assert.equal(stats.write_errors, 0);

        const log = await readExecutionLog(projectRoot, { limit: 20 });
        assert.equal(log.chain.ok, true);
        const events = log.entries.filter((entry) => entry.kind === 'agent_event').reverse();
        assert.deepEqual(events.map((entry) => entry.event), [
          'agent_start',
          'tool_start',
          'tool_end',
          'message_end',
          'agent_end',
        ]);
        assert.equal(events[0].change_id, 'chg-stream');
        assert.equal(events[0].mission_id, 'mis-1');
        assert.equal(events[0].phase, 'implement');
        assert.equal(events[0].atom, 'I3.agent.execute');
        assert.deepEqual(events.map((entry) => entry.seq), [1, 2, 3, 4, 5]);
        assert.ok(events.every((entry) => entry.entry_hash));
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test('truncates oversized text and keeps the log bounded', async () => {
      const projectRoot = makeProjectRoot();
      try {
        const sink = createAgentEventSink({ projectRoot, adapter: 'claude_cli', flushIntervalMs: 5 });
        sink.push(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'z'.repeat(3000) }] } })}\n`);
        await sink.close();

        const log = await readExecutionLog(projectRoot, { limit: 5 });
        const event = log.entries.find((entry) => entry.kind === 'agent_event');
        assert.equal(event.text.length, 2049);
        assert.ok(event.text.endsWith('…'));
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test('drops the oldest queued events when the agent floods faster than the flush window', async () => {
      const projectRoot = makeProjectRoot();
      try {
        const sink = createAgentEventSink({ projectRoot, adapter: 'codex_cli', flushIntervalMs: 60_000, maxQueue: 2 });
        for (let index = 0; index < 4; index += 1) {
          sink.push(`${JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: `step-${index}` } })}\n`);
        }
        assert.equal(sink.pending, 2);
        assert.equal(sink.stats.dropped, 2);
        await sink.flush();
        await sink.close();

        const log = await readExecutionLog(projectRoot, { limit: 10 });
        const events = log.entries.filter((entry) => entry.kind === 'agent_event').reverse();
        assert.deepEqual(events.map((entry) => entry.args_preview), ['step-2', 'step-3']);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });
});
