/**
 * agent-stream — turns coding-agent CLI output into execution-log events.
 *
 * `agent_invoke` spawns codex/claude with line-delimited JSON (--json / --output-format
 * stream-json). That output used to be buffered into a string and thrown away, which left a
 * 5-to-30-minute black box in the middle of every heavy phase. Here the same bytes are split
 * into lines, normalized to a small event vocabulary, and appended to the hash-chained
 * execution log, which both the CLI and `xflow serve` already read.
 *
 * Vocabulary (deliberately tiny, and aligned with bench/swebench/harness/arms.py):
 *   agent_start | tool_start | tool_end | message_end | agent_end | raw
 *
 * Unknown line shapes degrade to `raw` instead of throwing: a CLI version bump must never be
 * able to break a workflow run.
 *
 * Pairing invariant (M14 slice 1, #185): inside one `agent_run_id` scope, every id-bearing
 * `tool_start` must be followed by exactly one `tool_end` with the same `tool_call_id` before
 * `agent_end`. The sink enforces it while the stream flows: a breach is counted in
 * `stats.pairing_violations`, listed on `sink.pairingViolations`, and written to the execution
 * log as a `raw` record (`reason: 'pairing_violation'`) — never silently dropped, and never
 * fatal to the run. The offending event itself is still recorded. `checkPairing(events)` is the
 * same state machine as a pure function over already-normalized events, for replay checks.
 */
import { createHash, randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { appendExecutionLog } from './execution-log.js';

export const AGENT_EVENT_KINDS = Object.freeze(['agent_start', 'tool_start', 'tool_end', 'message_end', 'agent_end', 'raw']);
export const DEFAULT_MAX_LINE_BYTES = 1 << 20;
export const DEFAULT_FLUSH_INTERVAL_MS = 200;
const MAX_TEXT_CHARS = 2048;
const MAX_PREVIEW_CHARS = 160;
const MAX_QUEUE_LENGTH = 500;
// While a line is being dropped, only this much of it is kept: enough to see the newline that
// ends it, never enough to matter.
const DROP_TAIL_CHARS = 1024;

/**
 * Split a byte stream into complete lines.
 *
 * `push` accepts Buffers or strings and never emits a partial line; `flush` emits the trailing
 * line before the process goes away. A line larger than `maxLineBytes` is replaced by a single
 * truncation marker so a runaway output cannot grow memory without bound.
 */
export function createLineSplitter(onLine, options = {}) {
  const maxLineBytes = Math.max(1024, Number(options.maxLineBytes) || DEFAULT_MAX_LINE_BYTES);
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let dropping = false;

  const emit = (line) => {
    const value = line.endsWith('\r') ? line.slice(0, -1) : line;
    try {
      onLine(value);
    } catch {
      // A consumer bug must never break the agent pipe.
    }
  };

  const drain = () => {
    let newlineAt = buffer.indexOf('\n');
    while (newlineAt !== -1) {
      const line = buffer.slice(0, newlineAt);
      buffer = buffer.slice(newlineAt + 1);
      if (dropping) {
        dropping = false;
      } else if (line.length > maxLineBytes) {
        emit(JSON.stringify({ type: 'xflow.line_truncated', bytes: line.length }));
      } else {
        emit(line);
      }
      newlineAt = buffer.indexOf('\n');
    }
  };

  return {
    push(chunk) {
      if (chunk === undefined || chunk === null) return;
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      drain();
      if (buffer.length > maxLineBytes) {
        if (!dropping) {
          emit(JSON.stringify({ type: 'xflow.line_truncated', bytes: buffer.length }));
          dropping = true;
        }
        // The runaway line was already replaced by its marker, so only its tail is kept: without
        // this a stream that never sends a newline grew the buffer without bound.
        buffer = buffer.slice(-DROP_TAIL_CHARS);
      }
    },
    flush() {
      const tail = decoder.end();
      if (tail) buffer += tail;
      drain();
      if (dropping) {
        buffer = '';
        dropping = false;
      }
      if (buffer.length) {
        const line = buffer;
        buffer = '';
        emit(line);
      }
    },
    get pending() {
      return buffer.length;
    },
  };
}

/** First normalized event for a line, or null. Kept for one-line CLIs and simple callers. */
export function normalizeAgentEvent(raw, options = {}) {
  const events = normalizeAgentEvents(raw, options);
  return events.length ? events[0] : null;
}

/** Every normalized event carried by one CLI line (a Claude message can hold text and tool calls). */
export function normalizeAgentEvents(raw, options = {}) {
  const adapter = options.adapter || 'unknown';
  const seq = Number(options.seq) || 0;
  const text = String(raw ?? '').trim();
  if (!text) return [];

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return [{ seq, event: 'raw', reason: 'invalid_json', text: truncateText(text) }];
  }
  if (!payload || typeof payload !== 'object') {
    return [{ seq, event: 'raw', reason: 'non_object_payload', text: truncateText(text) }];
  }
  if (payload.type === 'xflow.line_truncated') {
    return [{ seq, event: 'raw', reason: 'line_truncated', truncated: true, text: String(payload.bytes || 0) }];
  }

  const family = detectFamily(payload, adapter);
  const toolNames = options.toolNames instanceof Map ? options.toolNames : null;
  const mapped = (family === 'claude' ? mapClaudePayload : mapCodexPayload)(payload, { toolNames })
    .filter((event) => event && event.event);
  if (!mapped.length) return [];
  return mapped.map((event) => ({ seq, ...event }));
}

function detectFamily(payload, adapter) {
  if (adapter === 'claude_cli') return 'claude';
  if (adapter === 'codex_cli') return 'codex';
  const type = String(payload.type || '');
  if (['system', 'assistant', 'result', 'user', 'stream_event'].includes(type)) return 'claude';
  return 'codex';
}

function mapCodexPayload(payload) {
  const type = String(payload.type || '');
  switch (type) {
    case 'thread.started':
      return [{ event: 'agent_start', event_type: type }];
    case 'item.started':
      return mapCodexItem(payload.item, 'start');
    case 'item.completed':
      return mapCodexItem(payload.item, 'end');
    case 'turn.completed':
      return [{ event: 'agent_end', event_type: type, usage: readCodexUsage(payload.usage) }];
    case 'turn.failed':
    case 'error':
      return [{ event: 'raw', event_type: type, level: 'error', text: truncateText(errorText(payload)) }];
    default:
      return [];
  }
}

function mapCodexItem(item, phase) {
  if (!item || typeof item !== 'object') return [];
  const itemType = String(item.type || '');
  const callId = callIdOf(item.id);
  if (itemType === 'agent_message') {
    return phase === 'end' ? [{ event: 'message_end', event_type: itemType, text: truncateText(item.text) }] : [];
  }
  if (itemType === 'reasoning') {
    // Model reasoning is not progress a human can act on, and it is the largest payload.
    return [];
  }
  if (itemType === 'command_execution') {
    if (phase === 'start') {
      const command = Array.isArray(item.command) ? item.command.join(' ') : String(item.command || '');
      return [toolStart('shell', command, itemType, callId)];
    }
    return [toolEnd('shell', itemType, item.exit_code, item.status, callId)];
  }
  if (itemType === 'mcp_tool_call') {
    const tool = String(item.name || item.tool || 'mcp_tool');
    if (phase === 'start') return [toolStart(tool, stringifyArgs(item.arguments ?? item.input ?? item.args), itemType, callId)];
    return [toolEnd(tool, itemType, item.exit_code, item.status, callId)];
  }
  if (itemType === 'file_change') {
    const paths = Array.isArray(item.changes)
      ? item.changes.map((change) => change && change.path).filter(Boolean).join(', ')
      : String(item.path || '');
    if (phase === 'start') return [toolStart('file_change', paths, itemType, callId)];
    return [toolEnd('file_change', itemType, item.exit_code, item.status, callId)];
  }
  if (itemType === 'web_search') {
    return phase === 'start'
      ? [toolStart('web_search', String(item.query || ''), itemType, callId)]
      : [toolEnd('web_search', itemType, null, item.status, callId)];
  }
  return [];
}

function mapClaudePayload(payload, { toolNames } = {}) {
  const type = String(payload.type || '');
  if (type === 'system') {
    return payload.subtype === 'init' ? [{ event: 'agent_start', event_type: 'system:init' }] : [];
  }
  if (type === 'assistant') {
    const content = Array.isArray(payload.message?.content) ? payload.message.content : [];
    const events = [];
    let pendingText = [];
    const flushText = () => {
      if (!pendingText.length) return;
      events.push({ event: 'message_end', event_type: 'assistant_text', text: truncateText(pendingText.join('\n')) });
      pendingText = [];
    };
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        pendingText.push(block.text);
      } else if (block.type === 'tool_use') {
        // Preserve the order the model produced: text first, then the tool call it announced.
        flushText();
        const tool = String(block.name || 'tool');
        const callId = callIdOf(block.id);
        if (toolNames && callId) toolNames.set(callId, tool);
        events.push(toolStart(tool, stringifyArgs(block.input), 'tool_use', callId));
      }
    }
    flushText();
    return events;
  }
  if (type === 'user') {
    // Claude answers a tool call with a `tool_result` block that only carries `tool_use_id`, so the
    // tool name comes from the `tool_use` line seen earlier (the sink owns that map). Codex users
    // never reach this branch: its results arrive as `item.completed` instead.
    const content = Array.isArray(payload.message?.content) ? payload.message.content : [];
    const events = [];
    for (const block of content) {
      if (!block || block.type !== 'tool_result') continue;
      const callId = callIdOf(block.tool_use_id);
      const tool = callId && toolNames ? (toolNames.get(callId) ?? null) : null;
      events.push(toolEnd(tool, 'tool_result', null, block.is_error ? 'error' : 'completed', callId));
    }
    return events;
  }
  if (type === 'result') {
    return [{
      event: 'agent_end',
      event_type: 'result:' + String(payload.subtype || 'success'),
      usage: readClaudeUsage(payload.usage),
      cost_usd: finiteOrNull(payload.total_cost_usd),
      duration_ms: finiteOrNull(payload.duration_ms),
    }];
  }
  if (type === 'stream_event') {
    // Token-level deltas are out of scope; the finished message arrives as an assistant line.
    return [];
  }
  if (type === 'error') {
    return [{ event: 'raw', event_type: 'error', level: 'error', text: truncateText(errorText(payload)) }];
  }
  return [];
}

function toolStart(tool, argsText, eventType, callId = null) {
  const text = typeof argsText === 'string' ? argsText : '';
  return {
    event: 'tool_start',
    event_type: eventType,
    tool,
    tool_call_id: callId,
    args_preview: text ? truncateText(text, MAX_PREVIEW_CHARS) : null,
    args_digest: text ? digest(text) : null,
  };
}

function toolEnd(tool, eventType, exitCode, status, callId = null) {
  return {
    event: 'tool_end',
    event_type: eventType,
    tool,
    tool_call_id: callId,
    exit_code: finiteOrNull(exitCode),
    status: status ? String(status) : null,
  };
}

/** The CLI's own id for a tool call, or null when the payload has none. */
function callIdOf(value) {
  return typeof value === 'string' && value ? value : null;
}

function readCodexUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return compactUsage({
    input: usage.input_tokens,
    output: usage.output_tokens,
    cache_read: usage.cached_input_tokens,
    cache_write: usage.cache_creation_input_tokens,
  });
}

function readClaudeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return compactUsage({
    input: usage.input_tokens,
    output: usage.output_tokens,
    cache_read: usage.cache_read_input_tokens,
    cache_write: usage.cache_creation_input_tokens,
  });
}

function compactUsage(raw) {
  const usage = {};
  for (const [key, value] of Object.entries(raw)) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) usage[key] = number;
  }
  return Object.keys(usage).length ? usage : null;
}

export const PAIRING_VIOLATION_KINDS = Object.freeze([
  'unpaired_tool_end',
  'duplicate_tool_end',
  'duplicate_tool_start',
  'reused_tool_call_id',
  'unpaired_at_agent_end',
]);

/**
 * The pairing state machine: one instance per agent run (`agent_run_id` scope).
 *
 * `observe(event)` returns the violations that event commits (usually none). Rules, all scoped
 * to id-bearing calls only — without an id there is nothing to pair:
 * - `tool_start` for an id already open → `duplicate_tool_start`; for an id already closed →
 *   `reused_tool_call_id` (an id names one call inside a run; reuse makes the log ambiguous).
 * - `tool_end` for an id never started → `unpaired_tool_end`; for an id already closed →
 *   `duplicate_tool_end`.
 * - `agent_end` while calls are still open → one `unpaired_at_agent_end` per open call. The
 *   calls stay open: only the sink's `close()` may end them, as `abandoned`.
 * A violation is a fact about the stream, not a reason to stop it: the offending event is still
 * recorded, and the tracker keeps going so one breach cannot hide the next.
 */
function createPairingTracker() {
  const open = new Map();
  const closed = new Set();

  return {
    observe(event) {
      // agent_end carries no id of its own, so it must be checked before the id guard below.
      if (event?.event === 'agent_end') {
        return [...open.keys()].map((id) => ({ kind: 'unpaired_at_agent_end', tool_call_id: id }));
      }
      const callId = callIdOf(event?.tool_call_id);
      if (!callId) return [];
      if (event.event === 'tool_start') {
        if (open.has(callId)) {
          return [{ kind: 'duplicate_tool_start', tool_call_id: callId }];
        }
        if (closed.has(callId)) {
          closed.delete(callId);
          open.set(callId, { tool: event.tool ?? null, event_type: event.event_type ?? null });
          return [{ kind: 'reused_tool_call_id', tool_call_id: callId }];
        }
        open.set(callId, { tool: event.tool ?? null, event_type: event.event_type ?? null });
        return [];
      }
      if (event.event === 'tool_end') {
        if (open.has(callId)) {
          open.delete(callId);
          closed.add(callId);
          return [];
        }
        if (closed.has(callId)) return [{ kind: 'duplicate_tool_end', tool_call_id: callId }];
        return [{ kind: 'unpaired_tool_end', tool_call_id: callId }];
      }
      return [];
    },
    /** Calls still open, as [tool_call_id, {tool, event_type}] pairs; clears them as closed. */
    drainOpen() {
      const entries = [...open.entries()];
      for (const [callId] of entries) {
        open.delete(callId);
        closed.add(callId);
      }
      return entries;
    },
  };
}

/**
 * Pairing violations in an already-normalized event list, in stream order. Same state machine
 * the sink runs live; used by replay checks (M14 slice 2 replays recorded streams through it).
 * Each violation carries the offending event's `seq` when present.
 */
export function checkPairing(events) {
  const tracker = createPairingTracker();
  const violations = [];
  for (const event of events ?? []) {
    for (const violation of tracker.observe(event)) {
      violations.push({ ...violation, seq: event?.seq ?? null });
    }
  }
  return violations;
}

/**
 * Collect normalized events from one agent process and append them to the execution log.
 *
 * Writes are batched on a short timer so a chatty CLI produces kilobytes, not megabytes, and a
 * write failure is counted in `stats.write_errors` rather than surfaced to the agent run.
 */
export function createAgentEventSink(options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const changeId = options.changeId || null;
  const missionId = options.missionId || null;
  const phase = typeof options.phase === 'string' ? options.phase : (options.phase?.id || null);
  const atom = options.atom || null;
  const adapter = options.adapter || 'unknown';
  const flushIntervalMs = Math.max(0, Number(options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS));
  const maxQueue = Math.max(1, Number(options.maxQueue) || MAX_QUEUE_LENGTH);
  // One id per agent process, so two atoms streaming into the same log stay distinguishable even
  // when their CLIs reuse the same tool-call ids. Injectable so tests can pin it.
  const agentRunId = typeof options.agentRunId === 'string' && options.agentRunId
    ? options.agentRunId
    : `agent_run_${randomBytes(6).toString('hex')}`;

  const queue = [];
  const stats = { lines: 0, events: 0, written: 0, dropped: 0, truncated: 0, write_errors: 0, pairing_violations: 0 };
  const toolNames = new Map();
  // Pairing state for this run only: two sinks sharing one log never share a tracker, so a CLI
  // reusing ids across runs cannot produce a false violation in either.
  const pairing = createPairingTracker();
  const pairingViolations = [];
  let seq = 0;
  let timer = null;
  let writing = Promise.resolve();
  let closed = false;

  const splitter = createLineSplitter((line) => {
    if (closed || !line) return;
    stats.lines += 1;
    for (const normalized of normalizeAgentEvents(line, { adapter, seq, toolNames })) {
      seq += 1;
      stats.events += 1;
      if (normalized.truncated) stats.truncated += 1;
      enqueue(buildRecord(normalized, seq));
      for (const violation of pairing.observe(normalized)) {
        recordPairingViolation({ ...violation, seq });
      }
    }
    schedule();
  });

  function enqueue(record) {
    queue.push(record);
    if (queue.length > maxQueue) {
      queue.shift();
      stats.dropped += 1;
    }
  }

  /**
   * A pairing breach is surfaced three ways at once: counted in stats, listed for the caller,
   * and written to the execution log as a `raw` record so the cockpit / --progress views can
   * show it. The offending event was already enqueued above; this record is the flag on it.
   * `sink.close()` discards its stats return in agent-invoke, so the log record is the one
   * surface that always survives a real run.
   */
  function recordPairingViolation(violation) {
    stats.pairing_violations += 1;
    pairingViolations.push({ ...violation, agent_run_id: agentRunId });
    seq += 1;
    stats.events += 1;
    enqueue(buildRecord({
      event: 'raw',
      reason: 'pairing_violation',
      violation: violation.kind,
      tool_call_id: violation.tool_call_id,
      text: `pairing violation (${violation.kind}) for tool_call_id ${violation.tool_call_id}`,
    }, seq));
  }

  function buildRecord(event, eventSeq) {
    const record = {
      kind: 'agent_event',
      event: event.event,
      phase,
      atom,
      adapter,
      agent_run_id: agentRunId,
      seq: eventSeq,
    };
    for (const key of [
      'event_type', 'tool', 'tool_call_id', 'text', 'args_preview', 'args_digest', 'usage',
      'exit_code', 'status', 'level', 'cost_usd', 'duration_ms', 'reason', 'truncated', 'violation',
    ]) {
      const value = event[key];
      if (value === undefined || value === null) continue;
      record[key] = value;
    }
    if (changeId) record.change_id = changeId;
    if (missionId) record.mission_id = missionId;
    return record;
  }

  function schedule() {
    if (timer || !queue.length || closed) return;
    timer = setTimeout(() => {
      timer = null;
      flush().catch(() => {});
    }, flushIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const batch = queue.splice(0, queue.length);
    if (!batch.length) return writing;
    writing = writing.then(async () => {
      for (const record of batch) {
        try {
          await appendExecutionLog(projectRoot, record);
          stats.written += 1;
        } catch {
          stats.write_errors += 1;
        }
      }
    });
    return writing;
  }

  return {
    push(chunk) {
      if (closed) return;
      splitter.push(chunk);
    },
    /**
     * Write the trailing partial line, close any call still open, then every queued event.
     *
     * A run that is killed (the default 300s agent timeout, a Ctrl-C, a crashed CLI) never emits
     * its final `tool_result`, so without this the log would show that tool as running forever.
     * Safe to call twice.
     */
    async close() {
      splitter.flush();
      for (const [callId, call] of pairing.drainOpen()) {
        seq += 1;
        stats.events += 1;
        enqueue(buildRecord({
          event: 'tool_end',
          event_type: call.event_type,
          tool: call.tool,
          tool_call_id: callId,
          status: 'abandoned',
        }, seq));
      }
      closed = true;
      await flush();
      return stats;
    },
    flush,
    stats,
    get pairingViolations() {
      return pairingViolations.map((violation) => ({ ...violation }));
    },
    get pending() {
      return queue.length;
    },
    get closed() {
      return closed;
    },
  };
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function errorText(payload) {
  return String(payload.message || payload.error?.message || payload.error || payload.type || 'agent error');
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringifyArgs(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function truncateText(value, maxChars = MAX_TEXT_CHARS) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}
