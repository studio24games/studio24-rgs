// Small crypto helpers: AES-256-GCM for the casino's player id at rest, keyed pseudonyms, session tokens.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

export function encrypt(plain: string, keyHex: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map(b => b.toString('base64url')).join('.');
}

export function decrypt(blob: string, keyHex: string): string {
  const [iv, tag, ct] = blob.split('.').map(s => Buffer.from(s, 'base64url'));
  if (!iv || !tag || !ct) throw new Error('bad ciphertext');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/** Per-operator pseudonym: the same casino player always maps to the same ref; refs can't be linked across casinos. */
export const pseudonym = (nativeId: string, operatorKey: string): string => createHmac('sha256', operatorKey).update(nativeId).digest('base64url').slice(0, 22);

export const newToken = (): string => randomBytes(32).toString('base64url');
export const hashToken = (t: string): string => createHash('sha256').update(t).digest('hex');
