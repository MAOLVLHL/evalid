import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  checkPairing,
  createAgentEventSink,
  createLineSplitter,
  normalizeAgentEvent,
  normalizeAgentEvents,
} from '../src/core/agent-stream.js';
import { readExecutionLog } from '../src/core/execution-log.js';

const FIXTURES = resolve(import.meta.dirname, 'fixtures', 'agent-stream');
const codexFixture = readFileSync(join(FIXTURES, 'codex.ndjson'), 'utf8');
const claudeFixture = readFileSync(join(FIXTURES, 'claude.ndjson'), 'utf8');
const claudeErrorKilledFixture = readFileSync(join(FIXTURES, 'claude-error-killed.ndjson'), 'utf8');
const codexKilledFixture = readFileSync(join(FIXTURES, 'codex-killed.ndjson'), 'utf8');
// M14 slice 2 (#187): verbatim recordings from real codex runs (gocc, 2026-11-12).
const codexRealNormalLsFixture = readFileSync(join(FIXTURES, 'codex-real-normal-ls.ndjson'), 'utf8');
const codexRealKilledSleepFixture = readFileSync(join(FIXTURES, 'codex-real-killed-sleep.ndjson'), 'utf8');
const codexRealNormalReadFixture = readFileSync(join(FIXTURES, 'codex-real-normal-read.ndjson'), 'utf8');

function makeProjectRoot() {
  const root = mkdtempSync(join(tmpdir(), 'openflow-agent-stream-'));
  mkdirSync(resolve(root, '.as-xflow'), { recursive: true });
  return root;
}

function linesOf(fixture) {
  return fixture.trim().split('\n');
}

function collect(fixture, adapter, options = {}) {
  const events = [];
  for (const line of linesOf(fixture)) {
    events.push(...normalizeAgentEvents(line, { adapter, seq: events.length, ...options }));
  }
  return events;
}

/** Terminal state of every id-bearing call in a replayed log, or null when a call has none. */
function terminalStates(events) {
  const states = new Map();
  for (const event of events) {
    if (!event.tool_call_id) continue;
    if (event.event === 'tool_start') states.set(event.tool_call_id, { tool: event.tool, status: 'running' });
    if (event.event === 'tool_end') states.set(event.tool_call_id, { tool: event.tool, status: event.status });
  }
  return states;
}

/** Every id-bearing tool_start has exactly one tool_end with the same id. */
function assertPaired(events) {
  const starts = new Map();
  const ends = new Map();
  for (const event of events) {
    if (!event.tool_call_id) continue;
    if (event.event === 'tool_start') starts.set(event.tool_call_id, (starts.get(event.tool_call_id) || 0) + 1);
    if (event.event === 'tool_end') ends.set(event.tool_call_id, (ends.get(event.tool_call_id) || 0) + 1);
  }
  assert.deepEqual([...ends.entries()].sort(), [...starts.entries()].sort(), 'every tool_start has exactly one tool_end');
}

/** Push a whole fixture through a sink, close it, and return the sink, stats and log events. */
async function replayFixture(projectRoot, fixture, adapter, options = {}) {
  const sink = createAgentEventSink({ projectRoot, adapter, flushIntervalMs: 5, ...options });
  sink.push(fixture);
  const stats = await sink.close();
  const log = await readExecutionLog(projectRoot, { limit: 50 });
  assert.equal(log.chain.ok, true);
  const events = log.entries.filter((entry) => entry.kind === 'agent_event').reverse();
  return { sink, stats, events };
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
      const events = collect(claudeFixture, 'claude_cli', { toolNames: new Map() });
      assert.deepEqual(events.map((event) => event.event), [
        'agent_start',
        'message_end',
        'tool_start',
        'tool_end',
        'tool_start',
        'tool_end',
        'agent_end',
      ]);
      assert.equal(events[1].text, 'Reading the phase artifact template.');
      assert.equal(events[2].tool, 'Read');
      assert.equal(events[2].args_digest.length, 16);
      assert.equal(events[6].cost_usd, 0.0412);
      assert.equal(events[6].duration_ms, 184000);
      assert.deepEqual(events[6].usage, { input: 900, output: 210, cache_read: 400 });
    });

    test('pairs every claude tool_result back to the tool_use that started it', () => {
      const events = collect(claudeFixture, 'claude_cli', { toolNames: new Map() });
      const starts = events.filter((event) => event.event === 'tool_start');
      const ends = events.filter((event) => event.event === 'tool_end');
      assert.deepEqual(starts.map((event) => event.tool_call_id), ['toolu_1', 'toolu_2']);
      assert.deepEqual(ends.map((event) => event.tool_call_id), ['toolu_1', 'toolu_2']);
      assert.deepEqual(ends.map((event) => event.tool), ['Read', 'Write']);
      assert.deepEqual(ends.map((event) => event.status), ['completed', 'completed']);
    });

    test('marks a failed claude tool_result as an error end', () => {
      const toolUse = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_9","name":"Bash","input":{"command":"npm test"}}]}}';
      const failed = '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_9","is_error":true,"content":"exit 1"}]}}';
      const events = collect(toolUse + '\n' + failed, 'claude_cli', { toolNames: new Map() });
      assert.deepEqual(events.map((event) => event.event), ['tool_start', 'tool_end']);
      assert.equal(events[1].tool, 'Bash');
      assert.equal(events[1].tool_call_id, 'toolu_9');
      assert.equal(events[1].status, 'error');
    });

    test('keeps a claude tool_end readable when the matching tool_use was never seen', () => {
      const orphan = '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_ghost","content":"ok"}]}}';
      const events = collect(orphan, 'claude_cli', { toolNames: new Map() });
      assert.equal(events.length, 1);
      assert.equal(events[0].event, 'tool_end');
      assert.equal(events[0].tool, null);
      assert.equal(events[0].tool_call_id, 'toolu_ghost');
      assert.equal(events[0].status, 'completed');
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

  describe('checkPairing', () => {
    const start = (id, seq) => ({ seq, event: 'tool_start', tool: 'Bash', tool_call_id: id });
    const end = (id, seq) => ({ seq, event: 'tool_end', tool: 'Bash', tool_call_id: id });

    test('a clean claude run has no violations', () => {
      assert.deepEqual(checkPairing(collect(claudeFixture, 'claude_cli', { toolNames: new Map() })), []);
    });

    test('flags a tool_end whose tool_use was never seen', () => {
      assert.deepEqual(checkPairing([end('toolu_ghost', 1)]), [
        { kind: 'unpaired_tool_end', tool_call_id: 'toolu_ghost', seq: 1 },
      ]);
    });

    test('flags a second tool_end for an already closed call', () => {
      assert.deepEqual(checkPairing([start('toolu_1', 1), end('toolu_1', 2), end('toolu_1', 3)]), [
        { kind: 'duplicate_tool_end', tool_call_id: 'toolu_1', seq: 3 },
      ]);
    });

    test('flags a second tool_start while the first is still open', () => {
      assert.deepEqual(checkPairing([start('toolu_1', 1), start('toolu_1', 2)]), [
        { kind: 'duplicate_tool_start', tool_call_id: 'toolu_1', seq: 2 },
      ]);
    });

    test('flags an id reused after its call already closed', () => {
      assert.deepEqual(checkPairing([start('toolu_1', 1), end('toolu_1', 2), start('toolu_1', 3)]), [
        { kind: 'reused_tool_call_id', tool_call_id: 'toolu_1', seq: 3 },
      ]);
    });

    test('flags every call still open when agent_end arrives', () => {
      assert.deepEqual(checkPairing([start('toolu_1', 1), start('toolu_2', 2), { seq: 3, event: 'agent_end' }]), [
        { kind: 'unpaired_at_agent_end', tool_call_id: 'toolu_1', seq: 3 },
        { kind: 'unpaired_at_agent_end', tool_call_id: 'toolu_2', seq: 3 },
      ]);
    });

    test('ignores calls without an id: nothing to pair them to', () => {
      assert.deepEqual(checkPairing([
        { seq: 1, event: 'tool_start', tool: 'Bash', tool_call_id: null },
        { seq: 2, event: 'tool_end', tool: 'Bash', tool_call_id: null },
      ]), []);
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

    test('closes a call that is still open when the agent is killed', async () => {
      const projectRoot = makeProjectRoot();
      try {
        const sink = createAgentEventSink({
          projectRoot,
          adapter: 'claude_cli',
          flushIntervalMs: 5,
          agentRunId: 'agent_run_test',
        });
        const toolUse = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_7', name: 'Bash', input: { command: 'sleep 999' } }] } };
        sink.push(`${JSON.stringify(toolUse)}\n`);
        const stats = await sink.close();
        assert.equal(stats.events, 2, 'the abandoned end counts as an event');

        const log = await readExecutionLog(projectRoot, { limit: 10 });
        assert.equal(log.chain.ok, true);
        const events = log.entries.filter((entry) => entry.kind === 'agent_event').reverse();
        assert.deepEqual(events.map((entry) => entry.event), ['tool_start', 'tool_end']);
        assert.equal(events[1].status, 'abandoned');
        assert.equal(events[1].tool, 'Bash');
        assert.equal(events[1].tool_call_id, 'toolu_7');
        assert.ok(events.every((entry) => entry.agent_run_id === 'agent_run_test'));
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test('pairs a claude error + killed run end to end, including concurrent calls', async () => {
      const projectRoot = makeProjectRoot();
      try {
        const { sink, stats, events } = await replayFixture(projectRoot, claudeErrorKilledFixture, 'claude_cli', { agentRunId: 'agent_run_test' });
        assert.equal(stats.pairing_violations, 0, 'clean replay must not raise a violation');
        assert.deepEqual(sink.pairingViolations, []);
        assert.equal(stats.events, 10, '9 normalized events + 1 abandoned end');
        assert.equal(stats.written, 10);
        assertPaired(events);
        assert.deepEqual(events.map((entry) => entry.event), [
          'agent_start', 'message_end',
          'tool_start', 'tool_end',
          'tool_start', 'tool_start', 'tool_end', 'tool_end',
          'tool_start', 'tool_end',
        ]);
        // Error result maps to an error end.
        assert.equal(events[3].tool_call_id, 'toolu_10');
        assert.equal(events[3].status, 'error');
        // Concurrent calls pair even when their results arrive out of order.
        assert.deepEqual(events.slice(4, 8).map((entry) => entry.tool_call_id), ['toolu_11', 'toolu_12', 'toolu_12', 'toolu_11']);
        // The killed call is closed by close(), not left running.
        assert.equal(events[9].tool_call_id, 'toolu_13');
        assert.equal(events[9].status, 'abandoned');
        assert.equal(events[9].agent_run_id, 'agent_run_test');
        assert.ok(events.every((entry) => entry.agent_run_id === 'agent_run_test'));
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test('pairs a killed codex run: the open command is abandoned on close', async () => {
      const projectRoot = makeProjectRoot();
      try {
        const { sink, stats, events } = await replayFixture(projectRoot, codexKilledFixture, 'codex_cli', { agentRunId: 'agent_run_test' });
        assert.equal(stats.pairing_violations, 0);
        assert.deepEqual(sink.pairingViolations, []);
        assert.equal(stats.events, 3, 'agent_start + tool_start + abandoned end');
        assertPaired(events);
        assert.deepEqual(events.map((entry) => entry.event), ['agent_start', 'tool_start', 'tool_end']);
        assert.equal(events[1].tool, 'shell');
        assert.equal(events[1].tool_call_id, 'item_1');
        assert.equal(events[2].status, 'abandoned');
        assert.equal(events[2].tool_call_id, 'item_1');
        assert.equal(events[2].agent_run_id, 'agent_run_test');
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test('surfaces an orphan tool_end as a violation without dropping it', async () => {
      const projectRoot = makeProjectRoot();
      try {
        const orphan = '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_ghost","content":"ok"}]}}\n';
        const { sink, stats, events } = await replayFixture(projectRoot, orphan, 'claude_cli', { agentRunId: 'agent_run_test' });
        assert.equal(stats.pairing_violations, 1);
        assert.deepEqual(sink.pairingViolations, [
          { kind: 'unpaired_tool_end', tool_call_id: 'toolu_ghost', seq: 1, agent_run_id: 'agent_run_test' },
        ]);
        assert.equal(stats.events, 2, 'the tool_end plus its violation flag');
        // The orphan end stays readable in the log; the violation is a flag on it, not a drop.
        assert.equal(events[0].event, 'tool_end');
        assert.equal(events[0].tool_call_id, 'toolu_ghost');
        assert.equal(events[1].event, 'raw');
        assert.equal(events[1].reason, 'pairing_violation');
        assert.equal(events[1].violation, 'unpaired_tool_end');
        assert.equal(events[1].tool_call_id, 'toolu_ghost');
        assert.match(events[1].text, /unpaired_tool_end/);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test('surfaces a duplicate tool_end as a violation without dropping either end', async () => {
      const projectRoot = makeProjectRoot();
      try {
        const toolUse = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_5","name":"Bash","input":{"command":"ls"}}]}}\n';
        const result = '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_5","content":"ok"}]}}\n';
        const { sink, stats, events } = await replayFixture(projectRoot, toolUse + result + result, 'claude_cli', { agentRunId: 'agent_run_test' });
        assert.equal(stats.pairing_violations, 1);
        assert.deepEqual(sink.pairingViolations, [
          { kind: 'duplicate_tool_end', tool_call_id: 'toolu_5', seq: 3, agent_run_id: 'agent_run_test' },
        ]);
        assert.equal(events.filter((entry) => entry.event === 'tool_end').length, 2, 'both ends stay in the log');
        assert.equal(events.filter((entry) => entry.reason === 'pairing_violation').length, 1);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test('flags a call still open at agent_end, then abandons it on close', async () => {
      const projectRoot = makeProjectRoot();
      try {
        const stream = [
          '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_20","name":"Bash","input":{"command":"sleep 999"}}]}}',
          '{"type":"result","subtype":"success","is_error":false,"duration_ms":1000,"total_cost_usd":0.001,"usage":{"input_tokens":10,"output_tokens":5}}',
        ].join('\n') + '\n';
        const { sink, stats, events } = await replayFixture(projectRoot, stream, 'claude_cli', { agentRunId: 'agent_run_test' });
        assert.equal(stats.pairing_violations, 1);
        assert.deepEqual(sink.pairingViolations, [
          { kind: 'unpaired_at_agent_end', tool_call_id: 'toolu_20', seq: 2, agent_run_id: 'agent_run_test' },
        ]);
        assertPaired(events);
        assert.deepEqual(events.map((entry) => entry.event), ['tool_start', 'agent_end', 'raw', 'tool_end']);
        assert.equal(events[2].violation, 'unpaired_at_agent_end');
        assert.equal(events[3].status, 'abandoned');
        assert.equal(events[3].tool_call_id, 'toolu_20');
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test('scopes concurrent agent runs so their tool-call ids cannot collide', async () => {
      const projectRoot = makeProjectRoot();
      try {
        const start = (sink, command) => sink.push(`${JSON.stringify({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command } })}\n`);
        const first = createAgentEventSink({ projectRoot, adapter: 'codex_cli', flushIntervalMs: 5, agentRunId: 'agent_run_a' });
        const second = createAgentEventSink({ projectRoot, adapter: 'codex_cli', flushIntervalMs: 5, agentRunId: 'agent_run_b' });
        start(first, 'npm test');
        start(second, 'npm run build');
        await first.close();
        await second.close();

        const log = await readExecutionLog(projectRoot, { limit: 20 });
        assert.equal(log.chain.ok, true);
        const events = log.entries.filter((entry) => entry.kind === 'agent_event');
        const perRun = new Map();
        for (const entry of events) perRun.set(entry.agent_run_id, (perRun.get(entry.agent_run_id) || 0) + 1);
        assert.deepEqual([...perRun.keys()].sort(), ['agent_run_a', 'agent_run_b']);
        assert.deepEqual([...perRun.values()], [2, 2]);
        assert.ok(events.every((entry) => entry.tool_call_id === 'item_1'));
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test('replays the same claude ids through two runs without cross-talk or violations', async () => {
      const projectRoot = makeProjectRoot();
      try {
        const first = createAgentEventSink({ projectRoot, adapter: 'claude_cli', flushIntervalMs: 5, agentRunId: 'agent_run_a' });
        const second = createAgentEventSink({ projectRoot, adapter: 'claude_cli', flushIntervalMs: 5, agentRunId: 'agent_run_b' });
        first.push(claudeFixture);
        second.push(claudeFixture);
        const firstStats = await first.close();
        const secondStats = await second.close();

        assert.equal(firstStats.pairing_violations, 0);
        assert.equal(secondStats.pairing_violations, 0);
        assert.deepEqual(first.pairingViolations, []);
        assert.deepEqual(second.pairingViolations, []);

        const log = await readExecutionLog(projectRoot, { limit: 30 });
        assert.equal(log.chain.ok, true);
        const events = log.entries.filter((entry) => entry.kind === 'agent_event');
        for (const runId of ['agent_run_a', 'agent_run_b']) {
          const perRun = events.filter((entry) => entry.agent_run_id === runId);
          assert.equal(perRun.length, 7, `${runId} keeps its own 7 events`);
          assertPaired(perRun);
        }
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });

  // M14 slice 2 (#187): verbatim recordings from real codex runs (gocc, 2026-11-12,
  // codex-cli 0.166.0, ChatGPT login). The claude half is still open: no logged-in claude
  // CLI is reachable from this worker (SSH or GUI-bridge context both report "Not logged
  // in"), so no claude fixture here claims to be a real recording.
  describe('real recorded codex streams', () => {
    const realRuns = [
      { name: 'codex-real-normal-ls', fixture: codexRealNormalLsFixture, calls: 2, killed: false },
      { name: 'codex-real-normal-read', fixture: codexRealNormalReadFixture, calls: 1, killed: false },
      { name: 'codex-real-killed-sleep', fixture: codexRealKilledSleepFixture, calls: 1, killed: true },
    ];

    test('replays three real codex runs with zero pairing violations', async () => {
      for (const run of realRuns) {
        const events = collect(run.fixture, 'codex_cli');
        assert.deepEqual(checkPairing(events), [], `${run.name}: clean replay`);
        const projectRoot = makeProjectRoot();
        try {
          const { sink, stats, events: logged } = await replayFixture(projectRoot, run.fixture, 'codex_cli', { agentRunId: 'agent_run_test' });
          assert.equal(stats.pairing_violations, 0, `${run.name}: no sink violations`);
          assert.deepEqual(sink.pairingViolations, []);
          assertPaired(logged);
          assert.equal(
            logged.filter((entry) => entry.event === 'tool_start').length,
            run.calls,
            `${run.name}: tool call count`,
          );
        } finally {
          rmSync(projectRoot, { recursive: true, force: true });
        }
      }
    });

    test('the killed real run closes its open call as abandoned', async () => {
      const projectRoot = makeProjectRoot();
      try {
        const { stats, events } = await replayFixture(projectRoot, codexRealKilledSleepFixture, 'codex_cli', { agentRunId: 'agent_run_test' });
        assert.equal(stats.pairing_violations, 0);
        assert.equal(stats.events, 4, 'agent_start + message_end + tool_start + abandoned end');
        assert.deepEqual(events.map((entry) => entry.event), ['agent_start', 'message_end', 'tool_start', 'tool_end']);
        assert.equal(events[2].tool, 'shell');
        assert.equal(events[2].tool_call_id, 'item_1');
        assert.equal(events[3].status, 'abandoned');
        assert.equal(events[3].tool_call_id, 'item_1');
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test('acceptance 2: after replay + close, every call shows a terminal state', async () => {
      for (const run of realRuns) {
        const projectRoot = makeProjectRoot();
        try {
          const { events } = await replayFixture(projectRoot, run.fixture, 'codex_cli', { agentRunId: 'agent_run_test' });
          const states = terminalStates(events);
          assert.equal(states.size, run.calls, `${run.name}: one terminal row per call`);
          for (const [callId, state] of states) {
            assert.ok(
              ['completed', 'error', 'abandoned'].includes(state.status),
              `${run.name}: ${callId} left ${state.status}, not terminal`,
            );
          }
          if (run.killed) {
            assert.equal([...states.values()][0].status, 'abandoned');
          } else {
            assert.ok([...states.values()].every((state) => state.status === 'completed'));
            assert.ok(events.some((entry) => entry.event === 'agent_end'), `${run.name}: agent_end present`);
          }
        } finally {
          rmSync(projectRoot, { recursive: true, force: true });
        }
      }
    });
  });
});
