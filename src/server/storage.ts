import { AwsClient } from 'aws4fetch';

/**
 * Where encrypted document blobs live. Blobs are ciphertext; the API only ever sees their size and key.
 *
 * Default: the ledger's own database, in CHUNK-sized pieces, so every request stays under Vercel's 4.5 MB body
 * limit and nothing new has to be signed up for. Optional: Cloudflare R2 (S3 API) when its four variables are
 * set, where the browser uploads and downloads straight through short-lived signed URLs.
 */
export const CHUNK = 512 * 1024;
export const MAX_DOC = 200 * 1024 * 1024;

export interface ObjectStore {
  kind: 'r2';
  uploadUrl(key: string): Promise<string>;
  downloadUrl(key: string): Promise<string>;
  remove(key: string): Promise<void>;
}

const EXPIRES = 600; // seconds a signed URL stays valid
export const isStorageKey = (k: string) => /^d\d+_[A-Za-z0-9_-]{8,120}$/.test(k);

export function r2Storage(env: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string }): ObjectStore {
  const client = new AwsClient({ accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey, service: 's3', region: 'auto' });
  const base = `https://${env.accountId}.r2.cloudflarestorage.com/${env.bucket}/`;
  const presign = async (key: string, method: 'GET' | 'PUT') => (await client.sign(new Request(`${base}${key}?X-Amz-Expires=${EXPIRES}`, { method }), { aws: { signQuery: true } })).url;
  return {
    kind: 'r2',
    uploadUrl: (key) => presign(key, 'PUT'),
    downloadUrl: (key) => presign(key, 'GET'),
    remove: async (key) => {
      const r = await client.fetch(`${base}${key}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 404) throw new Error(`R2 delete failed: ${r.status}`);
    },
  };
}

/** R2 when all four variables are set, otherwise null: blobs then live in the database. */
export function objectStoreFromEnv(): ObjectStore | null {
  const { R2_ACCOUNT_ID: a, R2_ACCESS_KEY_ID: k, R2_SECRET_ACCESS_KEY: s, R2_BUCKET: b } = process.env;
  return a && k && s && b ? r2Storage({ accountId: a, accessKeyId: k, secretAccessKey: s, bucket: b }) : null;
}
