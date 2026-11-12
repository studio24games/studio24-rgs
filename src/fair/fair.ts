// Provably fair randomness (commit-reveal).
//
// Before any bet the player sees sha256(serverSeed). Each round's numbers come from
//   HMAC-SHA256(key = serverSeed, message = `${clientSeed}:${nonce}:${block}`)
// split into 32-bit integers, mapped to a range by rejection sampling (no modulo bias).
// When the player rotates seeds, the old serverSeed is revealed, and every past round can be recomputed
// by anyone with this file (or an independent checker) from: serverSeed, clientSeed, nonce.
import { createHash, createHmac, randomBytes } from 'node:crypto';

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export function newServerSeed(): { seed: string; hash: string } {
  const seed = randomBytes(32).toString('hex');
  return { seed, hash: sha256(seed) };
}

export const newClientSeed = (): string => randomBytes(12).toString('hex');

export function isValidClientSeed(s: unknown): s is string {
  return typeof s === 'string' && /^[\x21-\x7e]{1,64}$/.test(s);
}

export interface Rng { int(n: number): number }

const TWO32 = 0x1_0000_0000;

/** Deterministic stream of 32-bit integers for one round. */
export class FairRng implements Rng {
  private block = 0;
  private buf: number[] = [];
  private used = 0;
  private readonly serverSeed: string; private readonly clientSeed: string; private readonly nonce: number;
  constructor(serverSeed: string, clientSeed: string, nonce: number) { this.serverSeed = serverSeed; this.clientSeed = clientSeed; this.nonce = nonce; }

  /** Number of 32-bit values consumed so far (for audit and tests). */
  get consumed(): number { return this.used; }

  private nextU32(): number {
    if (this.buf.length === 0) {
      const mac = createHmac('sha256', this.serverSeed).update(`${this.clientSeed}:${this.nonce}:${this.block++}`).digest();
      for (let i = 0; i < 32; i += 4) this.buf.push(mac.readUInt32BE(i));
    }
    this.used++;
    return this.buf.shift() as number;
  }

  /** Uniform integer in [0, n), unbiased: values in the incomplete top range are rejected and redrawn. */
  int(n: number): number {
    if (!Number.isInteger(n) || n <= 0 || n > TWO32) throw new RangeError(`bad range ${n}`);
    const limit = TWO32 - (TWO32 % n);
    let x: number;
    do { x = this.nextU32(); } while (x >= limit);
    return x % n;
  }
}
