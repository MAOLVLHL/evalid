import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { intakePreviewOrRefine } from '../src/core/atoms/intake/preview-or-refine.js';
import { intakeRecommend } from '../src/core/atoms/intake/recommend.js';
import registry from '../atoms/registry.json' with { type: 'json' };

function makeProjectRoot() {
  return mkdtempSync(join(tmpdir(), 'evalid-intake-atoms-'));
}

function cleanupProjectRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('G1.intake.preview_or_refine', () => {
  test('writes intake_preview.json with mode, summary, answers and constraints', async () => {
    const projectRoot = makeProjectRoot();
    try {
      const result = await intakePreviewOrRefine(
        {
          mode: 'preview',
          summary: 'Add a retry budget to the dispatch loop',
          answers: { q1: 'yes' },
          constraints: { max_retries: 3 },
        },
        { projectRoot, changeId: 'chg-intake-1' },
      );

      assert.equal(result.ok, true);
      assert.equal(
        result.output_file,
        resolve(projectRoot, 'specs', 'changes', 'chg-intake-1', 'intake_preview.json'),
      );
      assert.ok(existsSync(result.output_file));
      const stored = readJson(result.output_file);
      assert.deepEqual(stored, result.payload);
      assert.equal(stored.version, 1);
      assert.equal(stored.mode, 'preview');
      assert.equal(stored.change_id, 'chg-intake-1');
      assert.equal(stored.summary, 'Add a retry budget to the dispatch loop');
      assert.deepEqual(stored.answers, { q1: 'yes' });
      assert.deepEqual(stored.constraints, { max_retries: 3 });
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  test('mode refine writes intake_refine.json and falls back to context title for summary', async () => {
    const projectRoot = makeProjectRoot();
    try {
      const result = await intakePreviewOrRefine(
        { mode: 'refine' },
        { projectRoot, changeId: 'chg-intake-2', input: { title: 'Refine the intake blueprint' } },
      );

      assert.equal(result.ok, true);
      assert.equal(
        result.output_file,
        resolve(projectRoot, 'specs', 'changes', 'chg-intake-2', 'intake_refine.json'),
      );
      const stored = readJson(result.output_file);
      assert.equal(stored.mode, 'refine');
      assert.equal(stored.summary, 'Refine the intake blueprint');
      assert.deepEqual(stored.answers, {});
      assert.deepEqual(stored.constraints, {});
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  test('defaults to preview mode and accepts change_id from input', async () => {
    const projectRoot = makeProjectRoot();
    try {
      const result = await intakePreviewOrRefine(
        { change_id: 'chg-intake-3', summary: 's' },
        { projectRoot },
      );

      assert.equal(result.ok, true);
      assert.equal(result.payload.mode, 'preview');
      assert.equal(result.payload.change_id, 'chg-intake-3');
      assert.ok(existsSync(resolve(projectRoot, 'specs', 'changes', 'chg-intake-3', 'intake_preview.json')));
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  test('throws when no change_id is provided', async () => {
    const projectRoot = makeProjectRoot();
    try {
      await assert.rejects(
        () => intakePreviewOrRefine({ mode: 'preview' }, { projectRoot }),
        /change_id is required for G1\.intake\.preview_or_refine/,
      );
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });
});

describe('G5.intake.recommend', () => {
  test('docs change recommends yolo without a coverage gate and writes both artifacts', async () => {
    const projectRoot = makeProjectRoot();
    try {
      const result = await intakeRecommend(
        { title: '更新 README 文档', description: '补充安装说明' },
        { projectRoot, changeId: 'chg-intake-4' },
      );

      assert.equal(result.ok, true);
      assert.equal(result.recommendation.recommended_track, 'yolo');
      assert.equal(result.recommendation.requires_coverage_gate, false);
      assert.equal(result.recommendation.requires_human_checkpoint, false);
      assert.equal(
        result.workflow_recommendation_file,
        resolve(projectRoot, 'specs', 'changes', 'chg-intake-4', 'workflow_recommendation.json'),
      );
      assert.ok(existsSync(result.workflow_recommendation_file));
      assert.deepEqual(readJson(result.workflow_recommendation_file), result.recommendation);
      // resolveEffectivePolicy runs with writeArtifact:true, so the policy file lands too.
      assert.ok(existsSync(resolve(projectRoot, 'specs', 'changes', 'chg-intake-4', 'policy_effective.json')));
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  test('payment change recommends corps with a human checkpoint', async () => {
    const projectRoot = makeProjectRoot();
    try {
      const result = await intakeRecommend(
        { title: '支付结算功能', description: '新增支付渠道', estimated_file_count: 12 },
        { projectRoot, changeId: 'chg-intake-5' },
      );

      assert.equal(result.ok, true);
      assert.equal(result.recommendation.recommended_track, 'corps');
      assert.equal(result.recommendation.profile.risk_level, 'critical');
      assert.equal(result.recommendation.requires_human_checkpoint, true);
      assert.equal(result.recommendation.requires_coverage_gate, true);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  test('throws when no change_id is provided', async () => {
    const projectRoot = makeProjectRoot();
    try {
      await assert.rejects(
        () => intakeRecommend({ title: 'x' }, { projectRoot }),
        /change_id is required for G5\.intake\.recommend/,
      );
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });
});

describe('intake atoms registry wiring', () => {
  test('G1 and G5 atoms are registered with the right module and export', () => {
    const atoms = registry.atoms;
    assert.equal(atoms['G1.intake.preview_or_refine'].module, 'src/core/atoms/intake/preview-or-refine.js');
    assert.equal(atoms['G1.intake.preview_or_refine'].export, 'intakePreviewOrRefine');
    assert.equal(atoms['G5.intake.recommend'].module, 'src/core/atoms/intake/recommend.js');
    assert.equal(atoms['G5.intake.recommend'].export, 'intakeRecommend');
  });
});
