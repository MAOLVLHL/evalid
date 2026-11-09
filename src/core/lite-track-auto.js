/**
 * M4 lite fast track, slice 3 (evalid #101, parent #97): auto-select the
 * track for `xflow workflow run`.
 *
 * With no explicit flag the run classifies the change first (slice 1's
 * `xflow/atoms/lite_track.py`, working-tree diff against the merge-base,
 * `--uncommitted`): a small diff walks the lite track, a big diff stays
 * full. Explicit `--lite` / `--full` always wins; both flags together
 * resolve to full (conservative). Any classifier failure falls back to
 * full and records the failure -- a run must never silently go lite.
 *
 * The returned decision object is JSON-serialisable on purpose: the CLI
 * attaches it to the workflow input as `lite_track_decision` and the
 * executor records it in the `workflow_started` / `workflow_completed`
 * events, next to slice 1's `lite_fast_track` field.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CLASSIFIER_PATH = resolve(__dirname, '..', '..', 'xflow', 'atoms', 'lite_track.py');
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Run the classifier against `projectRoot` and return the auto decision.
 *
 * `runClassifier` is injectable (defaults to `spawnSync`) so tests can
 * stub the classifier invocation without touching git or python.
 */
export function resolveLiteTrackAuto({
  projectRoot,
  classifierPath = DEFAULT_CLASSIFIER_PATH,
  python = process.env.PYTHON || 'python3',
  runClassifier = spawnSync,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const fallback = (detail) => ({
    source: 'auto-fallback-full',
    track: 'full',
    reason: `classifier failed (${detail}); falling back to full track`,
    files: null,
    added: null,
    removed: null,
    total: null,
    base: null,
    force_full: [],
  });

  let result;
  try {
    result = runClassifier(
      python,
      [classifierPath, '--repo', projectRoot, '--uncommitted', '--json'],
      { encoding: 'utf8', timeout: timeoutMs },
    );
  } catch (err) {
    return fallback(`spawn error: ${err?.message || String(err)}`);
  }
  if (!result || result.status !== 0) {
    const detail = String(
      result?.stderr?.trim() || result?.error?.message || `exit ${result?.status ?? 'unknown'}`,
    ).slice(0, 200);
    return fallback(detail);
  }
  let verdict;
  try {
    verdict = JSON.parse(result.stdout);
  } catch {
    return fallback('unparseable classifier output');
  }
  if (verdict?.track !== 'lite' && verdict?.track !== 'full') {
    return fallback(`unexpected verdict: ${JSON.stringify(verdict).slice(0, 200)}`);
  }
  return {
    source: 'auto',
    track: verdict.track,
    reason: verdict.reason || '',
    files: verdict.files ?? null,
    added: verdict.added ?? null,
    removed: verdict.removed ?? null,
    total: verdict.total ?? null,
    base: verdict.base ?? null,
    force_full: verdict.force_full || [],
  };
}

/**
 * Resolve the effective track from explicit flags and (when neither flag
 * is given) the auto decision. Returns `{ lite, decision }`.
 */
export function decideLiteTrack({ lite, full, autoDecision }) {
  if (lite === true && full === true) {
    return {
      lite: false,
      decision: {
        source: 'explicit-full',
        track: 'full',
        reason: 'both --lite and --full given; --full wins (conservative)',
      },
    };
  }
  if (lite === true) {
    return {
      lite: true,
      decision: { source: 'explicit-lite', track: 'lite', reason: 'explicit --lite flag' },
    };
  }
  if (full === true) {
    return {
      lite: false,
      decision: { source: 'explicit-full', track: 'full', reason: 'explicit --full flag' },
    };
  }
  if (!autoDecision) {
    return {
      lite: false,
      decision: {
        source: 'auto-fallback-full',
        track: 'full',
        reason: 'no classifier verdict available; falling back to full track',
      },
    };
  }
  return { lite: autoDecision.track === 'lite', decision: autoDecision };
}
