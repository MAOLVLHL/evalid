#!/usr/bin/env node
/**
 * evalid SARIF export for code scanning (issue #73).
 *
 * Turns a proof validator verdict into a SARIF 2.1.0 document so a
 * broken seal shows up as a code scanning alert (Security tab) instead
 * of only a red check and a PR comment.
 *
 * Mapping rules:
 * - Proof-failure verdicts map to one rule each (binding_mismatch,
 *   snapshot_mismatch, green_tree_mismatch, reexec_* and the other
 *   validator failure verdicts). Level is `error`, except
 *   tests_skipped_or_todo / tests_counts_unknown which are `warning`
 *   (the run did not really execute the tests — a weaker signal than
 *   tampering or drift).
 * - `valid` / `not_required` produce zero results: uploading an
 *   empty-results SARIF for the same tool dismisses alerts a previous
 *   push of the same PR raised, so a fixed proof clears its alert.
 * - Infrastructure verdicts (missing_change_id, validator_missing,
 *   spawn_error, unparseable_output, invalid_tdd_mode) are not proof
 *   failures and produce zero results — the check already fails for
 *   those, and they must not become code scanning alerts.
 *
 * Locations: when the verdict names files, one result is emitted per
 * file (repo-relative path, file-level location — the validator does
 * not record line numbers). When the verdict names no file, the result
 * degrades to the proof file itself
 * (specs/changes/<id>/tdd/<phase>-<attempt>.json), so the alert still
 * points somewhere inspectable.
 *
 * Dedup: every result carries a stable partialFingerprint
 * `evalid/proof` built from change-id / phase / attempt / verdict /
 * location. Re-running the same proof re-uploads the same fingerprint,
 * so GitHub updates the existing alert instead of opening a duplicate.
 * Merging is an upsert keyed on the same identity: merging a document
 * for a proof first drops that proof's previous results, so a proof
 * that turned valid clears its alert from the file.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { explainVerdict } from './ledger-comment.mjs';

export const SARIF_VERSION = '2.1.0';
export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
export const SARIF_TOOL_NAME = 'evalid';
export const FINGERPRINT_KEY = 'evalid/proof';

/** Verdict -> { id, level, short, full }. Null means "no alert". */
const RULES = {
  binding_mismatch: {
    id: 'evalid/binding-mismatch',
    level: 'error',
    short: 'Proof binding mismatch',
    full: 'The proof JSON was edited after sealing: command, exit code, output hash, or file hashes no longer match the recorded binding.',
  },
  snapshot_mismatch: {
    id: 'evalid/snapshot-mismatch',
    level: 'error',
    short: 'Sealed snapshot mismatch',
    full: 'Files in the sealed snapshot no longer match their sealed hashes.',
  },
  green_tree_mismatch: {
    id: 'evalid/green-tree-mismatch',
    level: 'error',
    short: 'Green-tree drift after seal',
    full: 'Test files changed after the seal (unsealed edits).',
  },
  reexec_timeout: {
    id: 'evalid/reexec-timeout',
    level: 'error',
    short: 'Replay timed out',
    full: 'The replayed test command timed out.',
  },
  reexec_exit_mismatch: {
    id: 'evalid/reexec-exit-mismatch',
    level: 'error',
    short: 'Replay exit code mismatch',
    full: 'The clean replay exit code differs from the claimed exit code.',
  },
  reexec_result_mismatch: {
    id: 'evalid/reexec-result-mismatch',
    level: 'error',
    short: 'Replay result mismatch',
    full: 'The clean replay failure kind differs from the claimed failure kind.',
  },
  missing: {
    id: 'evalid/proof-missing',
    level: 'error',
    short: 'Sealed proof missing',
    full: 'No sealed proof found for this change / phase / attempt.',
  },
  invalid_json: {
    id: 'evalid/proof-invalid-json',
    level: 'error',
    short: 'Proof is not valid JSON',
    full: 'The proof file is not valid JSON.',
  },
  schema_error: {
    id: 'evalid/proof-schema-error',
    level: 'error',
    short: 'Proof schema error',
    full: 'The proof is missing required fields.',
  },
  phase_mismatch: {
    id: 'evalid/proof-phase-mismatch',
    level: 'error',
    short: 'Proof phase mismatch',
    full: 'The proof records a different phase than the one requested.',
  },
  binding_missing: {
    id: 'evalid/proof-unsealed',
    level: 'error',
    short: 'Proof never sealed',
    full: 'The proof has no binding, failure kind, or file hashes — it was never sealed.',
  },
  proof_inconsistent: {
    id: 'evalid/proof-inconsistent',
    level: 'error',
    short: 'Proof contradicts itself',
    full: 'The proof `passed` flag does not agree with its `exit_code`.',
  },
  replay_source_missing: {
    id: 'evalid/replay-source-missing',
    level: 'error',
    short: 'Replay source missing',
    full: 'The sealed snapshot could not be replayed.',
  },
  tests_skipped_or_todo: {
    id: 'evalid/tests-skipped-or-todo',
    level: 'warning',
    short: 'Replay shows skipped or todo tests',
    full: 'The replay shows skipped, todo, or focused tests — the green run did not really execute the tests.',
  },
  tests_counts_unknown: {
    id: 'evalid/tests-counts-unknown',
    level: 'warning',
    short: 'Replay test counts unknown',
    full: 'The replay output carries no readable test counts.',
  },
  semantic_error: {
    id: 'evalid/proof-semantic-error',
    level: 'error',
    short: 'Proof semantic error',
    full: 'The proof claims a result its phase does not expect.',
  },
  expectation_not_met: {
    id: 'evalid/expectation-not-met',
    level: 'error',
    short: 'Proof expectation not met',
    full: 'The proof records `expectation_met: false`.',
  },
};

/** SARIF rule object for a verdict, or null when the verdict is no alert. */
export function verdictRule(verdict) {
  const rule = RULES[verdict];
  if (!rule) return null;
  return {
    id: rule.id,
    name: rule.id.replace('evalid/', '').replace(/(^|-)(\w)/g, (_, dash, ch) => ch.toUpperCase()),
    shortDescription: { text: rule.short },
    fullDescription: { text: rule.full },
    help: { text: `${rule.full} See the evalid proof ledger comment on the pull request for the claim-vs-evidence table.` },
    defaultConfiguration: { level: rule.level },
    properties: { 'evalid/verdict': verdict },
  };
}

/** Repo-relative path of a sealed proof file. */
export function proofFilePath(changeId, phase, attempt = 0) {
  return `specs/changes/${changeId}/tdd/${phase}-${attempt}.json`;
}

/** Stable dedup fingerprint for one result: same proof + verdict + file. */
export function resultFingerprint({ changeId, phase, attempt = 0, verdict, uri }) {
  return `${changeId}/${phase}/${attempt}/${verdict}/${uri}`;
}

function proofIdentity({ changeId, phase, attempt = 0 }) {
  return { changeId, phase, attempt };
}

/**
 * Build a SARIF document for one proof verdict.
 *
 * @param {object} args
 * @param {string} args.changeId
 * @param {string} args.phase
 * @param {number} args.attempt
 * @param {object} args.payload validator verdict payload (may be {})
 * @param {string} [args.version] evalid version for tool.driver.version
 * @param {string} [args.runUrl] workflow run link, recorded on results
 * @param {string} [args.repo] owner/repo, recorded on results
 */
export function buildSarif({
  changeId,
  phase,
  attempt = 0,
  payload = {},
  version = '0.0.0',
  runUrl = '',
  repo = '',
}) {
  const verdict = payload.verdict || 'unknown';
  const rule = verdictRule(verdict);
  const results = [];
  if (rule) {
    const files = Array.isArray(payload.files) && payload.files.length > 0
      ? [...new Set(payload.files)]
      : [proofFilePath(changeId, phase, attempt)];
    for (const uri of files) {
      const properties = {
        ...proofIdentity({ changeId, phase, attempt }),
        verdict,
      };
      if (runUrl) properties.runUrl = runUrl;
      if (repo) properties.repo = repo;
      results.push({
        ruleId: rule.id,
        level: rule.defaultConfiguration.level,
        message: { text: explainVerdict(payload) },
        locations: [
          { physicalLocation: { artifactLocation: { uri } } },
        ],
        partialFingerprints: {
          [FINGERPRINT_KEY]: resultFingerprint({ changeId, phase, attempt, verdict, uri }),
        },
        properties,
      });
    }
  }
  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: SARIF_TOOL_NAME,
            version,
            informationUri: 'https://github.com/surlymochan/evalid',
            rules: rule ? [rule] : [],
          },
        },
        results,
      },
    ],
  };
}

/** Read a SARIF file written by buildSarif/mergeSarif; null when absent/invalid. */
export function readSarif(sarifPath) {
  try {
    const doc = JSON.parse(readFileSync(sarifPath, 'utf8'));
    if (!doc || doc.version !== SARIF_VERSION || !Array.isArray(doc.runs) || doc.runs.length === 0) return null;
    if (doc.runs[0]?.tool?.driver?.name !== SARIF_TOOL_NAME) return null;
    return doc;
  } catch {
    return null;
  }
}

/** Empty evalid SARIF document (no rules, no results). */
export function emptySarif(version = '0.0.0') {
  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: SARIF_TOOL_NAME,
            version,
            informationUri: 'https://github.com/surlymochan/evalid',
            rules: [],
          },
        },
        results: [],
      },
    ],
  };
}

function sameProof(a, b) {
  return a?.changeId === b?.changeId && a?.phase === b?.phase && Number(a?.attempt) === Number(b?.attempt);
}

/**
 * Merge one proof's SARIF document into the file, keyed on the proof.
 * Upsert: the proof's previous results are dropped first, then the new
 * ones are appended, so a re-run replaces (never duplicates) its alert
 * and a proof that turned valid clears its alert from the file. Rules
 * are merged by id. Returns the merged document.
 * `proof` is { changeId, phase, attempt } — required so a valid proof
 * (zero results, zero rules) can still clear its previous alert.
 */
export function mergeSarifForProof({ sarifPath, document, proof, version = '0.0.0' }) {
  const existing = readSarif(sarifPath) || emptySarif(version);
  const run = existing.runs[0];
  const incoming = document.runs[0];

  run.results = (run.results || []).filter((r) => !sameProof(r.properties, proof));
  run.results.push(...(incoming.results || []));

  const seen = new Set((run.tool.driver.rules || []).map((r) => r.id));
  for (const rule of incoming.tool?.driver?.rules || []) {
    if (!seen.has(rule.id)) {
      run.tool.driver.rules.push(rule);
      seen.add(rule.id);
    }
  }
  if (version && version !== '0.0.0') run.tool.driver.version = version;

  mkdirSync(dirname(sarifPath), { recursive: true });
  writeFileSync(sarifPath, `${JSON.stringify(existing, null, 2)}\n`);
  return existing;
}

/** Write a SARIF document to disk (creating parent dirs). */
export function writeSarifFile(sarifPath, document) {
  mkdirSync(dirname(sarifPath), { recursive: true });
  writeFileSync(sarifPath, `${JSON.stringify(document, null, 2)}\n`);
  return sarifPath;
}
