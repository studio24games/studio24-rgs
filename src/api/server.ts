// Player-facing HTTP API (pilot). JSON in and out; errors as { error: { code, message } }.
//   GET  /health
//   POST /api/session              { operator, key, game }            -> session token, balance, fairness commitment
//   POST /api/play                 Bearer token; { requestId, bet, params: { picks } }
//   GET  /api/round/:id            Bearer token
//   POST /api/fairness/rotate      Bearer token; { clientSeed? }      -> reveals the old server seed
//   POST /api/fairness/verify-keno { serverSeed, clientSeed, nonce, picks }   (public checker)
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { AppError, verifyKeno, type Rgs } from '../rgs.ts';

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

export function createApi(rgs: Rgs, log: (m: string) => void = () => {}): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      const m = req.method, p = url.pathname;
      if (m === 'GET' && p === '/health') return send(200, { ok: true });
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
