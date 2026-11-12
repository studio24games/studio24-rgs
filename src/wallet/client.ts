// Client for a casino's seamless wallet, compatible with the S24 wallet API (S24_WALLET_INTEGRATION):
//   POST /authenticate, POST /balance, PUT /transaction, DELETE /cancel
// Every request carries X-Server-Authorization = hex HMAC-SHA256(body, secret); player calls also carry
// Authorization: Bearer <token from /authenticate>.
import { createHmac } from 'node:crypto';

export type WalletErrorKind =
  | 'unknown'   // outcome unknown (network error, timeout, 5xx, code UNKNOWN): may have been applied
  | 'refused';  // the casino answered with a definite application error: nothing was applied

export class WalletError extends Error {
  readonly kind: WalletErrorKind; readonly code: string; readonly status: number;
  constructor(kind: WalletErrorKind, code: string, message: string, status = 0) { super(message); this.kind = kind; this.code = code; this.status = status; }
}

export interface AuthResult { nativeId: string; token: string; balance: number; currency: string; brand?: string }

export interface WalletClientOptions { baseUrl: string; secret: string; timeoutMs?: number; provider?: string }

export const sign = (body: string, secret: string): string => createHmac('sha256', secret).update(body).digest('hex');

export class WalletClient {
  readonly provider: string;
  private readonly timeoutMs: number;
  private readonly opts: WalletClientOptions;
  constructor(opts: WalletClientOptions) {
    this.opts = opts;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.provider = opts.provider ?? 'studio24';
  }

  private async call(method: string, path: string, body: Record<string, unknown>, token?: string): Promise<Record<string, unknown>> {
    const json = JSON.stringify(body);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Server-Authorization': sign(json, this.opts.secret) };
    if (token) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await fetch(this.opts.baseUrl.replace(/\/$/, '') + path, { method, headers, body: json, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new WalletError('unknown', 'NETWORK', `${path}: ${(e as Error).name}: ${(e as Error).message}`);
    }
    let parsed: Record<string, unknown> = {};
    try { parsed = (await res.json()) as Record<string, unknown>; } catch { /* empty or not JSON */ }
    if (res.ok) return parsed;
    const err = (parsed.error ?? {}) as { code?: unknown; message?: unknown };
    const code = typeof err.code === 'string' ? err.code : 'UNKNOWN';
    const kind: WalletErrorKind = res.status >= 500 || code === 'UNKNOWN' ? 'unknown' : 'refused';
    throw new WalletError(kind, code, `${path}: ${res.status} ${code} ${typeof err.message === 'string' ? err.message : ''}`.trim(), res.status);
  }

  async authenticate(a: { operator: string; key: string; game: string }): Promise<AuthResult> {
    const r = await this.call('POST', '/authenticate', { operator: a.operator, key: a.key, game: a.game, provider: this.provider });
    if (typeof r.nativeId !== 'string' || typeof r.token !== 'string' || typeof r.balance !== 'number' || typeof r.currency !== 'string')
      throw new WalletError('refused', 'BAD_RESPONSE', '/authenticate: missing fields');
    return { nativeId: r.nativeId, token: r.token, balance: r.balance, currency: r.currency.toLowerCase(), ...(typeof r.brand === 'string' ? { brand: r.brand } : {}) };
  }

  async balance(token: string, nativeId: string, game: string): Promise<number> {
    const r = await this.call('POST', '/balance', { nativeId, game, provider: this.provider }, token);
    if (typeof r.balance !== 'number') throw new WalletError('unknown', 'BAD_RESPONSE', '/balance: no balance');
    return r.balance;
  }

  async transaction(token: string, t: { nativeId: string; transactionId: string; type: 'withdraw' | 'deposit'; amount: number; game: string; roundId: string; roundFinished?: boolean }): Promise<number> {
    const r = await this.call('PUT', '/transaction', { ...t, provider: this.provider, category: 'normal' }, token);
    if (typeof r.balance !== 'number') throw new WalletError('unknown', 'BAD_RESPONSE', '/transaction: no balance');
    return r.balance;
  }

  async cancel(token: string, c: { nativeId: string; transactionId: string; roundId: string }): Promise<number> {
    const r = await this.call('DELETE', '/cancel', c, token);
    if (typeof r.balance !== 'number') throw new WalletError('unknown', 'BAD_RESPONSE', '/cancel: no balance');
    return r.balance;
  }
}
