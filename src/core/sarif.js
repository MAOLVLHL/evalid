/**
 * M9 slice 1 (#149): proof / audit judgements -> SARIF 2.1.0.
 *
 * Maps the claim-vs-evidence judgements evalid already makes into a
 * SARIF 2.1.0 document so findings show up in GitHub code scanning:
 *
 *   - `xflow proof` payloads (buildWorkflowProof): a failed proof
 *     (missing phases / artifacts, contract or runtime failures, no
 *     workflow_completed event) becomes one `evalid/proof-incomplete`
 *     finding per gap, located at the proof file (or the missing
 *     artifact itself). A clean proof produces zero results.
 *   - `xflow audit` reports (runAudit): a claim whose replay
 *     contradicts it becomes `evalid/claim-replay-mismatch` (message
 *     carries the claimed and replayed counts); a replay that could
 *     not run becomes the weaker `evalid/replay-unavailable` warning;
 *     a broken seal becomes one finding per breakage point, with the
 *     rule id of the validator verdict (same ids as
 *     action/sarif.mjs, so code-scanning alerts stay consistent
 *     between the CLI and the Action); an unexecuted in-diff
 *     assertion becomes `evalid/unexecuted-assertion` with the real
 *     file and line from the I6d evidence.
 *
 * Locations never invent line numbers: a startLine appears only
 * when the underlying evidence carries a real one (I6d assertions).
 * Everything else is file-level. Evidence pointers travel in
 * `properties['evalid/evidence']` (seal proof path, replayed command,
 * or proof file path).
 *
 * Schema validation is offline: the enforced subset lives in
 * schemas/sarif-2.1.0.minimal.schema.json next to this module and is
 * checked structurally by validateSarif — no network download, no
 * third-party validator. writeSarifFile refuses to write a document
 * that fails validation, and refuses to silently skip when the target
 * directory does not exist or the path is not writable: both are
 * thrown as errors with an actionable message.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SARIF_VERSION = '2.1.0';
export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
export const SARIF_TOOL_NAME = 'evalid';
export const FINGERPRINT_KEY = 'evalid/proof';

const SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'schemas',
  'sarif-2.1.0.minimal.schema.json',
);

/** Seal validator verdict -> SARIF rule. Null means "no alert": the
 *  verdict is an infrastructure failure (validator missing, spawn
 *  error, unparseable output), not evidence the proof is false — the
 *  audit already exits non-zero for those. Mirrors the rule ids in
 *  action/sarif.mjs. */
const SEAL_RULES = {
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

/** Claim-vs-replay and proof-completeness rules (CLI surface only). */
const CLI_RULES = {
  claim_replay_mismatch: {
    id: 'evalid/claim-replay-mismatch',
    level: 'error',
    short: 'Claimed test run did not replay as claimed',
    full: 'A test run the change claims to have passed exits differently, or passes a different number of tests, when replayed from a clean copy.',
  },
  replay_unavailable: {
    id: 'evalid/replay-unavailable',
    level: 'warning',
    short: 'Claimed test run could not be replayed',
    full: 'The replay of a claimed test run timed out or could not start, so the claim is unverified — not evidence the claim is false.',
  },
  unexecuted_assertion: {
    id: 'evalid/unexecuted-assertion',
    level: 'error',
    short: 'Assertion never executed during the green run',
    full: 'An assertion added or changed by the diff never executed while the claimed test run was green, so the green run does not prove it.',
  },
  proof_incomplete: {
    id: 'evalid/proof-incomplete',
    level: 'error',
    short: 'Workflow proof incomplete',
    full: 'The workflow proof is missing a completed phase, a required artifact, or the workflow_completed event, or a product-contract check failed.',
  },
};

function toRule(rule) {
  return {
    id: rule.id,
    name: rule.id.replace('evalid/', '').replace(/(^|-)(\w)/g, (_, __, ch) => ch.toUpperCase()),
    shortDescription: { text: rule.short },
    fullDescription: { text: rule.full },
    help: { text: `${rule.full} See the evalid proof ledger for the claim-vs-evidence table.` },
    defaultConfiguration: { level: rule.level },
  };
}

/** SARIF rule object for a seal validator verdict, or null (no alert). */
export function ruleForSealVerdict(verdict) {
  const rule = SEAL_RULES[verdict];
  return rule ? toRule(rule) : null;
}

/** Repo-relative path of a sealed proof file. */
export function proofFilePath(changeId, phase, attempt = 0) {
  return `specs/changes/${changeId}/tdd/${phase}-${attempt}.json`;
}

function asUri(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const uri = value.trim().replaceAll('\\', '/');
  // Absolute paths (e.g. a scratch-clone path from the validator) are
  // not portable SARIF locations; the caller falls back to a
  // repo-relative pointer instead.
  if (isAbsolute(uri) || /^[A-Za-z]:\//.test(uri)) return null;
  return uri.replace(/^\.\//, '');
}

function relativize(value, baseDir) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (!baseDir || !isAbsolute(value)) return asUri(value);
  return asUri(relative(resolve(baseDir), resolve(value)));
}

function fileLocation(uri, line = null) {
  const physicalLocation = { artifactLocation: { uri } };
  if (Number.isInteger(line) && line >= 1) {
    physicalLocation.region = { startLine: line };
  }
  return { physicalLocation };
}

function makeResult({ rule, message, locations = [], fingerprint, properties = {} }) {
  const result = {
    ruleId: rule.id,
    level: rule.defaultConfiguration.level,
    message: { text: message },
  };
  if (locations.length > 0) result.locations = locations;
  if (fingerprint) result.partialFingerprints = { [FINGERPRINT_KEY]: fingerprint };
  if (Object.keys(properties).length > 0) result.properties = properties;
  return result;
}

/** Assemble a SARIF document from rules actually used + results. */
export function buildSarifDocument({ version = '0.0.0', rules = [], results = [] }) {
  const seen = new Set();
  const dedupedRules = [];
  for (const rule of rules) {
    if (rule && !seen.has(rule.id)) {
      seen.add(rule.id);
      dedupedRules.push(rule);
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
            rules: dedupedRules,
          },
        },
        results,
      },
    ],
  };
}

// ─── xflow proof payload -> SARIF ────────────────────────────────────────────

/**
 * Map a buildWorkflowProof payload to SARIF. A clean proof (ok: true)
 * yields zero results; every gap yields one proof-incomplete finding
 * located at the proof file (or at the missing artifact itself).
 */
export function proofToSarif(proof, { version = '0.0.0', projectRoot = null } = {}) {
  const rule = toRule(CLI_RULES.proof_incomplete);
  const rules = [];
  const results = [];
  const changeId = proof?.change_id || 'unknown-change';
  const track = proof?.track || 'corps';
  const proofUri = relativize(proof?.proof_file, projectRoot)
    || `specs/changes/${changeId}/${track}_proof.json`;
  const evidence = `proof: ${proofUri}`;

  const add = (message, uri) => {
    rules.push(rule);
    results.push(makeResult({
      rule,
      message,
      locations: [fileLocation(uri)],
      fingerprint: `evalid/proof/${changeId}/${track}/${uri}`,
      properties: { changeId, track, 'evalid/evidence': evidence },
    }));
  };

  if (proof && proof.ok !== true) {
    if (proof.completed_event_seen === false) {
      add(`Proof for change ${changeId} (${track}) has no workflow_completed event: the workflow never recorded completion.`, proofUri);
    }
    for (const phase of proof.missing_phases || []) {
      add(`Proof for change ${changeId} (${track}) is missing phase '${phase}': it was not recorded as completed.`, proofUri);
    }
    for (const artifact of proof.missing_artifacts || []) {
      const artifactUri = asUri(`specs/changes/${changeId}/${artifact}`) || proofUri;
      add(`Proof for change ${changeId} (${track}) is missing required artifact '${artifact}'.`, artifactUri);
    }
    for (const failure of proof.contract_failures || []) {
      add(`Proof for change ${changeId} (${track}) contract failure: ${failure}`, proofUri);
    }
    for (const failure of proof.strict_runtime_failures || []) {
      add(`Proof for change ${changeId} (${track}) runtime failure: ${failure}`, proofUri);
    }
    if (results.length === 0) {
      add(`Proof for change ${changeId} (${track}) failed without a recorded gap.`, proofUri);
    }
  }
  return buildSarifDocument({ version, rules, results });
}

// ─── xflow audit report -> SARIF ─────────────────────────────────────────────

const PATH_LIKE_TOKEN = /(?:^|[\s"'])([^\s"'`]+(?:\/[^\s"'`]+)+\.(?:[cm]?[jt]sx?|py|go|rs|java|rb|sh|yaml|yml|json))\b/;

/** Best-known file for a claimed command: a path-like token in the
 *  command itself, else the first touched test file, else the first
 *  touched file. Null when nothing is known — the finding is then
 *  emitted without a location rather than with an invented one. */
function claimLocationUri(claim, report) {
  const match = String(claim?.command || '').match(PATH_LIKE_TOKEN);
  const fromCommand = match ? asUri(match[1]) : null;
  if (fromCommand) return fromCommand;
  const testFiles = (report?.testFiles || []).map(asUri).filter(Boolean);
  if (testFiles.length > 0) return testFiles[0];
  const files = (report?.files || []).map(asUri).filter(Boolean);
  return files.length > 0 ? files[0] : null;
}

function claimCountsText(claim) {
  const replay = claim?.replay;
  const parts = [];
  if (claim?.claimedPassed !== null && claim?.claimedPassed !== undefined
    && replay?.counts?.passed !== null && replay?.counts?.passed !== undefined) {
    parts.push(`claimed ${claim.claimedPassed} passed, replayed ${replay.counts.passed} passed`);
  }
  if (claim?.claimedFailed !== null && claim?.claimedFailed !== undefined
    && replay?.counts?.failed !== null && replay?.counts?.failed !== undefined) {
    parts.push(`claimed ${claim.claimedFailed} failed, replayed ${replay.counts.failed} failed`);
  }
  if (claim?.claimedExit !== null && claim?.claimedExit !== undefined
    && replay?.exit !== null && replay?.exit !== undefined) {
    parts.push(`claimed exit ${claim.claimedExit}, replayed exit ${replay.exit}`);
  }
  return parts.join('; ');
}

/**
 * Map a runAudit report to SARIF. Verified / no_claims reports yield
 * zero results; every mismatched claim, broken seal, and unexecuted
 * assertion yields one finding with the exact breakage point the
 * audit recorded (mismatched files, claimed/replayed counts, or the
 * assertion's file and line).
 */
export function auditReportToSarif(report, { version = '0.0.0' } = {}) {
  const rules = [];
  const results = [];

  for (const claim of report?.claims || []) {
    if (claim?.match !== false) continue;
    const replay = claim.replay || {};
    const unavailable = replay.timedOut === true || typeof replay.spawnError === 'string';
    const rule = toRule(unavailable ? CLI_RULES.replay_unavailable : CLI_RULES.claim_replay_mismatch);
    const counts = claimCountsText(claim);
    const detail = counts || claim.note || 'replay did not match the claim';
    const message = unavailable
      ? `Claim '${claim.command}' could not be replayed (${detail}); the claim is unverified.`
      : `Claim '${claim.command}' did not replay as claimed (${detail}).`;
    const uri = claimLocationUri(claim, report);
    rules.push(rule);
    results.push(makeResult({
      rule,
      message,
      locations: uri ? [fileLocation(uri)] : [],
      fingerprint: `evalid/audit/claim/${claim.command}`,
      properties: {
        'evalid/evidence': `replay: ${claim.command}`,
        claimedPassed: claim.claimedPassed ?? null,
        replayedPassed: replay.counts?.passed ?? null,
        claimedExit: claim.claimedExit ?? null,
        replayedExit: replay.exit ?? null,
      },
    }));
  }

  for (const seal of report?.seals || []) {
    if (seal?.ok !== false) continue;
    const rule = ruleForSealVerdict(seal.verdict);
    if (!rule) continue; // infrastructure verdict: no alert, audit already fails
    const sealPath = proofFilePath(seal.changeId, seal.phase, seal.attempt);
    const breakageFiles = (Array.isArray(seal.files) ? seal.files : [])
      .map(asUri)
      .filter(Boolean);
    const uris = breakageFiles.length > 0 ? [...new Set(breakageFiles)] : [sealPath];
    for (const uri of uris) {
      const breakage = breakageFiles.length > 0
        ? ` Broken file: ${uri}.`
        : '';
      rules.push(rule);
      results.push(makeResult({
        rule,
        message: `Seal ${seal.changeId}/${seal.phase}/${seal.attempt} failed: ${seal.verdict}. ${SEAL_RULES[seal.verdict].full}${breakage}`,
        locations: [fileLocation(uri)],
        fingerprint: `evalid/proof/${seal.changeId}/${seal.phase}/${seal.attempt}/${seal.verdict}/${uri}`,
        properties: {
          changeId: seal.changeId,
          phase: seal.phase,
          attempt: seal.attempt,
          verdict: seal.verdict,
          'evalid/evidence': `seal: ${seal.path || sealPath}`,
        },
      }));
    }
  }

  const i6d = report?.i6d;
  if (i6d?.applicable && i6d.verdict === 'unexecuted_assertions') {
    const rule = toRule(CLI_RULES.unexecuted_assertion);
    for (const entry of i6d.unexecuted || []) {
      const uri = asUri(entry?.file);
      if (!uri) continue;
      const line = Number.isInteger(entry?.line) && entry.line >= 1 ? entry.line : null;
      const test = entry?.test ? ` in ${entry.test}` : '';
      const source = entry?.source ? `: ${entry.source}` : '';
      rules.push(rule);
      results.push(makeResult({
        rule,
        message: `Assertion${test} at ${uri}${line ? `:${line}` : ''} never executed during the green run${source}.`,
        locations: [fileLocation(uri, line)],
        fingerprint: `evalid/audit/i6d/${uri}/${line ?? 'noloc'}/${entry?.test ?? ''}`,
        properties: { 'evalid/evidence': `i6d: ${uri}${line ? `:${line}` : ''}` },
      }));
    }
  }

  return buildSarifDocument({ version, rules, results });
}

// ─── offline schema validation ───────────────────────────────────────────────

let cachedSchema = null;

/**
 * Load the local minimal SARIF schema and normalize the required-key
 * lists it declares (top-level `required`, run-level
 * `properties.runs.items.required`, result-level
 * `properties.runs.items.properties.results.items.required`) into
 * flat fields the validator reads. Falls back to the embedded copy
 * when the file cannot be read (e.g. src vendored alone).
 */
export function loadMinimalSarifSchema() {
  if (cachedSchema) return cachedSchema;
  let raw;
  try {
    raw = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  } catch {
    raw = null;
  }
  const nested = (path) => path.reduce((node, key) => node?.[key], raw);
  cachedSchema = {
    $schema: raw?.$schema || FALLBACK_MINIMAL_SCHEMA.$schema,
    version: raw?.version?.const || FALLBACK_MINIMAL_SCHEMA.version,
    required: raw?.required || FALLBACK_MINIMAL_SCHEMA.required,
    runRequired: nested(['properties', 'runs', 'items', 'required'])
      || FALLBACK_MINIMAL_SCHEMA.runRequired,
    resultRequired: nested(['properties', 'runs', 'items', 'properties', 'results', 'items', 'required'])
      || FALLBACK_MINIMAL_SCHEMA.resultRequired,
    levels: nested(['properties', 'runs', 'items', 'properties', 'results', 'items', 'properties', 'level', 'enum'])
      || FALLBACK_MINIMAL_SCHEMA.levels,
  };
  return cachedSchema;
}

/** Embedded copy of the enforced subset (kept in sync with the file
 *  above; the file is authoritative when readable). */
const FALLBACK_MINIMAL_SCHEMA = {
  $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
  version: '2.1.0',
  required: ['$schema', 'version', 'runs'],
  runRequired: ['tool', 'results'],
  resultRequired: ['ruleId', 'message'],
  levels: ['none', 'note', 'warning', 'error'],
};

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Offline structural validation of a SARIF document against the
 * enforced 2.1.0 subset (see schemas/sarif-2.1.0.minimal.schema.json).
 * Returns { ok, errors }. Never touches the network.
 */
export function validateSarif(document) {
  const errors = [];
  const schema = loadMinimalSarifSchema();
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { ok: false, errors: ['SARIF document must be a JSON object'] };
  }
  for (const key of schema.required || []) {
    if (document[key] === undefined) errors.push(`missing required top-level property: ${key}`);
  }
  if (document.$schema !== undefined && !isNonEmptyString(document.$schema)) {
    errors.push('$schema must be a non-empty string');
  }
  if (document.version !== undefined && document.version !== SARIF_VERSION) {
    errors.push(`version must be '${SARIF_VERSION}', got '${document.version}'`);
  }
  if (!Array.isArray(document.runs) || document.runs.length === 0) {
    errors.push('runs must be a non-empty array');
    return { ok: false, errors };
  }
  const allowedLevels = new Set(schema.levels || ['none', 'note', 'warning', 'error']);
  document.runs.forEach((run, runIndex) => {
    const where = `runs[${runIndex}]`;
    if (!run || typeof run !== 'object') {
      errors.push(`${where} must be an object`);
      return;
    }
    for (const key of schema.runRequired || []) {
      if (run[key] === undefined) errors.push(`${where} is missing required property: ${key}`);
    }
    const driver = run.tool?.driver;
    if (!driver || typeof driver !== 'object') {
      errors.push(`${where}.tool.driver must be an object`);
    } else {
      if (!isNonEmptyString(driver.name)) errors.push(`${where}.tool.driver.name must be a non-empty string`);
      if (driver.rules !== undefined && !Array.isArray(driver.rules)) {
        errors.push(`${where}.tool.driver.rules must be an array`);
      }
    }
    const declaredRules = new Set(
      (Array.isArray(driver?.rules) ? driver.rules : [])
        .map((rule) => rule?.id)
        .filter((id) => typeof id === 'string'),
    );
    (Array.isArray(driver?.rules) ? driver.rules : []).forEach((rule, ruleIndex) => {
      if (!isNonEmptyString(rule?.id)) errors.push(`${where}.tool.driver.rules[${ruleIndex}].id must be a non-empty string`);
      if (!isNonEmptyString(rule?.shortDescription?.text)) {
        errors.push(`${where}.tool.driver.rules[${ruleIndex}].shortDescription.text must be a non-empty string`);
      }
    });
    if (!Array.isArray(run.results)) {
      errors.push(`${where}.results must be an array`);
      return;
    }
    run.results.forEach((result, resultIndex) => {
      const at = `${where}.results[${resultIndex}]`;
      if (!result || typeof result !== 'object') {
        errors.push(`${at} must be an object`);
        return;
      }
      for (const key of schema.resultRequired || []) {
        if (result[key] === undefined) errors.push(`${at} is missing required property: ${key}`);
      }
      if (!isNonEmptyString(result.ruleId)) errors.push(`${at}.ruleId must be a non-empty string`);
      else if (!declaredRules.has(result.ruleId)) errors.push(`${at}.ruleId '${result.ruleId}' is not declared in tool.driver.rules`);
      if (!isNonEmptyString(result.message?.text)) errors.push(`${at}.message.text must be a non-empty string`);
      if (result.level !== undefined && !allowedLevels.has(result.level)) {
        errors.push(`${at}.level must be one of ${[...allowedLevels].join(', ')}`);
      }
      (Array.isArray(result.locations) ? result.locations : []).forEach((location, locIndex) => {
        const uri = location?.physicalLocation?.artifactLocation?.uri;
        if (!isNonEmptyString(uri)) {
          errors.push(`${at}.locations[${locIndex}].physicalLocation.artifactLocation.uri must be a non-empty string`);
        }
        const startLine = location?.physicalLocation?.region?.startLine;
        if (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1)) {
          errors.push(`${at}.locations[${locIndex}].physicalLocation.region.startLine must be an integer >= 1`);
        }
      });
      const fingerprints = result.partialFingerprints;
      if (fingerprints !== undefined) {
        for (const [key, value] of Object.entries(fingerprints)) {
          if (!isNonEmptyString(value)) errors.push(`${at}.partialFingerprints.${key} must be a non-empty string`);
        }
      }
    });
  });
  return { ok: errors.length === 0, errors };
}

// ─── writing ─────────────────────────────────────────────────────────────────

/**
 * Write a SARIF document to disk. Validates offline first and refuses
 * to write an invalid document. Never creates parent directories and
 * never silently skips: a missing directory or an unwritable path
 * throws an Error with an actionable message.
 */
export function writeSarifFile(sarifPath, document) {
  const validation = validateSarif(document);
  if (!validation.ok) {
    throw new Error(
      `SARIF document failed offline schema validation:\n- ${validation.errors.join('\n- ')}\nFix the generator; no file was written to ${sarifPath}.`,
    );
  }
  const target = resolve(sarifPath);
  const parent = dirname(target);
  if (!existsSync(parent)) {
    throw new Error(
      `Cannot write SARIF to ${sarifPath}: directory does not exist: ${parent}. `
      + `Create it first (mkdir -p ${parent}) or pass a --sarif path inside an existing directory.`,
    );
  }
  try {
    writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  } catch (error) {
    throw new Error(
      `Cannot write SARIF to ${sarifPath}: ${error.message}. `
      + 'Check the path is writable (parent directory permissions, disk space) and retry with a writable path.',
    );
  }
  return target;
}
