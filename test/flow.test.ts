// End-to-end tests through the HTTP API, against the simulated casino.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, call, openSession, reconcile } from './harness.ts';
import { sha256 } from '../src/fair/fair.ts';

const picks = [1, 5, 9, 13, 17];

test('a round: bet taken, numbers drawn, win paid, both ledgers agree', async () => {
  const h = await setup();
  try {
    const s = await openSession(h, 'alice', 100);
    assert.equal(s.balance, 100);
    let won = 0;
    for (let i = 0; i < 40; i++) {
      const r = await call(h.base, 'POST', '/api/play', { requestId: `r${i}`, bet: 1, params: { picks } }, s.sessionToken);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.state, 'settled');
      assert.equal(r.body.drawn.length, 10);
      assert.equal(r.body.payoutPending, false);
      won += r.body.win;
    }
    const { problems, stats } = await reconcile(h);
    assert.deepEqual(problems, []);
    assert.equal(stats.settled, 40);
    assert.equal(h.casino.players.get('alice')?.balanceCents, Math.round((100 - 40 + won) * 100));
  } finally { await h.close(); }
});

test('the same requestId twice = one bet, same answer', async () => {
  const h = await setup();
  try {
    const s = await openSession(h, 'bob', 50);
    const a = await call(h.base, 'POST', '/api/play', { requestId: 'same', bet: 2, params: { picks } }, s.sessionToken);
    const b = await call(h.base, 'POST', '/api/play', { requestId: 'same', bet: 2, params: { picks } }, s.sessionToken);
    assert.equal(a.body.roundId, b.body.roundId);
    assert.deepEqual(a.body.drawn, b.body.drawn);
    assert.equal([...h.casino.txs.values()].filter(t => t.type === 'withdraw').length, 1);
    assert.deepEqual((await reconcile(h)).problems, []);
  } finally { await h.close(); }
});

test('insufficient funds: bet refused, nothing moves, round rejected', async () => {
  const h = await setup();
  try {
    const s = await openSession(h, 'carol', 0.5);
    const r = await call(h.base, 'POST', '/api/play', { requestId: 'x', bet: 1, params: { picks } }, s.sessionToken);
    assert.equal(r.status, 402);
    assert.equal(r.body.error.code, 'INSUFFICIENT_FUNDS');
    assert.equal(h.casino.players.get('carol')?.balanceCents, 50);
    const { problems, stats } = await reconcile(h);
    assert.deepEqual(problems, []);
    assert.equal(stats.rejected, 1);
  } finally { await h.close(); }
});

test('bet applied at the casino but every reply lost: refunded by cancel, never double-taken', async () => {
  const h = await setup({ faults: { errorAfter: 1 } });
  try {
    const s = await openSession(h, 'dave', 20);
    const r = await call(h.base, 'POST', '/api/play', { requestId: 'lost', bet: 5, params: { picks } }, s.sessionToken);
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'BET_NOT_PLACED');
    assert.equal(h.casino.players.get('dave')?.balanceCents, 1500, 'taken once despite 3 attempts (same transaction id)');
    h.casino.faults.errorAfter = 0;
    await h.rgs.drain();
    assert.equal(h.casino.players.get('dave')?.balanceCents, 2000, 'refunded');
    const { problems, stats } = await reconcile(h);
    assert.deepEqual(problems, []);
    assert.equal(stats.cancelled, 1);
  } finally { await h.close(); }
});

test('win payout fails: the round result stands and the worker pays it later', async () => {
  // Withdraw succeeds; then the casino goes down before the payout.
  let calls = 0;
  const h = await setup({ random: () => 1 }); // no random faults
  try {
    const s = await openSession(h, 'erin', 100);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).endsWith('/transaction') && JSON.parse(init.body).type === 'deposit' && calls++ < 3) throw new TypeError('network down');
      return realFetch(url, init);
    }) as typeof fetch;
    try {
      const r = await call(h.base, 'POST', '/api/play', { requestId: 'p', bet: 1, params: { picks: [1] } }, s.sessionToken);
      assert.equal(r.status, 200);
      assert.equal(r.body.state, 'settling');
      assert.equal(r.body.payoutPending, true);
      await h.rgs.drain();
    } finally { globalThis.fetch = realFetch; }
    const { problems, stats } = await reconcile(h);
    assert.deepEqual(problems, []);
    assert.equal(stats.settled, 1);
  } finally { await h.close(); }
});

test('crash during the bet call: the casino took it, we never heard back; recovery refunds it', async () => {
  const h = await setup();
  try {
    const s = await openSession(h, 'frank', 100);
    const realFetch = globalThis.fetch;
    // The "process dies" mid-call: the request reaches the casino, the reply never comes back to us.
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).endsWith('/transaction')) { realFetch(url, init).catch(() => {}); return new Promise(() => {}); }
      return realFetch(url, init);
    }) as typeof fetch;
    void call(h.base, 'POST', '/api/play', { requestId: 'crash', bet: 4, params: { picks } }, s.sessionToken).catch(() => {});
    for (let i = 0; i < 50 && h.casino.txs.size === 0; i++) await new Promise(r => setTimeout(r, 20));
    globalThis.fetch = realFetch;
    assert.equal(h.casino.players.get('frank')?.balanceCents, 9600, 'casino took the bet');
    await h.db.query(`UPDATE wallet_tx SET created_at = now() - interval '1 hour' WHERE kind = 'withdraw'`); // past the stale window
    await h.rgs.drain();
    assert.equal(h.casino.players.get('frank')?.balanceCents, 10000, 'refunded');
    const { problems, stats } = await reconcile(h);
    assert.deepEqual(problems, []);
    assert.equal(stats.cancelled, 1);
  } finally { await h.close(); }
});

test('crash between taking the bet and queueing the payout: recovery pays the round', async () => {
  const h = await setup();
  try {
    const s = await openSession(h, 'gus', 100);
    const r = await call(h.base, 'POST', '/api/play', { requestId: 'o', bet: 1, params: { picks: [7] } }, s.sessionToken);
    // Rewind both sides to "bet taken, payout never queued": remove our deposit and the casino's.
    const dep = [...h.casino.txs.values()].find(t => t.type === 'deposit');
    if (dep) { h.casino.txs.delete(dep.id); const p = h.casino.players.get('gus'); if (p) p.balanceCents -= dep.cents; }
    await h.db.query(`DELETE FROM wallet_tx WHERE kind = 'deposit'`);
    await h.db.query(`UPDATE rounds SET state = 'debited', updated_at = now() - interval '1 hour'`);
    await h.rgs.drain();
    const { problems, stats } = await reconcile(h);
    assert.deepEqual(problems, []);
    assert.equal(stats.settled, 1);
    assert.equal(h.casino.players.get('gus')?.balanceCents, Math.round((99 + r.body.win) * 100));
  } finally { await h.close(); }
});

test('provably fair: the revealed seed matches the commitment and reproduces every round', async () => {
  const h = await setup();
  try {
    const s = await openSession(h, 'gina', 100);
    const rounds = [];
    for (let i = 0; i < 5; i++) rounds.push((await call(h.base, 'POST', '/api/play', { requestId: `f${i}`, bet: 0.5, params: { picks } }, s.sessionToken)).body);
    const rot = await call(h.base, 'POST', '/api/fairness/rotate', { clientSeed: 'my-own-seed' }, s.sessionToken);
    assert.equal(rot.body.revealed.serverSeedHash, s.fairness.serverSeedHash);
    assert.equal(sha256(rot.body.revealed.serverSeed), s.fairness.serverSeedHash);
    for (const r of rounds) {
      const v = await call(h.base, 'POST', '/api/fairness/verify-keno', { serverSeed: rot.body.revealed.serverSeed, clientSeed: r.fairness.clientSeed, nonce: r.fairness.nonce, picks });
      assert.deepEqual(v.body.drawn, r.drawn);
      assert.equal(v.body.multiplier, r.multiplier);
    }
    assert.equal(rot.body.next.clientSeed, 'my-own-seed');
  } finally { await h.close(); }
});

test('bad input and bad sessions are refused', async () => {
  const h = await setup();
  try {
    const s = await openSession(h, 'hal', 100);
    const t = s.sessionToken;
    assert.equal((await call(h.base, 'POST', '/api/play', { requestId: 'a', bet: 1.234, params: { picks } }, t)).status, 400);
    assert.equal((await call(h.base, 'POST', '/api/play', { requestId: 'b', bet: 0.01, params: { picks } }, t)).body.error.code, 'BET_OUT_OF_RANGE');
    assert.equal((await call(h.base, 'POST', '/api/play', { requestId: 'c', bet: 1, params: { picks: [1, 1] } }, t)).status, 400);
    assert.equal((await call(h.base, 'POST', '/api/play', { requestId: 'd', bet: 1, params: { picks } }, 'nope')).status, 401);
    assert.equal((await call(h.base, 'POST', '/api/session', { operator: 'simcasino', key: 'used-or-wrong', game: 'keno' })).status, 401);
    assert.equal((await call(h.base, 'POST', '/api/session', { operator: 'nobody', key: 'k', game: 'keno' })).status, 404);
    assert.equal(h.casino.txs.size, 0);
  } finally { await h.close(); }
});

test('game screen and rules: served with security headers; demo launch absent outside demo mode', async () => {
  const h = await setup();
  try {
    const page = await fetch(h.base + '/keno');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.match(await page.text(), /<script src="\/keno.js">/);
    assert.equal((await fetch(h.base + '/keno.js')).status, 200);
    const rules = await call(h.base, 'GET', '/api/games/keno');
    assert.equal(rules.body.numbers, 40);
    assert.equal(rules.body.paytable['5'].length, 6);
    assert.equal((await call(h.base, 'POST', '/demo/launch', {})).status, 404);
    assert.equal((await fetch(h.base + '/../package.json')).status, 404);
  } finally { await h.close(); }
});
