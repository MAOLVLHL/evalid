import test from 'node:test';
import assert from 'node:assert/strict';
import { createConcurrencyPolicy } from '../src/core/concurrency-policy.js';

test('defaults to weighted mode, three agents, and workflow source', () => {
  const policy = createConcurrencyPolicy();
  assert.equal(policy.mode, 'weighted');
  assert.equal(policy.maxAgents, 3);
  assert.equal(policy.source, 'workflow');
});

test('uses configured maximum and floors fractional values', () => {
  assert.equal(createConcurrencyPolicy({ workflow: { parallel: { max_agents: 5 } } }).maxAgents, 5);
  assert.equal(createConcurrencyPolicy({ workflow: { parallel: { max_agents: 2.7 } } }).maxAgents, 2);
});

for (const value of [0, -1, NaN, 'abc', Infinity]) {
  test(`invalid workflow maximum ${String(value)} falls back to three`, () => {
    assert.equal(createConcurrencyPolicy({ workflow: { parallel: { max_agents: value } } }).maxAgents, 3);
  });
}

test('override takes precedence and marks its source', () => {
  const policy = createConcurrencyPolicy({ workflow: { parallel: { max_agents: 5 } }, maxParallelAgentsOverride: 2 });
  assert.equal(policy.maxAgents, 2);
  assert.equal(policy.source, 'mission_override');
});

test('invalid override falls back to workflow maximum while retaining override source', () => {
  const policy = createConcurrencyPolicy({ workflow: { parallel: { max_agents: 5 } }, maxParallelAgentsOverride: 0 });
  assert.equal(policy.maxAgents, 5);
  assert.equal(policy.source, 'mission_override');
});

test('atom weight overrides registry weight', () => {
  const policy = createConcurrencyPolicy();
  const registry = { atoms: { build: { parallel_weight: 4 } } };
  assert.equal(policy.weightFor({ id: 'build', parallel_weight: 2 }, registry), 2);
  assert.equal(policy.weightFor({ id: 'build' }, registry), 4);
  assert.equal(policy.weightFor({ id: 'missing' }, registry), 1);
});

for (const weight of [0, -3]) {
  test(`invalid atom weight ${weight} falls back to one`, () => {
    assert.equal(createConcurrencyPolicy().weightFor({ parallel_weight: weight }), 1);
  });
}

test('fixed mode charges one regardless of weight', () => {
  const policy = createConcurrencyPolicy({ workflow: { parallel: { policy: 'fixed', max_agents: 3 } } });
  assert.equal(policy.mode, 'fixed');
  assert.equal(policy.chargeFor({ parallel_weight: 9 }), 1);
});

test('weighted mode caps charge at maximum agents', () => {
  const policy = createConcurrencyPolicy();
  assert.equal(policy.chargeFor({ parallel_weight: 5 }), 3);
  assert.equal(policy.chargeFor({ parallel_weight: 2 }), 2);
});
