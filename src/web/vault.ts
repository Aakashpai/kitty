/**
 * End-to-end encryption for documents, all in the browser with WebCrypto.
 *
 * - A master key is derived from the owner's login password (PBKDF2-SHA256) and a random salt kept on the server.
 * - Each top-level folder has its own AES-256-GCM key, stored on the server wrapped by the master key.
 * - Every file is encrypted with its folder key and a fresh IV before it leaves the browser.
 * - A share link carries the folder key in the URL hash, which browsers never send to any server.
 *
 * The server, the database and the storage bucket only ever hold ciphertext and wrapped keys.
 */

const PBKDF2_ITERATIONS = 310_000;
const CHECK = 'kitty-vault-ok';
const SESSION_KEY = 'vault-master';

const te = new TextEncoder();
const td = new TextDecoder();

export const toB64 = (bytes: ArrayBuffer | Uint8Array): string => {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const fromB64 = (s: string): Uint8Array => {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const buf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

const importAes = (raw: Uint8Array) => crypto.subtle.importKey('raw', buf(raw), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);

export const newSalt = () => toB64(random(16));

export async function deriveMasterKey(password: string, saltB64: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', buf(te.encode(password.normalize('NFKC'))), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: buf(fromB64(saltB64)), iterations: PBKDF2_ITERATIONS }, base, 256);
  return importAes(new Uint8Array(bits));
}

export const newFolderKey = () => importAes(random(32));

export async function encryptBytes(key: CryptoKey, data: ArrayBuffer | Uint8Array): Promise<{ iv: string; ct: ArrayBuffer }> {
  const iv = random(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, key, data instanceof Uint8Array ? buf(data) : data);
  return { iv: toB64(iv), ct };
}
export const decryptBytes = (key: CryptoKey, ivB64: string, ct: ArrayBuffer | Uint8Array): Promise<ArrayBuffer> =>
  crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(fromB64(ivB64)) }, key, ct instanceof Uint8Array ? buf(ct) : ct);

/** The folder key, encrypted under the master key, as two base64 strings for the database. */
export async function wrapKey(master: CryptoKey, folderKey: CryptoKey): Promise<{ key_iv: string; key_ct: string }> {
  const raw = await crypto.subtle.exportKey('raw', folderKey);
  const { iv, ct } = await encryptBytes(master, raw);
  return { key_iv: iv, key_ct: toB64(ct) };
}
export const unwrapKey = async (master: CryptoKey, key_iv: string, key_ct: string): Promise<CryptoKey> => importAes(new Uint8Array(await decryptBytes(master, key_iv, fromB64(key_ct))));

/** A known value encrypted under the master key, so a wrong password is caught before anything is touched. */
export async function makeCheck(master: CryptoKey): Promise<{ check_iv: string; check_ct: string }> {
  const { iv, ct } = await encryptBytes(master, te.encode(CHECK));
  return { check_iv: iv, check_ct: toB64(ct) };
}
export async function passesCheck(master: CryptoKey, check_iv: string, check_ct: string): Promise<boolean> {
  try {
    return td.decode(await decryptBytes(master, check_iv, fromB64(check_ct))) === CHECK;
  } catch {
    return false;
  }
}

export const exportKey = async (key: CryptoKey): Promise<string> => toB64(await crypto.subtle.exportKey('raw', key));
export const importKey = (b64: string): Promise<CryptoKey> => importAes(fromB64(b64));

// --- the unlocked master key lives in sessionStorage: gone when the tab closes, back on a reload ------------------
export async function rememberMaster(master: CryptoKey): Promise<void> {
  try { sessionStorage.setItem(SESSION_KEY, await exportKey(master)); } catch { /* private mode */ }
}
export async function loadMaster(): Promise<CryptoKey | null> {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? await importKey(raw) : null;
  } catch {
    return null;
  }
}
export const forgetMaster = () => { try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } };

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
