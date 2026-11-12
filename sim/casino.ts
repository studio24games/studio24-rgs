// A simulated casino wallet: the CASINO side of the S24 seamless wallet API, for tests and demos.
// It keeps its own ledger and can inject faults, including the dangerous ones where it applies a transaction
// but the RGS never hears back. Not for production.
//
// Spec behaviour implemented (S24_WALLET_INTEGRATION):
//  - /transaction is idempotent per transactionId (repeat = no change, current balance).
//  - A transactionId that was cancelled can never be used again.
//  - /cancel refunds a withdraw once; cancelling an unknown id records it and returns the balance.
//  - Requests must carry a valid X-Server-Authorization HMAC; player calls a valid Bearer token.
import { createServer, type Server } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface Faults {
  errorBefore?: number;    // reply 500 without applying
  errorAfter?: number;     // apply, then reply 500 (RGS must not double-apply on retry)
  dropAfter?: number;      // apply, then destroy the connection (RGS sees a network error)
  slowAfterMs?: number;    // apply, then wait this long before replying (beyond the RGS timeout)
  slowAfter?: number;      // probability of the slow reply
}

interface Player { nativeId: string; balanceCents: number; startCents: number; token: string }
export interface LedgerTx { id: string; nativeId: string; type: 'withdraw' | 'deposit'; cents: number; roundId: string; cancelled: boolean; roundFinished: boolean }

export interface SimCasino {
  url: string; secret: string; faults: Faults;
  addPlayer(nativeId: string, balance: number): string;          // returns a one-time launch key
  players: Map<string, Player>; txs: Map<string, LedgerTx>; cancelledUnknown: Set<string>;
  requests: number; close(): Promise<void>;
}

const cents = (v: number) => Math.round(v * 100);

export async function startSimCasino(o: { port?: number; secret?: string; faults?: Faults; random?: () => number } = {}): Promise<SimCasino> {
  const secret = o.secret ?? randomBytes(16).toString('hex');
  const random = o.random ?? Math.random;
  const players = new Map<string, Player>(), byToken = new Map<string, Player>(), keys = new Map<string, string>();
  const txs = new Map<string, LedgerTx>(), cancelledUnknown = new Set<string>();
  const state = { requests: 0 };
  const faults: Faults = o.faults ?? {};

  const server: Server = createServer(async (req, res) => {
    state.requests++;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const fail = (status: number, code: string, message = code) => reply(status, { error: { code, message } });

    const sig = String(req.headers['x-server-authorization'] ?? '');
    const want = createHmac('sha256', secret).update(raw).digest('hex');
    if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return fail(401, 'SERVER_UNAUTHORIZED');
    let b: Record<string, unknown>;
    try { b = JSON.parse(raw); } catch { return fail(400, 'UNKNOWN', 'bad json'); }
    const path = new URL(req.url ?? '/', 'http://x').pathname;

    if (path === '/authenticate') {
      const nativeId = keys.get(String(b.key));
      if (!nativeId) return fail(401, 'PLAYER_UNAUTHORIZED', 'bad or used key');
      keys.delete(String(b.key));
      const p = players.get(nativeId) as Player;
      return reply(200, { nativeId, token: p.token, balance: p.balanceCents / 100, currency: 'usd', brand: 'simcasino' });
    }
    const p = byToken.get(/^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '');
    if (!p || p.nativeId !== b.nativeId) return fail(401, 'PLAYER_UNAUTHORIZED');
    if (path === '/balance') return reply(200, { balance: p.balanceCents / 100 });

    // Fault before doing anything.
    if (random() < (faults.errorBefore ?? 0)) return fail(500, 'UNKNOWN', 'injected: error before');

    let status = 200, body: unknown;
    if (path === '/transaction') {
      const id = String(b.transactionId), type = b.type, amount = Number(b.amount);
      if ((type !== 'withdraw' && type !== 'deposit') || !(amount >= 0)) return fail(400, 'TRANSACTION_FAILED', 'bad transaction');
      const prior = txs.get(id);
      if (cancelledUnknown.has(id) || prior?.cancelled) return fail(409, 'TRANSACTION_FAILED', 'transaction id was cancelled');
      if (!prior) {
        const c = cents(amount);
        if (type === 'withdraw' && p.balanceCents < c) return fail(402, 'INSUFFICIENT_FUNDS');
        p.balanceCents += type === 'withdraw' ? -c : c;
        txs.set(id, { id, nativeId: p.nativeId, type, cents: c, roundId: String(b.roundId), cancelled: false, roundFinished: b.roundFinished === true });
      }
      body = { balance: p.balanceCents / 100 };
    } else if (path === '/cancel') {
      const id = String(b.transactionId), t = txs.get(id);
      if (!t) cancelledUnknown.add(id);
      else if (t.type === 'deposit') return fail(400, 'TRANSACTION_FAILED', 'deposits cannot be cancelled');
      else if (!t.cancelled) { t.cancelled = true; p.balanceCents += t.cents; }
      body = { balance: p.balanceCents / 100 };
    } else { status = 404; body = { error: { code: 'UNKNOWN', message: 'not found' } }; }

    // Faults after applying: the money moved, but the RGS doesn't learn it.
    if (random() < (faults.errorAfter ?? 0)) return fail(500, 'UNKNOWN', 'injected: error after');
    if (random() < (faults.dropAfter ?? 0)) { res.socket?.destroy(); return; }
    if (random() < (faults.slowAfter ?? 0)) await new Promise(r => setTimeout(r, faults.slowAfterMs ?? 3000));
    reply(status, body);
  });

  await new Promise<void>(r => server.listen(o.port ?? 0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`, secret, faults, players, txs, cancelledUnknown,
    get requests() { return state.requests; },
    addPlayer(nativeId: string, balance: number) {
      const pl: Player = { nativeId, balanceCents: cents(balance), startCents: cents(balance), token: randomBytes(16).toString('hex') };
      players.set(nativeId, pl); byToken.set(pl.token, pl);
      const key = randomBytes(12).toString('hex'); keys.set(key, nativeId);
      return key;
    },
    close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const c = await startSimCasino({ port: Number(process.env.PORT ?? 8090), secret: process.env.SIM_SECRET ?? 'sim-secret' });
  const key = c.addPlayer('demo-player', 1000);
  console.log(`simulated casino on ${c.url} (secret ${c.secret}); demo launch key: ${key}`);
}
