import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

const scrypt = (pw: string, salt: Buffer) => new Promise<Buffer>((res, rej) => scryptCb(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64url')}$${(await scrypt(password, salt)).toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const derived = await scrypt(password, Buffer.from(salt, 'base64url'));
  const expected = Buffer.from(hash, 'base64url');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url');

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('base64url');

/** Short fingerprint of the password hash; baked into sessions so a password change signs every device out. */
export const passwordFingerprint = (passwordHash: string) => createHash('sha256').update(passwordHash).digest('base64url').slice(0, 16);

/** Stateless session: base64url(JSON) + "." + HMAC. Dies when the user is removed or changes their password. */
export function createSession(secret: string, uid: number, fp: string, days = 30): string {
  const body = b64(JSON.stringify({ uid, fp, exp: Date.now() + days * 86_400_000 }));
  return `${body}.${sign(secret, body)}`;
}

export function readSession(secret: string, cookie: string | undefined): { uid: number; fp: string } | null {
  if (!cookie) return null;
  const [body, sig] = cookie.split('.');
  if (!body || !sig) return null;
  const expected = sign(secret, body);
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { uid?: unknown; fp?: unknown; exp?: unknown };
    if (typeof payload.uid !== 'number' || typeof payload.fp !== 'string' || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return { uid: payload.uid, fp: payload.fp };
  } catch {
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Per-key failure counter: after `max` failures within the window the key is locked for the window. */
export class RateLimiter {
  private hits = new Map<string, { count: number; until: number }>();
  private max: number;
  private windowMs: number;
  constructor(max = 10, windowMs = 15 * 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }
  locked(key: string): boolean {
    const h = this.hits.get(key);
    if (!h) return false;
    if (h.until < Date.now()) {
      this.hits.delete(key);
      return false;
    }
    return h.count >= this.max;
  }
  fail(key: string) {
    const h = this.hits.get(key);
    if (h && h.until > Date.now()) h.count += 1;
    else this.hits.set(key, { count: 1, until: Date.now() + this.windowMs });
  }
  reset(key: string) {
    this.hits.delete(key);
  }
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 200;
