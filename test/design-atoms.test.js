import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { competitorReconstructionReview } from '../src/agent_team/atoms/design/competitor-reconstruction-review.js';
import { referenceSurfaceLock } from '../src/agent_team/atoms/design/reference-surface-lock.js';
import { reconstructionPack } from '../src/agent_team/atoms/design/reconstruction-pack.js';

function makeProjectRoot() {
  return mkdtempSync(join(tmpdir(), 'evalid-design-atoms-'));
}

function cleanupProjectRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('H2b competitor reconstruction review', () => {
  test('freezes a contract with the first target surface as primary', async () => {
    const projectRoot = makeProjectRoot();
    try {
      const result = await competitorReconstructionReview(
        {
          competitor_product: 'Acme Board',
          target_surfaces: ['board', 'calendar', 'detail'],
          required_modules: ['calendar'],
          primary_journeys: ['create_event'],
          business_logic_invariants: ['no duplicate events'],
        },
        { projectRoot, changeId: 'chg-design-1' },
      );

      assert.equal(result.ok, true);
      assert.ok(existsSync(result.artifact_file));
      const contract = result.payload.competitor_reconstruction_contract;
      assert.equal(contract.status, 'frozen');
      assert.equal(contract.competitor_product, 'Acme Board');
      assert.equal(contract.primary_reference_surface, 'board');
      assert.deepEqual(contract.supporting_reference_surfaces, ['calendar', 'detail']);
      assert.deepEqual(contract.target_surfaces, ['board', 'calendar', 'detail']);
      assert.deepEqual(contract.required_modules, ['calendar']);
      assert.deepEqual(contract.primary_journeys, ['create_event']);
      assert.deepEqual(contract.business_logic_invariants, ['no duplicate events']);
      assert.equal(contract.decomposition_requirements.surface_map_required, true);
      assert.equal(contract.decomposition_requirements.reference_intermediate_model_required, true);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  test('honours an explicit primary reference surface and defaults the product', async () => {
    const projectRoot = makeProjectRoot();
    try {
      const result = await competitorReconstructionReview(
        {
          target_surfaces: ['board', 'calendar'],
          primary_reference_surface: 'calendar',
        },
        { projectRoot, changeId: 'chg-design-1' },
      );

      const contract = result.payload.competitor_reconstruction_contract;
      assert.equal(contract.competitor_product, 'required');
      assert.equal(contract.primary_reference_surface, 'calendar');
      assert.deepEqual(contract.supporting_reference_surfaces, ['board']);
      assert.deepEqual(contract.target_surfaces, ['board', 'calendar']);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  test('treats non-array inputs as empty lists', async () => {
    const projectRoot = makeProjectRoot();
    try {
      const result = await competitorReconstructionReview(
        { target_surfaces: 'board', required_modules: 'calendar' },
        { projectRoot, changeId: 'chg-design-1' },
      );

      const contract = result.payload.competitor_reconstruction_contract;
      assert.equal(contract.primary_reference_surface, null);
      assert.deepEqual(contract.supporting_reference_surfaces, []);
      assert.deepEqual(contract.required_modules, []);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });
});

describe('H2d reference surface lock', () => {
  test('throws without a change id', async () => {
    await assert.rejects(
      referenceSurfaceLock({ target_surfaces: ['board'] }, { projectRoot: makeProjectRoot() }),
      /change_id is required for H2d/,
    );
  });

  test('locks a primary surface and writes the lock file', async () => {
    const projectRoot = makeProjectRoot();
    try {
      const result = await referenceSurfaceLock(
        {
          target_surfaces: ['board', 'calendar', 'detail'],
          required_modules: ['calendar', '', null],
          primary_journeys: ['create_event'],
        },
        { projectRoot, changeId: 'chg-design-2' },
      );

      assert.equal(result.ok, true);
      assert.equal(result.status, 'locked');
      assert.equal(
        result.output_file,
        resolve(projectRoot, 'specs', 'changes', 'chg-design-2', 'reference_surface_lock.json'),
      );
      const stored = readJson(result.output_file);
      assert.equal(stored.status, 'locked');
      assert.equal(stored.change_id, 'chg-design-2');
      assert.equal(stored.reference_surface_lock.primary_reference_surface, 'board');
      assert.deepEqual(stored.reference_surface_lock.supporting_reference_surfaces, ['calendar', 'detail']);
      assert.deepEqual(stored.reference_surface_lock.focus_modules, ['calendar']);
      assert.deepEqual(stored.reference_surface_lock.focus_journeys, ['create_event']);
      assert.match(stored.reference_surface_lock.locking_rationale, /mirror board first/);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  test('reports needs_human when no surface is supplied', async () => {
    const projectRoot = makeProjectRoot();
    try {
      const result = await referenceSurfaceLock(
        { target_surfaces: [] },
        { projectRoot, changeId: 'chg-design-2' },
      );

      assert.equal(result.ok, false);
      assert.equal(result.status, 'needs_human');
      assert.equal(result.payload.reference_surface_lock.primary_reference_surface, null);
      assert.match(
        result.payload.reference_surface_lock.locking_rationale,
        /still missing/,
      );
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  test('honours an explicit primary reference surface', async () => {
    const projectRoot = makeProjectRoot();
    try {
      const result = await referenceSurfaceLock(
        {
          target_surfaces: ['board', 'calendar'],
          primary_reference_surface: 'calendar',
        },
        { projectRoot, changeId: 'chg-design-2' },
      );

      assert.equal(result.payload.reference_surface_lock.primary_reference_surface, 'calendar');
      assert.deepEqual(result.payload.reference_surface_lock.supporting_reference_surfaces, ['board']);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });
});

describe('H2e reconstruction pack', () => {
  test('throws without a change id', async () => {
    await assert.rejects(
      reconstructionPack({ target_surfaces: ['board'] }, { projectRoot: makeProjectRoot() }),
      /change_id is required for H2e/,
    );
  });

  test('builds a pack with families, blueprints and a relationship graph', async () => {
    const projectRoot = makeProjectRoot();
    try {
      const result = await reconstructionPack(
        {
          target_surfaces: ['board', 'calendar'],
          required_modules: ['event_calendar', 'event_detail', 'side_nav', 'task_list'],
          primary_journeys: ['create_event', 'edit_event'],
          business_logic_invariants: ['no duplicate events'],
        },
        { projectRoot, changeId: 'chg-design-3' },
      );

      assert.equal(result.ok, true);
      assert.equal(result.status, 'ready');
      assert.equal(
        result.output_file,
        resolve(projectRoot, 'specs', 'changes', 'chg-design-3', 'reconstruction_pack.json'),
      );
      const pack = readJson(result.output_file).reconstruction_pack;
      assert.equal(pack.status, 'ready');
      assert.equal(pack.primary_reference_surface, 'board');

      assert.deepEqual(
        pack.surface_map.map((entry) => [entry.surface_id, entry.priority, entry.role]),
        [
          ['board', 'primary', 'reference_anchor'],
          ['calendar', 'supporting', 'support_surface'],
        ],
      );

      assert.deepEqual(
        pack.layout_map.regions.map((region) => [region.id, region.relative_position]),
        [
          ['event_calendar', 'leading'],
          ['event_detail', 'center'],
          ['side_nav', 'center'],
          ['task_list', 'trailing'],
        ],
      );

      assert.deepEqual(
        pack.component_inventory.map((component) => [component.id, component.family]),
        [
          ['event_calendar_workbench_component', 'planner_region'],
          ['event_detail_workbench_component', 'detail_region'],
          ['side_nav_workbench_component', 'navigation_region'],
          ['task_list_workbench_component', 'workbench_region'],
        ],
      );

      const blueprintByModule = {};
      for (const component of pack.component_blueprint) {
        blueprintByModule[component.module] = (blueprintByModule[component.module] || 0) + 1;
      }
      assert.deepEqual(blueprintByModule, {
        event_calendar: 5,
        event_detail: 4,
        side_nav: 5,
        task_list: 5,
      });
      const calendarCells = pack.component_blueprint.filter(
        (component) => component.module === 'event_calendar' && component.primitive_role === 'grid_cell',
      );
      assert.equal(calendarCells.length, 1);
      assert.equal(calendarCells[0].hierarchy_role, 'primary');

      assert.deepEqual(
        pack.state_inventory.map((state) => state.id),
        ['create_event_state', 'edit_event_state'],
      );
      assert.match(
        pack.decomposition_summary,
        /Prepared 2 surfaces, 4 layout regions, 4 component families, 19 component primitives, and 2 primary states\./,
      );
      assert.deepEqual(pack.decomposition_labels, [
        'Event Calendar',
        'Event Detail',
        'Side Nav',
        'Task List',
      ]);
      assert.deepEqual(
        pack.reference_intermediate_model.reference_token_summary.protected_invariants,
        ['no duplicate events'],
      );

      const regionOrders = pack.reference_intermediate_model.relationship_graph.filter(
        (edge) => edge.type === 'region_order',
      );
      assert.equal(regionOrders.length, 4);
      assert.equal(regionOrders[0].detail, 'leading_region');
      assert.equal(regionOrders[1].detail, 'follows_previous_region');
      assert.equal(regionOrders[1].target, 'event_calendar');
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  test('reports not-ready when surfaces or modules are missing', async () => {
    const projectRoot = makeProjectRoot();
    try {
      const noModules = await reconstructionPack(
        { target_surfaces: ['board'], required_modules: [] },
        { projectRoot, changeId: 'chg-design-3' },
      );
      assert.equal(noModules.ok, false);
      assert.equal(noModules.status, 'ready');

      const noSurfaces = await reconstructionPack(
        { target_surfaces: [], required_modules: ['task_list'] },
        { projectRoot, changeId: 'chg-design-3' },
      );
      assert.equal(noSurfaces.ok, false);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });
});
