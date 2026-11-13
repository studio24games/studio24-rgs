// Player-facing HTTP API (pilot). JSON in and out; errors as { error: { code, message } }.
//   GET  /health
//   POST /api/session              { operator, key, game }            -> session token, balance, fairness commitment
//   POST /api/play                 Bearer token; { requestId, bet, params: { picks } }
//   GET  /api/round/:id            Bearer token
//   POST /api/fairness/rotate      Bearer token; { clientSeed? }      -> reveals the old server seed
//   POST /api/fairness/verify-keno { serverSeed, clientSeed, nonce, picks }   (public checker)
//   GET  /api/games/keno           rules and paytable (public)
//   GET  /keno                     the Keno game screen (public/keno.*); a casino launches it with ?operator=&key=
//   POST /demo/launch              demo mode only: a simulated-casino player with a fresh launch key
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { AppError, verifyKeno, type Rgs } from '../rgs.ts';
import { KENO_PAYTABLE, KENO_TARGET_RTP } from '../games/keno-paytable.ts';
import { KENO_DRAWN, KENO_MAX_PICKS, KENO_NUMBERS } from '../games/keno-maths.ts';

const STATIC: Record<string, { file: string; type: string }> = {
  '/keno': { file: 'keno.html', type: 'text/html; charset=utf-8' },
  '/keno.css': { file: 'keno.css', type: 'text/css; charset=utf-8' },
  '/keno.js': { file: 'keno.js', type: 'text/javascript; charset=utf-8' },
};
const PUBLIC_DIR = new URL('../../public/', import.meta.url);
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors *; base-uri 'none'; form-action 'none'";
const KENO_RULES = { game: 'keno', numbers: KENO_NUMBERS, drawn: KENO_DRAWN, maxPicks: KENO_MAX_PICKS, targetRtp: KENO_TARGET_RTP,
  paytable: Object.fromEntries(Object.entries(KENO_PAYTABLE).map(([n, row]) => [n, row.map(x => x / 100)])) };

export interface ApiOptions { demoLaunch?: () => Promise<{ operator: string; key: string }> }

const MAX_BODY = 64 * 1024;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new AppError(413, 'TOO_LARGE', 'body too large'); chunks.push(c as Buffer); }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch { throw new AppError(400, 'BAD_JSON', 'body must be a JSON object'); }
}

const bearer = (req: IncomingMessage) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];

export function createApi(rgs: Rgs, log: (m: string) => void = () => {}, opts: ApiOptions = {}): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      const m = req.method, p = url.pathname;
      if (m === 'GET' && p === '/health') return send(200, { ok: true });
      const asset = m === 'GET' ? STATIC[p] : undefined;
      if (asset) {
        const body = await readFile(new URL(asset.file, PUBLIC_DIR));
        res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        return res.end(body);
      }
      if (m === 'GET' && p === '/') { res.writeHead(302, { Location: '/keno' }); return res.end(); }
      if (m === 'GET' && p === '/api/games/keno') return send(200, KENO_RULES);
      if (m === 'POST' && p === '/demo/launch' && opts.demoLaunch) return send(200, await opts.demoLaunch());
      if (m === 'POST' && p === '/api/session') return send(200, await rgs.openSession(await readJson(req) as never));
      if (m === 'POST' && p === '/api/play') return send(200, await rgs.play(bearer(req), await readJson(req)));
      if (m === 'GET' && p.startsWith('/api/round/')) return send(200, await rgs.round(bearer(req), p.slice('/api/round/'.length)));
      if (m === 'POST' && p === '/api/fairness/rotate') return send(200, await rgs.rotateSeeds(bearer(req), await readJson(req)));
      if (m === 'POST' && p === '/api/fairness/verify-keno') {
        const b = await readJson(req);
        if (typeof b.serverSeed !== 'string' || typeof b.clientSeed !== 'string' || !Number.isInteger(b.nonce) || !Array.isArray(b.picks))
          throw new AppError(400, 'BAD_REQUEST', 'serverSeed, clientSeed, nonce and picks are required');
        try { return send(200, verifyKeno(b as never)); } catch (e) { throw new AppError(400, 'BAD_REQUEST', (e as Error).message); }
      }
      throw new AppError(404, 'NOT_FOUND', 'not found');
    } catch (e) {
      if (e instanceof AppError) return send(e.status, { error: { code: e.code, message: e.message } });
      log(`ERROR ${req.method} ${url.pathname}: ${(e as Error).stack ?? e}`);
      return send(500, { error: { code: 'SERVER_ERROR', message: 'server error' } });
    }
  });
}
