/**
 * phase-run-dispatch dead code removal
 *
 * `src/agent_team/atoms/phase-run-dispatch.js` exported `phaseRunDispatch`,
 * a thin wrapper around `synthesizePhaseArtifact` from `agent_team/common.js`.
 * Repo-wide grep (2026-11-08) proves it was dead:
 * - the only occurrence of `phaseRunDispatch` / `phase-run-dispatch` in the
 *   whole repo was its own definition site (no import, no test, no doc ref);
 * - it is absent from `atoms/registry.json` and from the public
 *   `src/index.js` surface;
 * - the registry entry `I2.phase_run.dispatch` points at
 *   `src/core/atoms/agent-invoke.js` (type `agent_invoke`), not at this file,
 *   so the corps workflow's execute phase never executed this module.
 *
 * These tests pin the removal: the file must stay gone, nothing may point
 * at it again, and the live I2 dispatch path must keep resolving.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { load } from '../src/core/workflow-loader.js';
import { synthesizePhaseArtifact } from '../src/agent_team/common.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DEAD_MODULE = 'src/agent_team/atoms/phase-run-dispatch.js';

function loadRegistry() {
  return JSON.parse(readFileSync(resolve(ROOT, 'atoms', 'registry.json'), 'utf8'));
}

describe('phase-run-dispatch dead code removal', () => {
  test('dead wrapper module no longer exists', () => {
    assert.equal(
      existsSync(resolve(ROOT, DEAD_MODULE)),
      false,
      `${DEAD_MODULE} must stay deleted: repo-wide grep shows zero callers`,
    );
  });

  test('no registry atom points at the deleted module or its export', () => {
    const registry = loadRegistry();
    for (const [id, def] of Object.entries(registry.atoms)) {
      assert.notEqual(def.module, DEAD_MODULE, `atom ${id} still points at deleted module`);
      assert.notEqual(def.export, 'phaseRunDispatch', `atom ${id} still exports phaseRunDispatch`);
    }
  });

  test('I2.phase_run.dispatch still resolves to the live agent-invoke path', () => {
    const registry = loadRegistry();
    const def = registry.atoms['I2.phase_run.dispatch'];
    assert.ok(def, 'I2.phase_run.dispatch must stay registered');
    assert.equal(def.type, 'agent_invoke');
    assert.equal(def.module, 'src/core/atoms/agent-invoke.js');
    assert.equal(existsSync(resolve(ROOT, def.module)), true);
  });

  test('shared helper used by the dead wrapper survives (live atoms need it)', () => {
    assert.equal(typeof synthesizePhaseArtifact, 'function');
  });

  test('corps workflow still loads with I2 dispatch resolving', () => {
    // load() throws on any validation error, so reaching here proves resolution.
    const { phases } = load('workflows/corps.yaml', { skipRuntimeChecks: true });
    const execute = phases.find((phase) => phase.id === 'execute');
    assert.ok(execute, 'corps workflow must keep its execute phase');
    assert.ok(
      (execute.atoms || []).some((atom) => atom.id === 'I2.phase_run.dispatch'),
      'execute phase must still dispatch via I2.phase_run.dispatch',
    );
  });
});
