import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { FairRng, sha256, newServerSeed } from '../src/fair/fair.ts';
import { fromWire, toWire, winFor } from '../src/money.ts';
import { exactRtp, hitProbabilities } from '../src/games/keno-maths.ts';
import { KENO_PAYTABLE, KENO_TARGET_RTP } from '../src/games/keno-paytable.ts';
import { drawNumbers, parseKenoParams, playKeno } from '../src/games/keno.ts';
import { encrypt, decrypt, pseudonym } from '../src/crypto.ts';

test('money: wire amounts are whole cents; wins round down', () => {
  assert.equal(fromWire(1.25), 1_250_000);
  assert.equal(toWire(1_250_000), 1.25);
  assert.equal(fromWire(0.1), 100_000);
  assert.throws(() => fromWire(1.234));
  assert.throws(() => fromWire(-1));
  assert.throws(() => fromWire('1'));
  assert.equal(winFor(fromWire(0.33), 388), fromWire(1.28)); // 0.33 x 3.88 = 1.2804 -> 1.28
  assert.equal(winFor(fromWire(0.1), 1), 0);                 // 0.001 -> 0.00
});

test('fairness: same seeds and nonce give the same numbers; any change gives different ones', () => {
  const { seed, hash } = newServerSeed();
  assert.equal(sha256(seed), hash);
  const a = drawNumbers(new FairRng(seed, 'player', 7)), b = drawNumbers(new FairRng(seed, 'player', 7));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, drawNumbers(new FairRng(seed, 'player', 8)));
  assert.notDeepEqual(a, drawNumbers(new FairRng(seed, 'player2', 7)));
  // A fixed vector, so any change to the algorithm is caught (players' old rounds must stay verifiable).
  assert.deepEqual(drawNumbers(new FairRng('a'.repeat(64), 'studio24', 0)), [23,19,3,33,28,12,16,20,26,18]);
});

test('fairness: draws are 10 distinct numbers from 1-40, each number equally likely (chi-square)', () => {
  const counts = new Array(41).fill(0);
  const N = 40_000, seed = randomBytes(32).toString('hex');
  for (let i = 0; i < N; i++) {
    const d = drawNumbers(new FairRng(seed, 'c', i));
    assert.equal(new Set(d).size, 10);
    for (const x of d) { assert.ok(x >= 1 && x <= 40); counts[x]++; }
  }
  const expected = (N * 10) / 40;
  const chi = counts.slice(1).reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
  assert.ok(chi < 80, `chi-square ${chi.toFixed(1)} with 39 df is too high`); // p ~ 1e-4
});

test('keno maths: every paytable row is within 0.03 points of the 97% target and pays rise with hits', () => {
  for (let n = 1; n <= 10; n++) {
    const row = KENO_PAYTABLE[n] as readonly number[];
    const rtp = exactRtp(n, row);
    assert.ok(rtp <= KENO_TARGET_RTP + 1e-12 && rtp >= KENO_TARGET_RTP - 0.0003, `picks ${n}: RTP ${rtp}`);
    const pays = row.filter(x => x > 0);
    assert.ok(pays.every((x, i) => i === 0 || x > (pays[i - 1] as number)), `picks ${n}: pays must rise`);
    assert.ok(Math.abs(hitProbabilities(n).reduce((s, p) => s + p, 0) - 1) < 1e-12);
  }
});

test('keno simulation: hit counts match the exact distribution (5 picks, 200k rounds)', () => {
  const seed = randomBytes(32).toString('hex'), N = 200_000;
  const params = parseKenoParams({ picks: [3, 11, 19, 27, 35] });
  const seen = new Array(6).fill(0); let paid = 0;
  for (let i = 0; i < N; i++) { const o = playKeno(params, new FairRng(seed, 'sim', i)); seen[o.hits.length]++; paid += o.multiplier / 100; }
  const p = hitProbabilities(5);
  for (let h = 0; h <= 5; h++) {
    const exp = N * (p[h] as number), sd = Math.sqrt(N * (p[h] as number) * (1 - (p[h] as number)));
    assert.ok(Math.abs(seen[h] - exp) < 5 * sd + 1, `hits ${h}: saw ${seen[h]}, expected ${exp.toFixed(0)}`);
  }
  // RTP is noisy at this sample size (the top prize is 1 in 3,000+), so only a wide sanity band.
  assert.ok(paid / N > 0.85 && paid / N < 1.1, `simulated RTP ${(paid / N).toFixed(3)}`);
});

test('keno params are validated', () => {
  assert.throws(() => parseKenoParams({ picks: [] }));
  assert.throws(() => parseKenoParams({ picks: [1, 1] }));
  assert.throws(() => parseKenoParams({ picks: [0] }));
  assert.throws(() => parseKenoParams({ picks: [41] }));
  assert.throws(() => parseKenoParams({ picks: Array.from({ length: 11 }, (_, i) => i + 1) }));
  assert.deepEqual(parseKenoParams({ picks: [9, 2] }).picks, [2, 9]);
});

test('player ids: encrypted at rest; pseudonyms differ per casino and never reveal the id', () => {
  const key = randomBytes(32).toString('hex');
  const blob = encrypt('casino-player-42', key);
  assert.ok(!blob.includes('casino-player-42'));
  assert.equal(decrypt(blob, key), 'casino-player-42');
  assert.notEqual(pseudonym('p1', 'casinoA'), pseudonym('p1', 'casinoB'));
  assert.equal(pseudonym('p1', 'casinoA'), pseudonym('p1', 'casinoA'));
});
