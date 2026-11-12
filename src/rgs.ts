// The RGS core: sessions, rounds, the wallet money flow and the recovery worker.
//
// Money rules (S24 wallet API, "Flow" section):
//  - One withdraw per bet, retried with the SAME transactionId. If its outcome stays unknown, it is cancelled
//    (refunded), never guessed. INSUFFICIENT_FUNDS, LOSS_LIMIT and TRANSACTION_FAILED mean nothing was taken:
//    no cancel. Any other refusal also gets a cancel, which is harmless if nothing was taken.
//  - Winnings are a deposit that is retried until the casino confirms it (durable outbox in wallet_tx).
//  - Cancels are retried until confirmed or the casino says TRANSACTION_NOT_FOUND.
//  - The round's outcome is drawn and saved BEFORE any money moves, so a retry or a crash can never redraw it.
//  - Every state change is conditional (WHERE state = ...), so the inline path and the worker can't both act.
import { randomUUID } from 'node:crypto';
import type { Db, Tx } from './db/db.ts';
import { inTx } from './db/db.ts';
import type { Config } from './config.ts';
import { fromWire, toWire, winFor, MICRO } from './money.ts';
import { FairRng, isValidClientSeed, newClientSeed, newServerSeed, sha256 } from './fair/fair.ts';
import { KENO_ID, KENO_MAX_MULTIPLIER, parseKenoParams, playKeno } from './games/keno.ts';
import type { KenoOutcome, KenoParams } from './games/keno.ts';
import { WalletClient, WalletError } from './wallet/client.ts';
import { decrypt, encrypt, hashToken, newToken, pseudonym } from './crypto.ts';

export class AppError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

interface OperatorRow { id: string; wallet_url: string; hmac_secret: string; pseudonym_key: string }
interface SessionRow {
  id: string; operator_id: string; player_ref: string; native_id_enc: string; wallet_token: string; game_id: string; currency: string;
  server_seed: string; server_seed_hash: string; client_seed: string; nonce: number;
}
interface RoundRow {
  id: string; session_id: string; state: string; bet: number; win: number | null; currency: string; game_id: string;
  params: KenoParams; outcome: KenoOutcome | null; server_seed_hash: string; client_seed: string; nonce: number; reject_code: string | null;
}

const NO_CANCEL_CODES = new Set(['INSUFFICIENT_FUNDS', 'LOSS_LIMIT', 'TRANSACTION_FAILED']);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface RgsOptions { db: Db; config: Config; backoffBaseMs?: number; staleAfterMs?: number; log?: (msg: string) => void }

export class Rgs {
  private readonly db: Db;
  private readonly config: Config;
  private readonly clients = new Map<string, WalletClient>();
  private readonly backoffBaseMs: number;
  private readonly staleAfterMs: number;
  private readonly log: (msg: string) => void;

  constructor(o: RgsOptions) {
    this.db = o.db; this.config = o.config;
    this.backoffBaseMs = o.backoffBaseMs ?? 1000;
    this.staleAfterMs = o.staleAfterMs ?? 30_000;
    this.log = o.log ?? (() => {});
    // The worker must never "abandon" a withdraw the request path is still retrying.
    const worstInline = this.config.withdrawAttempts * (this.config.walletTimeoutMs + 100 * this.config.withdrawAttempts);
    if (this.staleAfterMs <= worstInline) throw new Error(`staleAfterMs (${this.staleAfterMs}) must exceed the longest withdraw retry time (${worstInline} ms)`);
  }

  // ---------------------------------------------------------------- operators and sessions
  private async operator(id: string, q: Db | Tx = this.db): Promise<OperatorRow> {
    const r = await q.query<OperatorRow>('SELECT id, wallet_url, hmac_secret, pseudonym_key FROM operators WHERE id = $1 AND enabled', [id]);
    const op = r.rows[0];
    if (!op) throw new AppError(404, 'UNKNOWN_OPERATOR', 'unknown operator');
    return op;
  }

  private client(op: OperatorRow): WalletClient {
    const key = `${op.id}|${op.wallet_url}|${op.hmac_secret}`;
    let c = this.clients.get(key);
    if (!c) { c = new WalletClient({ baseUrl: op.wallet_url, secret: op.hmac_secret, timeoutMs: this.config.walletTimeoutMs }); this.clients.set(key, c); }
    return c;
  }

  async openSession(a: { operator: unknown; key: unknown; game: unknown }) {
    if (typeof a.operator !== 'string' || typeof a.key !== 'string' || a.key.length > 512) throw new AppError(400, 'BAD_REQUEST', 'operator and key are required');
    if (a.game !== KENO_ID) throw new AppError(404, 'UNKNOWN_GAME', 'unknown game');
    const op = await this.operator(a.operator);
    let auth;
    try { auth = await this.client(op).authenticate({ operator: op.id, key: a.key, game: a.game }); }
    catch (e) { throw new AppError(401, 'AUTH_FAILED', e instanceof WalletError ? e.code : 'authentication failed'); }
    const token = newToken();
    const seed = newServerSeed();
    const clientSeed = newClientSeed();
    await this.db.query(
      `INSERT INTO sessions (id, token_hash, operator_id, player_ref, native_id_enc, wallet_token, game_id, currency, server_seed, server_seed_hash, client_seed, nonce, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0, now() + make_interval(hours => $12))`,
      [randomUUID(), hashToken(token), op.id, pseudonym(auth.nativeId, op.pseudonym_key), encrypt(auth.nativeId, this.config.dataKey), auth.token,
        a.game, auth.currency, seed.seed, seed.hash, clientSeed, this.config.sessionHours]);
    return {
      sessionToken: token, game: a.game, currency: auth.currency, balance: auth.balance,
      limits: { minBet: this.config.minBet, maxBet: this.config.maxBet, maxWin: this.config.maxWin },
      fairness: { serverSeedHash: seed.hash, clientSeed, nonce: 0 },
    };
  }

  private async session(token: unknown, q: Db | Tx = this.db, lock = false): Promise<SessionRow> {
    if (typeof token !== 'string' || !token) throw new AppError(401, 'SESSION_INVALID', 'no session');
    const r = await q.query<SessionRow>(
      `SELECT * FROM sessions WHERE token_hash = $1 AND expires_at > now()${lock ? ' FOR UPDATE' : ''}`, [hashToken(token)]);
    const s = r.rows[0];
    if (!s) throw new AppError(401, 'SESSION_INVALID', 'session expired or unknown');
    return s;
  }

  // ---------------------------------------------------------------- playing a round
  async play(token: unknown, body: { requestId?: unknown; bet?: unknown; params?: unknown }) {
    const requestId = body.requestId;
    if (typeof requestId !== 'string' || !/^[\w-]{1,64}$/.test(requestId)) throw new AppError(400, 'BAD_REQUEST', 'requestId: 1-64 letters, digits, _ or -');
    let bet: number, params: KenoParams;
    try { bet = fromWire(body.bet); params = parseKenoParams(body.params); }
    catch (e) { throw new AppError(400, 'BAD_REQUEST', (e as Error).message); }
    if (bet < fromWire(this.config.minBet) || bet > fromWire(this.config.maxBet)) throw new AppError(400, 'BET_OUT_OF_RANGE', `bet must be ${this.config.minBet} to ${this.config.maxBet}`);
    const maxWin = fromWire(this.config.maxWin);
    if (winFor(bet, KENO_MAX_MULTIPLIER) > maxWin) throw new AppError(400, 'BET_TOO_HIGH', 'the top prize at this bet would exceed the maximum win');

    // 1. Draw and record the round, and the withdraw we are about to ask for, in one transaction.
    const prep = await inTx(this.db, async tx => {
      const s = await this.session(token, tx, true);
      const prior = await tx.query<RoundRow>('SELECT * FROM rounds WHERE session_id = $1 AND request_id = $2', [s.id, requestId]);
      const replay = prior.rows[0];
      if (replay) return { replay };
      const nonce = Number(s.nonce);
      const outcome = playKeno(params, new FairRng(s.server_seed, s.client_seed, nonce));
      const win = Math.min(winFor(bet, outcome.multiplier), maxWin);
      const roundId = randomUUID(), withdrawId = randomUUID();
      await tx.query('UPDATE sessions SET nonce = nonce + 1 WHERE id = $1', [s.id]);
      await tx.query(
        `INSERT INTO rounds (id, session_id, request_id, operator_id, player_ref, game_id, currency, bet, win, params, outcome, server_seed_hash, client_seed, nonce, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending_debit')`,
        [roundId, s.id, requestId, s.operator_id, s.player_ref, s.game_id, s.currency, bet, win, JSON.stringify(params), JSON.stringify(outcome), s.server_seed_hash, s.client_seed, nonce]);
      await tx.query(`INSERT INTO wallet_tx (id, round_id, kind, amount, state) VALUES ($1,$2,'withdraw',$3,'pending')`, [withdrawId, roundId, bet]);
      return { session: s, roundId, withdrawId, bet, win };
    });
    if (prep.replay) return this.view(prep.replay); // same requestId again: same answer, no new money movement

    const s = prep.session;
    const op = await this.operator(s.operator_id);
    const wallet = this.client(op);
    const nativeId = decrypt(s.native_id_enc, this.config.dataKey);

    // 2. Take the bet.
    let balance: number | null = null;
    for (let attempt = 1; ; attempt++) {
      try {
        balance = await wallet.transaction(s.wallet_token, { nativeId, transactionId: prep.withdrawId, type: 'withdraw', amount: toWire(prep.bet), game: s.game_id, roundId: prep.roundId });
        const ok = await inTx(this.db, async tx => {
          const u = await tx.query(`UPDATE wallet_tx SET state = 'done', done_at = now(), attempts = attempts + 1, balance_after = $2 WHERE id = $1 AND state = 'pending'`, [prep.withdrawId, fromWire(balance)]);
          if (u.rowCount !== 1) return false;
          await tx.query(`UPDATE rounds SET state = 'debited', updated_at = now() WHERE id = $1 AND state = 'pending_debit'`, [prep.roundId]);
          return true;
        });
        if (!ok) throw new AppError(503, 'BET_CANCELLED', 'the bet timed out and is being refunded');
        break;
      } catch (e) {
        if (!(e instanceof WalletError)) throw e;
        await this.db.query('UPDATE wallet_tx SET attempts = attempts + 1, last_error = $2 WHERE id = $1', [prep.withdrawId, e.message.slice(0, 300)]);
        if (e.kind === 'refused') {
          await this.failWithdraw(prep.roundId, prep.withdrawId, e.code, !NO_CANCEL_CODES.has(e.code));
          throw new AppError(e.code === 'INSUFFICIENT_FUNDS' ? 402 : 403, e.code, 'the casino refused the bet');
        }
        if (attempt >= this.config.withdrawAttempts) {
          await this.failWithdraw(prep.roundId, prep.withdrawId, 'UNKNOWN_AFTER_RETRIES', true);
          throw new AppError(503, 'BET_NOT_PLACED', 'the casino did not confirm the bet; it is being refunded');
        }
        await sleep(100 * attempt);
      }
    }

    // 3. Pay the result (also for a zero win: it closes the round at the casino).
    const depositId = randomUUID();
    const queued = await inTx(this.db, async tx => {
      const u = await tx.query(`UPDATE rounds SET state = 'settling', updated_at = now() WHERE id = $1 AND state = 'debited'`, [prep.roundId]);
      if (u.rowCount !== 1) return false;
      await tx.query(`INSERT INTO wallet_tx (id, round_id, kind, amount, state, next_attempt_at) VALUES ($1,$2,'deposit',$3,'pending', now() + interval '15 seconds')`, [depositId, prep.roundId, prep.win]);
      return true;
    });
    let payoutPending = true;
    if (queued) payoutPending = !(await this.tryDeposit(depositId, prep.roundId, wallet, s.wallet_token, nativeId, s.game_id, prep.win));
    const r = await this.db.query<RoundRow>('SELECT * FROM rounds WHERE id = $1', [prep.roundId]);
    const latest = await this.db.query<{ balance_after: number | null }>(
      `SELECT balance_after FROM wallet_tx WHERE round_id = $1 AND state = 'done' ORDER BY done_at DESC LIMIT 1`, [prep.roundId]);
    const lastBalance = latest.rows[0]?.balance_after ?? null;
    return { ...this.view(r.rows[0] as RoundRow), balance: lastBalance === null ? null : toWire(lastBalance), payoutPending };
  }

  /** Withdraw refused or unknown: close it, and queue a cancel when money might have moved. */
  private async failWithdraw(roundId: string, withdrawId: string, code: string, cancel: boolean): Promise<void> {
    await inTx(this.db, async tx => {
      const u = await tx.query(`UPDATE wallet_tx SET state = 'failed', last_error = coalesce(last_error, $2) WHERE id = $1 AND state = 'pending'`, [withdrawId, code]);
      if (u.rowCount !== 1) return; // the worker already took over
      if (cancel) {
        await tx.query(`UPDATE rounds SET state = 'cancelling', reject_code = $2, updated_at = now() WHERE id = $1 AND state = 'pending_debit'`, [roundId, code]);
        // The cancel REQUEST names the withdraw's transactionId (looked up in processDue); this row just tracks it.
        await tx.query(`INSERT INTO wallet_tx (id, round_id, kind, amount, state) VALUES ($1,$2,'cancel',0,'pending') ON CONFLICT (round_id, kind) DO NOTHING`, [randomUUID(), roundId]);
      } else {
        await tx.query(`UPDATE rounds SET state = 'rejected', reject_code = $2, updated_at = now() WHERE id = $1 AND state = 'pending_debit'`, [roundId, code]);
      }
    });
  }

  private async tryDeposit(depositId: string, roundId: string, wallet: WalletClient, walletToken: string, nativeId: string, game: string, win: number): Promise<boolean> {
    try {
      const bal = await wallet.transaction(walletToken, { nativeId, transactionId: depositId, type: 'deposit', amount: toWire(win), game, roundId, roundFinished: true });
      return await this.markDepositDone(depositId, roundId, fromWire(bal));
    } catch (e) {
      if (!(e instanceof WalletError)) throw e;
      await this.db.query(
        `UPDATE wallet_tx SET attempts = attempts + 1, last_error = $2, next_attempt_at = now() + make_interval(secs => $3) WHERE id = $1 AND state = 'pending'`,
        [depositId, e.message.slice(0, 300), this.backoffBaseMs / 1000]);
      return false;
    }
  }

  private markDepositDone(depositId: string, roundId: string, balance: number): Promise<boolean> {
    return inTx(this.db, async tx => {
      const u = await tx.query(`UPDATE wallet_tx SET state = 'done', done_at = now(), attempts = attempts + 1, balance_after = $2 WHERE id = $1 AND state = 'pending'`, [depositId, balance]);
      if (u.rowCount !== 1) return false;
      await tx.query(`UPDATE rounds SET state = 'settled', updated_at = now() WHERE id = $1 AND state = 'settling'`, [roundId]);
      return true;
    });
  }

  // ---------------------------------------------------------------- recovery worker
  /** One pass of the worker: recover stuck rounds, then retry due deposits and cancels. Returns work done. */
  async processDue(limit = 50): Promise<{ recovered: number; attempted: number; succeeded: number }> {
    const stale = `${Math.ceil(this.staleAfterMs / 1000)} seconds`;
    // a) A withdraw left pending (process died mid-call, or a very slow casino): outcome unknown -> cancel.
    const abandoned = await this.db.query<{ id: string; round_id: string }>(
      `SELECT id, round_id FROM wallet_tx WHERE kind = 'withdraw' AND state = 'pending' AND created_at < now() - $1::interval LIMIT $2`, [stale, limit]);
    for (const w of abandoned.rows) await this.failWithdraw(w.round_id, w.id, 'ABANDONED', true);
    // b) A round debited but never queued for payout (process died between the two steps).
    const orphans = await this.db.query<{ id: string; win: number }>(
      `SELECT id, win FROM rounds WHERE state = 'debited' AND updated_at < now() - $1::interval LIMIT $2`, [stale, limit]);
    for (const r of orphans.rows) {
      await inTx(this.db, async tx => {
        const u = await tx.query(`UPDATE rounds SET state = 'settling', updated_at = now() WHERE id = $1 AND state = 'debited'`, [r.id]);
        if (u.rowCount === 1) await tx.query(`INSERT INTO wallet_tx (id, round_id, kind, amount, state) VALUES ($1,$2,'deposit',$3,'pending') ON CONFLICT (round_id, kind) DO NOTHING`, [randomUUID(), r.id, r.win]);
      });
    }
    // c) Lease due deposits and cancels (other workers skip leased rows), then try each once.
    const due = await this.db.query<{ id: string; round_id: string; kind: string; amount: number; attempts: number }>(
      `UPDATE wallet_tx SET next_attempt_at = now() + interval '60 seconds'
       WHERE id IN (SELECT id FROM wallet_tx WHERE state = 'pending' AND kind IN ('deposit', 'cancel') AND next_attempt_at <= now()
                    ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING id, round_id, kind, amount, attempts`, [limit]);
    let succeeded = 0;
    for (const t of due.rows) {
      const ctx = await this.db.query<{ wallet_token: string; native_id_enc: string; game_id: string; operator_id: string; withdraw_id: string }>(
        `SELECT s.wallet_token, s.native_id_enc, s.game_id, s.operator_id,
                (SELECT w.id FROM wallet_tx w WHERE w.round_id = r.id AND w.kind = 'withdraw') AS withdraw_id
           FROM rounds r JOIN sessions s ON s.id = r.session_id WHERE r.id = $1`, [t.round_id]);
      const c = ctx.rows[0];
      if (!c) continue;
      const wallet = this.client(await this.operator(c.operator_id));
      const nativeId = decrypt(c.native_id_enc, this.config.dataKey);
      try {
        if (t.kind === 'deposit') {
          const bal = await wallet.transaction(c.wallet_token, { nativeId, transactionId: t.id, type: 'deposit', amount: toWire(t.amount), game: c.game_id, roundId: t.round_id, roundFinished: true });
          if (await this.markDepositDone(t.id, t.round_id, fromWire(bal))) succeeded++;
        } else {
          let bal: number | null = null;
          try { bal = await wallet.cancel(c.wallet_token, { nativeId, transactionId: c.withdraw_id, roundId: t.round_id }); }
          catch (e) { if (!(e instanceof WalletError && e.code === 'TRANSACTION_NOT_FOUND')) throw e; }
          const done = await inTx(this.db, async tx => {
            const u = await tx.query(`UPDATE wallet_tx SET state = 'done', done_at = now(), attempts = attempts + 1, balance_after = $2 WHERE id = $1 AND state = 'pending'`, [t.id, bal === null ? null : fromWire(bal)]);
            if (u.rowCount !== 1) return false;
            await tx.query(`UPDATE rounds SET state = 'cancelled', updated_at = now() WHERE id = $1 AND state = 'cancelling'`, [t.round_id]);
            return true;
          });
          if (done) succeeded++;
        }
      } catch (e) {
        if (!(e instanceof WalletError)) throw e;
        const backoff = Math.min(this.backoffBaseMs * 2 ** Math.min(t.attempts, 12), 300_000) / 1000;
        await this.db.query(
          `UPDATE wallet_tx SET attempts = attempts + 1, last_error = $2, next_attempt_at = now() + make_interval(secs => $3) WHERE id = $1 AND state = 'pending'`,
          [t.id, e.message.slice(0, 300), backoff]);
        if (t.attempts + 1 >= 10) this.log(`ATTENTION: ${t.kind} ${t.id} for round ${t.round_id} still failing after ${t.attempts + 1} attempts: ${e.message}`);
      }
    }
    return { recovered: abandoned.rows.length + orphans.rows.length, attempted: due.rows.length, succeeded };
  }

  /** Run the worker until nothing is pending (tests and shutdown). */
  async drain(maxPasses = 1000): Promise<void> {
    for (let i = 0; i < maxPasses; i++) {
      // Finished = no money movement pending AND no round outside a final state (a round can be stuck with no
      // pending transaction, e.g. debited but never queued for payout).
      await this.db.query(`UPDATE wallet_tx SET next_attempt_at = now() WHERE state = 'pending' AND kind IN ('deposit', 'cancel')`);
      await this.processDue(200);
      const open = await this.db.query<{ n: string }>(
        `SELECT ((SELECT count(*) FROM wallet_tx WHERE state = 'pending') +
                 (SELECT count(*) FROM rounds WHERE state NOT IN ('settled', 'rejected', 'cancelled')))::text AS n`);
      if (Number(open.rows[0]?.n) === 0) return;
      await sleep(5);
    }
    throw new Error('drain: still pending after max passes');
  }

  // ---------------------------------------------------------------- fairness
  async rotateSeeds(token: unknown, body: { clientSeed?: unknown }) {
    if (body.clientSeed !== undefined && !isValidClientSeed(body.clientSeed)) throw new AppError(400, 'BAD_REQUEST', 'clientSeed: 1-64 printable characters');
    return inTx(this.db, async tx => {
      const s = await this.session(token, tx, true);
      await tx.query('INSERT INTO revealed_seeds (server_seed_hash, server_seed) VALUES ($1,$2) ON CONFLICT DO NOTHING', [s.server_seed_hash, s.server_seed]);
      const next = newServerSeed();
      const clientSeed = (body.clientSeed as string | undefined) ?? newClientSeed();
      await tx.query('UPDATE sessions SET server_seed = $2, server_seed_hash = $3, client_seed = $4, nonce = 0 WHERE id = $1', [s.id, next.seed, next.hash, clientSeed]);
      return {
        revealed: { serverSeed: s.server_seed, serverSeedHash: s.server_seed_hash, clientSeed: s.client_seed, roundsPlayed: Number(s.nonce) },
        next: { serverSeedHash: next.hash, clientSeed, nonce: 0 },
      };
    });
  }

  async round(token: unknown, roundId: unknown) {
    const s = await this.session(token);
    if (typeof roundId !== 'string' || !/^[0-9a-f-]{36}$/.test(roundId)) throw new AppError(400, 'BAD_REQUEST', 'bad round id');
    const r = await this.db.query<RoundRow>('SELECT * FROM rounds WHERE id = $1 AND session_id = $2', [roundId, s.id]);
    if (!r.rows[0]) throw new AppError(404, 'NOT_FOUND', 'round not found');
    return this.view(r.rows[0]);
  }

  private view(r: RoundRow) {
    const shown = r.state === 'settling' || r.state === 'settled';
    return {
      roundId: r.id, state: r.state, game: r.game_id, currency: r.currency,
      bet: toWire(Number(r.bet)), picks: r.params.picks,
      ...(shown && r.outcome ? { drawn: r.outcome.drawn, hits: r.outcome.hits, multiplier: r.outcome.multiplier / 100, win: toWire(Number(r.win)) } : {}),
      ...(r.reject_code ? { reason: r.reject_code } : {}),
      fairness: { serverSeedHash: r.server_seed_hash, clientSeed: r.client_seed, nonce: Number(r.nonce) },
    };
  }
}

/** Public checker: recompute a Keno round from revealed seeds. Anyone can run this. */
export function verifyKeno(a: { serverSeed: string; clientSeed: string; nonce: number; picks: number[] }) {
  const params = parseKenoParams({ picks: a.picks });
  const outcome = playKeno(params, new FairRng(a.serverSeed, a.clientSeed, a.nonce));
  return { serverSeedHash: sha256(a.serverSeed), drawn: outcome.drawn, hits: outcome.hits, multiplier: outcome.multiplier / 100 };
}

export { MICRO };
