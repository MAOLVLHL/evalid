#!/usr/bin/env node
/**
 * demo-agent-stream.mjs — proves the agent progress path end to end.
 *
 * Feeds synthetic codex events through `createAgentEventSink` (the same sink
 * `agent_invoke` uses), then prints each one as `xflow serve` delivers it over
 * /api/events, together with the observed latency. No agent CLI is required.
 *
 *   node scripts/demo-agent-stream.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import startServer from '../src/server.js';
import { createAgentEventSink } from '../src/core/agent-stream.js';

const PUSH_INTERVAL_MS = 200;
const FIXTURE = [
  '{"type":"thread.started","thread_id":"thread_demo"}',
  '{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"npm test"}}',
  '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"npm test","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"Tests pass; writing the artifact."}}',
  '{"type":"turn.completed","usage":{"input_tokens":1200,"output_tokens":340}}',
];

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function labelOf(entry) {
  if (entry.event === 'agent_start') return 'agent_start';
  if (entry.event === 'agent_end') return 'agent_end';
  if (entry.tool) return `${entry.event} ${entry.tool}`;
  return `${entry.event} ${String(entry.text || '').slice(0, 40)}`;
}

const projectRoot = mkdtempSync(join(tmpdir(), 'xflow-demo-stream-'));
const server = await startServer({ projectRoot, port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
const startedAt = Date.now();
const sentAt = new Map();

console.log(`[demo] project root: ${projectRoot}`);
console.log(`[demo] dashboard:    ${base}/`);
console.log(`[demo] pushing ${FIXTURE.length} synthetic codex events, one every ${PUSH_INTERVAL_MS}ms\n`);

const sink = createAgentEventSink({
  projectRoot,
  changeId: 'chg-demo-stream',
  missionId: 'mis-demo',
  phase: 'demo phase',
  atom: 'demo.atom',
  adapter: 'codex_cli',
});

const streamResponse = await fetch(`${base}/api/events`);
const reader = streamResponse.body.getReader();
const decoder = new TextDecoder();
const latencies = [];
let buffer = '';
let received = 0;

const pump = (async () => {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let frameEnd = buffer.indexOf('\n\n');
    while (frameEnd !== -1) {
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);
      frameEnd = buffer.indexOf('\n\n');
      // Frames carry an `id:` line first, so match the event name rather than the first line.
      if (!frame.includes('event: log')) continue;
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      if (!data) continue;
      const entry = JSON.parse(data.slice(6));
      const label = labelOf(entry);
      const elapsed = Date.now() - startedAt;
      const latency = sentAt.has(label) ? Date.now() - sentAt.get(label) : null;
      if (latency !== null) latencies.push(latency);
      received += 1;
      console.log(
        `[demo] +${String(elapsed).padStart(5)}ms  ${label.padEnd(26)} ` +
        `phase=${entry.phase} atom=${entry.atom} id=${String(entry.entry_hash).slice(0, 8)}…` +
        (latency === null ? '' : `  latency=${latency}ms`),
      );
    }
  }
})();

for (const line of FIXTURE) {
  const entry = JSON.parse(line);
  sentAt.set(labelOf({
    event: entry.type === 'thread.started' ? 'agent_start'
      : entry.type === 'turn.completed' ? 'agent_end'
        : entry.item?.type === 'command_execution' ? 'tool_start'
          : 'message_end',
    tool: entry.item?.type === 'command_execution' ? 'shell' : null,
    text: entry.item?.text,
  }), Date.now());
  sink.push(`${line}\n`);
  await sleep(PUSH_INTERVAL_MS);
}
await sink.close();
await sleep(500);
await reader.cancel();

const stats = sink.stats;
console.log(`\n[demo] events pushed: ${stats.events}, written: ${stats.written}, received over SSE: ${received}`);
if (latencies.length) {
  const min = Math.min(...latencies);
  const max = Math.max(...latencies);
  console.log(`[demo] end-to-end latency (push -> SSE): min ${min}ms, max ${max}ms over ${latencies.length} events`);
}
console.log('[demo] open the dashboard URL above while this script runs to watch the same stream live.');

await pump.catch(() => {});
await new Promise((resolveClose) => server.close(resolveClose));
rmSync(projectRoot, { recursive: true, force: true });
