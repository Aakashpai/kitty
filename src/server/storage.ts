import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AwsClient } from 'aws4fetch';

/**
 * Where encrypted document blobs live. The browser talks to storage directly through short-lived signed URLs, so a
 * file never passes through the API (Vercel caps request bodies at 4.5 MB). Blobs are ciphertext; the API only
 * ever sees their size and key. Production uses Cloudflare R2 (S3 API, free tier); local development writes to
 * `data/docs/` behind the same URL contract, signed with the session secret.
 */
export interface Storage {
  kind: 'r2' | 'local';
  uploadUrl(key: string): Promise<{ url: string; method: 'PUT' }>;
  downloadUrl(key: string): Promise<string>;
  remove(key: string): Promise<void>;
}

const EXPIRES = 600; // seconds a signed URL stays valid
const KEY_RE = /^[A-Za-z0-9_-]{8,120}$/;
export const isStorageKey = (k: string) => KEY_RE.test(k);

export function r2Storage(env: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string }): Storage {
  const client = new AwsClient({ accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey, service: 's3', region: 'auto' });
  const base = `https://${env.accountId}.r2.cloudflarestorage.com/${env.bucket}/`;
  const presign = async (key: string, method: 'GET' | 'PUT') => {
    const signed = await client.sign(new Request(`${base}${key}?X-Amz-Expires=${EXPIRES}`, { method }), { aws: { signQuery: true } });
    return signed.url;
  };
  return {
    kind: 'r2',
    uploadUrl: async (key) => ({ url: await presign(key, 'PUT'), method: 'PUT' }),
    downloadUrl: (key) => presign(key, 'GET'),
    remove: async (key) => {
      const r = await client.fetch(`${base}${key}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 404) throw new Error(`R2 delete failed: ${r.status}`);
    },
  };
}

/** Local files under data/docs, reached through the API with an HMAC-signed, expiring URL. */
export function localStorage_(dir: string, secret: string, base = '/api/docs/blob'): Storage & { verify(key: string, method: string, exp: string, sig: string): boolean; read(key: string): Buffer | null; write(key: string, data: Buffer): void } {
  const root = resolve(dir);
  mkdirSync(root, { recursive: true });
  const sign = (key: string, method: string, exp: number) => createHmac('sha256', secret).update(`${method}:${key}:${exp}`).digest('base64url');
  const url = (key: string, method: string) => {
    const exp = Math.floor(Date.now() / 1000) + EXPIRES;
    return `${base}/${key}?exp=${exp}&sig=${sign(key, method, exp)}`;
  };
  const path = (key: string) => join(root, key);
  return {
    kind: 'local',
    uploadUrl: async (key) => ({ url: url(key, 'PUT'), method: 'PUT' }),
    downloadUrl: async (key) => url(key, 'GET'),
    remove: async (key) => { if (isStorageKey(key) && existsSync(path(key))) unlinkSync(path(key)); },
    verify: (key, method, exp, sig) => {
      if (!isStorageKey(key) || !/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
      const want = Buffer.from(sign(key, method, Number(exp)));
      const got = Buffer.from(sig);
      return want.length === got.length && timingSafeEqual(want, got);
    },
    read: (key) => (isStorageKey(key) && existsSync(path(key)) ? readFileSync(path(key)) : null),
    write: (key, data) => { if (isStorageKey(key)) writeFileSync(path(key), data); },
  };
}

/** R2 when all four variables are set; otherwise local files (never on Vercel, whose disk is not kept). */
export function storageFromEnv(secret: string): Storage | null {
  const { R2_ACCOUNT_ID: a, R2_ACCESS_KEY_ID: k, R2_SECRET_ACCESS_KEY: s, R2_BUCKET: b } = process.env;
  if (a && k && s && b) return r2Storage({ accountId: a, accessKeyId: k, secretAccessKey: s, bucket: b });
  if (process.env.VERCEL) return null;
  return localStorage_(process.env.DOCS_DIR ?? 'data/docs', secret);
}
