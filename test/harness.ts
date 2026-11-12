// Test harness: a fresh database, a simulated casino, and an RGS wired to it. Plus a full reconciliation of
// the casino's ledger against the RGS's records.
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { createDb, migrate, type Db } from '../src/db/db.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { Rgs } from '../src/rgs.ts';
import { createApi } from '../src/api/server.ts';
import { startSimCasino, type Faults, type SimCasino } from '../sim/casino.ts';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://rgs:rgs@127.0.0.1:5432/rgs_test';

export interface Harness { db: Db; rgs: Rgs; casino: SimCasino; api: Server; base: string; config: Config; close(): Promise<void> }

export async function setup(o: { faults?: Faults; config?: Partial<Config>; random?: () => number } = {}): Promise<Harness> {
  const db = createDb(TEST_DB);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  const casino = await startSimCasino({ faults: o.faults ?? {}, ...(o.random ? { random: o.random } : {}) });
  await db.query(`INSERT INTO operators (id, wallet_url, hmac_secret, pseudonym_key) VALUES ('simcasino', $1, $2, $3)`,
    [casino.url, casino.secret, randomBytes(16).toString('hex')]);
  const config = { ...loadConfig({ DATA_KEY: randomBytes(32).toString('hex'), WALLET_TIMEOUT_MS: '1000' }), ...o.config };
  let rgs: Rgs;
  try { rgs = new Rgs({ db, config, backoffBaseMs: 10, staleAfterMs: 4500 }); }
  catch (e) { await casino.close(); await db.end(); throw e; }
  const api = createApi(rgs);
  await new Promise<void>(r => api.listen(0, '127.0.0.1', r));
  const addr = api.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  return {
    db, rgs, casino, api, base, config,
    close: async () => { await new Promise<void>(r => { api.closeAllConnections(); api.close(() => r()); }); await casino.close(); await db.end(); },
  };
}

export async function call(base: string, method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

export async function openSession(h: Harness, nativeId: string, balance: number) {
  const key = h.casino.addPlayer(nativeId, balance);
  const r = await call(h.base, 'POST', '/api/session', { operator: 'simcasino', key, game: 'keno' });
  if (r.status !== 200) throw new Error(`session: ${JSON.stringify(r.body)}`);
  return r.body as { sessionToken: string; balance: number; fairness: { serverSeedHash: string; clientSeed: string; nonce: number } };
}

/**
 * Reconcile: every money movement at the casino must match the RGS's records exactly, and every player's
 * casino balance must equal start - bets + wins of their settled rounds. Returns a list of problems (empty = clean).
 */
export async function reconcile(h: Harness): Promise<{ problems: string[]; stats: Record<string, number> }> {
  const problems: string[] = [];
  const rounds = (await h.db.query<{ id: string; state: string; bet: number; win: number; player_ref: string; native: string }>(
    `SELECT r.id, r.state, r.bet, r.win, r.player_ref, s.native_id_enc AS native FROM rounds r JOIN sessions s ON s.id = r.session_id`)).rows;
  const txs = (await h.db.query<{ id: string; round_id: string; kind: string; amount: number; state: string }>('SELECT * FROM wallet_tx')).rows;
  const open = txs.filter(t => t.state === 'pending');
  if (open.length) problems.push(`${open.length} wallet transactions still pending`);
  const byRound = new Map<string, typeof txs>();
  for (const t of txs) byRound.set(t.round_id, [...(byRound.get(t.round_id) ?? []), t]);
  const casinoByRound = new Map<string, import('../sim/casino.ts').LedgerTx[]>();
  for (const t of h.casino.txs.values()) casinoByRound.set(t.roundId, [...(casinoByRound.get(t.roundId) ?? []), t]);

  const stats: Record<string, number> = { rounds: rounds.length, settled: 0, rejected: 0, cancelled: 0, other: 0 };
  const expectedDelta = new Map<string, number>(); // nativeId -> cents
  const { decrypt } = await import('../src/crypto.ts');
  for (const r of rounds) {
    const native = decrypt(r.native, h.config.dataKey);
    const atCasino = casinoByRound.get(r.id) ?? [];
    const w = atCasino.filter(t => t.type === 'withdraw'), d = atCasino.filter(t => t.type === 'deposit');
    const ours = byRound.get(r.id) ?? [];
    const ourW = ours.find(t => t.kind === 'withdraw'), ourD = ours.find(t => t.kind === 'deposit');
    const betC = r.bet / 10_000, winC = r.win / 10_000;
    if (r.state === 'settled') {
      stats.settled = (stats.settled ?? 0) + 1;
      if (w.length !== 1 || w[0]?.cancelled || w[0]?.cents !== betC || w[0]?.id !== ourW?.id) problems.push(`round ${r.id} settled but casino withdraw is wrong: ${JSON.stringify(w)}`);
      if (d.length !== 1 || d[0]?.cents !== winC || d[0]?.id !== ourD?.id || !d[0]?.roundFinished) problems.push(`round ${r.id} settled but casino deposit is wrong: ${JSON.stringify(d)}`);
      expectedDelta.set(native, (expectedDelta.get(native) ?? 0) - betC + winC);
    } else if (r.state === 'rejected' || r.state === 'cancelled') {
      stats[r.state] = (stats[r.state] ?? 0) + 1;
      if (w.some(t => !t.cancelled)) problems.push(`round ${r.id} ${r.state} but the casino kept the bet`);
      if (d.length) problems.push(`round ${r.id} ${r.state} but the casino paid a win`);
    } else { stats.other = (stats.other ?? 0) + 1; problems.push(`round ${r.id} stuck in state ${r.state}`); }
  }
  for (const [roundId] of casinoByRound) if (!rounds.some(r => r.id === roundId)) problems.push(`casino has transactions for unknown round ${roundId}`);
  for (const p of h.casino.players.values()) {
    const want = p.startCents + (expectedDelta.get(p.nativeId) ?? 0);
    if (p.balanceCents !== want) problems.push(`player ${p.nativeId}: casino balance ${p.balanceCents / 100}, expected ${want / 100}`);
  }
  return { problems, stats };
}
