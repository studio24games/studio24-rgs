import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChaos } from '../scripts/chaos.ts';

test('chaos: 300 concurrent rounds with ~18% wallet faults reconcile exactly', async () => {
  const r = await runChaos(10, 30, 0.05);
  assert.deepEqual(r.problems, []);
  assert.equal(r.stats.rounds, 300);
  assert.equal((r.stats.settled ?? 0) + (r.stats.cancelled ?? 0) + (r.stats.rejected ?? 0), 300);
});
