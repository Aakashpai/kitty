import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { ACCOUNT_TYPES, normalizeTx, validateTx, type Account, type Trip, type UserPublic } from '../engine/index.ts';
import { HttpError, openDb, type Db } from './db.ts';
import { RateLimiter, createSession, hashPassword, isEmail, parseCookies, passwordFingerprint, randomToken, readSession, verifyPassword } from './auth.ts';
import { seed } from './seed.ts';

interface Ctx {
  params: Record<string, string>;
  body: Record<string, unknown>;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  user: UserPublic | null;
}
type Handler = (c: Ctx) => unknown;
type Access = 'public' | 'user' | 'owner';
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2' };
const COOKIE = 'ledger_session';

const str = (v: unknown, label: string, max = 100): string => {
  const s = String(v ?? '').trim();
  if (!s) throw new HttpError(400, `${label} is required`);
  if (s.length > max) throw new HttpError(400, `${label} is too long`);
  return s;
};
const optStr = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 2000) : null);
const int = (v: unknown, label: string): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new HttpError(400, `${label} must be a whole number`);
  return n;
};
const currency = (v: unknown): string => {
  const c = String(v ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new HttpError(400, 'Currency must be a 3-letter code');
  return c;
};
const date = (v: unknown, label: string): string => {
  const s = String(v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new HttpError(400, `${label} must be YYYY-MM-DD`);
  return s;
};
const flag = (v: unknown): 0 | 1 => (v === 1 || v === true || v === '1' ? 1 : 0);
const upi = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9]{1,30}$/.test(s)) throw new HttpError(400, 'UPI ID should look like name@bank');
  return s;
};
/** { SGD: 75, MYR: 24.5 } -> validated map; empty/invalid shapes become null. */
const rates = (v: unknown): Record<string, number> | null => {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const code = String(k).trim().toUpperCase();
    const n = Number(raw);
    if (!/^[A-Z]{3}$/.test(code)) throw new HttpError(400, `Rate currency "${k}" must be a 3-letter code`);
    if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `Rate for ${code} must be a positive number`);
    out[code] = n;
  }
  return Object.keys(out).length ? out : null;
};
const password = (v: unknown): string => {
  const s = String(v ?? '');
  if (s.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (s.length > 200) throw new HttpError(400, 'Password is too long');
  return s;
};
const email = (v: unknown): string => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!isEmail(s)) throw new HttpError(400, 'Enter a valid email address');
  return s;
};

export interface AppOptions {
  url: string; // "file:data/ledger.db", ":memory:" or "libsql://..."
  authToken?: string;
  secret?: string; // session secret; generated and stored for local databases when missing
  staticDir?: string | null; // serve the built web app from here (null on Vercel)
  trustProxy?: boolean;
  owner?: { email: string; name: string; password: string }; // creates the owner on first boot (also read from OWNER_* env)
}

export async function createApp(opts: AppOptions) {
  const db: Db = await openDb(opts.url, opts.authToken);
  let secret = opts.secret ?? process.env.SESSION_SECRET;
  if (!secret) {
    if (!db.isLocal) throw new Error('SESSION_SECRET is required when using a remote database');
    secret = (await db.getSetting('session_secret')) ?? randomToken(32);
    await db.setSetting('session_secret', secret);
  }
  const staticDir = opts.staticDir === undefined ? resolve('dist') : opts.staticDir;
  // First boot on a fresh database: create the owner from configuration so the live site never shows a setup page.
  const owner = opts.owner ?? (process.env.OWNER_EMAIL && process.env.OWNER_PASSWORD ? { email: process.env.OWNER_EMAIL, name: process.env.OWNER_NAME ?? 'Owner', password: process.env.OWNER_PASSWORD } : undefined);
  if (owner && (await db.userCount()) === 0) {
    const me = (await db.loadState(null)).people.find((p) => p.is_me);
    if (!me) throw new Error('No "me" person configured');
    await db.createUser({ email: email(owner.email), name: str(owner.name, 'Name'), password_hash: await hashPassword(password(owner.password)), role: 'owner', person_id: me.id });
  }
  const limiter = new RateLimiter();
  const routes: { method: string; re: RegExp; keys: string[]; access: Access; handler: Handler }[] = [];
  const route = (method: string, path: string, access: Access, handler: Handler) => {
    const keys: string[] = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), '([A-Za-z0-9_-]+)')) + '$');
    routes.push({ method, re, keys, access, handler });
  };
  const ctxOf = async (user: UserPublic | null) => db.loadState(user);
  const ownerPerson = async () => {
    const p = (await db.loadState(null)).people.find((x) => x.is_me);
    if (!p) throw new HttpError(500, 'No "me" person configured');
    return p;
  };
  const clientIp = (req: IncomingMessage) => (opts.trustProxy !== false ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '') || req.socket.remoteAddress || 'unknown';
  const setSessionCookie = (c: Ctx, value: string | null) => {
    const secure = c.req.headers['x-forwarded-proto'] === 'https' || process.env.VERCEL ? '; Secure' : '';
    c.res.setHeader('set-cookie', `${COOKIE}=${value ?? ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${value ? 30 * 86_400 : 0}${secure}`);
  };

  // --- health & auth ------------------------------------------------------------------------
  route('GET', '/api/health', 'public', async () => {
    await db.ping();
    return { ok: true, time: new Date().toISOString() };
  });
  route('GET', '/api/auth/status', 'public', async (c) => ({ needsSetup: (await db.userCount()) === 0, user: c.user }));
  route('POST', '/api/auth/setup', 'public', async (c) => {
    if ((await db.userCount()) > 0) throw new HttpError(409, 'Already set up. Sign in instead.');
    const me = await ownerPerson();
    const password_hash = await hashPassword(password(c.body.password));
    const user = await db.createUser({ email: email(c.body.email), name: str(c.body.name, 'Name'), password_hash, role: 'owner', person_id: me.id });
    setSessionCookie(c, createSession(secret, user.id, passwordFingerprint(password_hash)));
    return { user };
  });
  route('POST', '/api/auth/login', 'public', async (c) => {
    const ip = clientIp(c.req);
    if (limiter.locked(ip)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const u = await db.getUserByEmail(String(c.body.email ?? '').trim().toLowerCase());
    if (!u || !(await verifyPassword(String(c.body.password ?? ''), u.password_hash))) {
      limiter.fail(ip);
      throw new HttpError(401, 'Wrong email or password');
    }
    limiter.reset(ip);
    setSessionCookie(c, createSession(secret, u.id, passwordFingerprint(u.password_hash)));
    const { password_hash: _ph, ...user } = u;
    return { user };
  });
  route('POST', '/api/auth/logout', 'public', (c) => (setSessionCookie(c, null), { ok: true }));
  route('POST', '/api/auth/password', 'user', async (c) => {
    const u = await db.getUserByEmail(c.user!.email);
    if (!u || !(await verifyPassword(String(c.body.current ?? ''), u.password_hash))) throw new HttpError(400, 'Current password is wrong');
    const password_hash = await hashPassword(password(c.body.next));
    await db.setPassword(u.id, password_hash);
    setSessionCookie(c, createSession(secret, u.id, passwordFingerprint(password_hash)));
    return { ok: true };
  });

  // --- access management (owner) ------------------------------------------------------------
  route('POST', '/api/invites', 'owner', async (c) => {
    const inv = await db.createInvite({ token: randomToken(), person_id: int(c.body.person_id, 'Person'), created_by: c.user!.id, expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString().replace('T', ' ').slice(0, 19) });
    return inv;
  });
  route('DELETE', '/api/invites/:id', 'owner', async (c) => (await db.deleteInvite(Number(c.params.id)), { ok: true }));
  route('GET', '/api/invites/:token', 'public', async (c) => {
    const inv = await db.getInvite(c.params.token ?? '');
    if (!inv) throw new HttpError(410, 'This invite link has expired or was already used.');
    return { person_name: inv.person_name, owner_name: inv.owner_name, expires_at: inv.expires_at };
  });
  route('POST', '/api/invites/:token/accept', 'public', async (c) => {
    const inv = await db.getInvite(c.params.token ?? '');
    if (!inv) throw new HttpError(410, 'This invite link has expired or was already used.');
    const password_hash = await hashPassword(password(c.body.password));
    const user = await db.createUser({ email: email(c.body.email), name: str(c.body.name ?? inv.person_name, 'Name'), password_hash, role: 'member', person_id: inv.person_id }, inv.id);
    setSessionCookie(c, createSession(secret, user.id, passwordFingerprint(password_hash)));
    return { user };
  });
  route('DELETE', '/api/users/:id', 'owner', async (c) => {
    if (Number(c.params.id) === c.user!.id) throw new HttpError(400, 'You cannot remove yourself');
    await db.deleteUser(Number(c.params.id));
    return { ok: true };
  });

  // --- view-only share links ----------------------------------------------------------------
  route('POST', '/api/shares', 'user', async (c) => db.createShare({ token: randomToken(18), trip_id: int(c.body.trip_id, 'Trip'), label: optStr(c.body.label), created_by: c.user!.id }));
  route('DELETE', '/api/shares/:id', 'user', async (c) => (await db.revokeShare(Number(c.params.id)), { ok: true }));
  route('GET', '/api/shared/:token', 'public', async (c) => {
    const share = await db.getShare(c.params.token ?? '');
    if (!share) throw new HttpError(404, 'This link has been turned off or never existed.');
    return db.loadSharedState(share.trip_id);
  });

  // --- ledger ---------------------------------------------------------------------------------
  route('GET', '/api/state', 'user', (c) => db.loadState(c.user));
  route('PUT', '/api/settings', 'user', async (c) => {
    if (c.body.home_currency !== undefined) await db.setSetting('home_currency', currency(c.body.home_currency));
    if (c.body.rates !== undefined) await db.setSetting('rates', JSON.stringify(rates(c.body.rates) ?? {}));
    return { ok: true };
  });

  route('POST', '/api/people', 'user', (c) => db.createPerson(str(c.body.name, 'Name')));
  route('PUT', '/api/people/:id', 'user', async (c) => (await db.updatePerson(Number(c.params.id), { name: str(c.body.name, 'Name'), archived: flag(c.body.archived), upi_id: upi(c.body.upi_id) }), { ok: true }));
  route('DELETE', '/api/people/:id', 'user', async (c) => (await db.deletePerson(Number(c.params.id)), { ok: true }));

  const accountBody = async (c: Ctx): Promise<Omit<Account, 'id'>> => {
    const b = c.body;
    const type = String(b.type ?? 'cash') as Account['type'];
    if (!ACCOUNT_TYPES.includes(type)) throw new HttpError(400, 'Unknown account type');
    const people = (await ctxOf(c.user)).people;
    const fallback = people.find((p) => p.id === c.user?.person_id) ?? people.find((p) => p.is_me);
    const person_id = b.person_id == null || b.person_id === '' ? fallback?.id : int(b.person_id, 'Owner');
    if (person_id == null || !people.some((p) => p.id === person_id)) throw new HttpError(400, 'Owner not found');
    return { person_id, name: str(b.name, 'Name'), type, currency: currency(b.currency), opening_balance: int(b.opening_balance ?? 0, 'Opening balance'), archived: flag(b.archived) };
  };
  route('POST', '/api/accounts', 'user', async (c) => db.createAccount(await accountBody(c)));
  route('PUT', '/api/accounts/:id', 'user', async (c) => (await db.updateAccount(Number(c.params.id), await accountBody(c)), { ok: true }));
  route('DELETE', '/api/accounts/:id', 'user', async (c) => (await db.deleteAccount(Number(c.params.id)), { ok: true }));

  const tripBody = async (c: Ctx): Promise<Omit<Trip, 'id'>> => {
    const b = c.body;
    const people = (await ctxOf(c.user)).people;
    const members = [...new Set((Array.isArray(b.members) ? b.members : []).map((m) => int(m, 'Member')))];
    if (members.some((m) => !people.some((p) => p.id === m))) throw new HttpError(400, 'Member not found');
    const start_date = b.start_date ? date(b.start_date, 'Start date') : null;
    const end_date = b.end_date ? date(b.end_date, 'End date') : null;
    if (start_date && end_date && end_date < start_date) throw new HttpError(400, 'End date is before the start date');
    return { name: str(b.name, 'Name'), start_date, end_date, currency: currency(b.currency), notes: optStr(b.notes), archived: flag(b.archived), members, rates: rates(b.rates) };
  };
  route('POST', '/api/trips', 'user', async (c) => db.createTrip(await tripBody(c)));
  route('PUT', '/api/trips/:id', 'user', async (c) => (await db.updateTrip(Number(c.params.id), await tripBody(c)), { ok: true }));
  route('DELETE', '/api/trips/:id', 'user', async (c) => (await db.deleteTrip(Number(c.params.id)), { ok: true }));

  const txBody = async (c: Ctx, id?: number) => {
    const tx = normalizeTx(id == null ? c.body : { ...c.body, id });
    const errors = validateTx(tx, await ctxOf(c.user));
    if (errors.length) throw new HttpError(422, 'Transaction is not valid', errors);
    return tx;
  };
  route('POST', '/api/transactions', 'user', async (c) => db.createTx(await txBody(c)));
  route('PUT', '/api/transactions/:id', 'user', async (c) => db.updateTx(Number(c.params.id), await txBody(c, Number(c.params.id))));
  route('DELETE', '/api/transactions/:id', 'user', async (c) => (await db.deleteTx(Number(c.params.id)), { ok: true }));
  route('GET', '/api/transactions/:id', 'user', (c) => db.getTx(Number(c.params.id)));

  route('POST', '/api/reconciliations', 'user', (c) =>
    db.createReconciliation({ account_id: int(c.body.account_id, 'Account'), date: date(c.body.date, 'Date'), counted_amount: int(c.body.counted_amount, 'Counted amount'), expected_amount: int(c.body.expected_amount, 'Expected amount'), note: optStr(c.body.note) }),
  );
  route('DELETE', '/api/reconciliations/:id', 'user', async (c) => (await db.deleteReconciliation(Number(c.params.id)), { ok: true }));

  route('POST', '/api/seed', 'owner', async () => {
    if (!(await db.isEmpty())) throw new HttpError(409, 'Sample data is only loaded into an empty ledger');
    await seed(db);
    return { ok: true };
  });
  route('GET', '/api/backup', 'owner', () => db.backup());
  route('POST', '/api/restore', 'owner', async (c) => (await db.restore(c.body), { ok: true }));
  route('DELETE', '/api/activity', 'owner', async () => (await db.clearActivity(), { ok: true }));
  route('POST', '/api/snapshot', 'owner', async () => {
    const file = join(resolve('backups'), `ledger-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    await db.snapshot(file);
    return { file };
  });

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      if (url.pathname.startsWith('/api/')) {
        const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
        if (!r) return send(404, { error: 'Not found' });
        const session = readSession(secret, parseCookies(req.headers.cookie)[COOKIE]);
        const row = session ? await db.getUserAuth(session.uid) : undefined;
        const user: UserPublic | null = row && passwordFingerprint(row.password_hash) === session!.fp ? (({ password_hash: _p, ...pub }) => pub)(row) : null;
        if (r.access !== 'public' && !user) return send(401, { error: 'Sign in to continue', code: 'unauthenticated' });
        if (r.access === 'owner' && user?.role !== 'owner') return send(403, { error: 'Only the owner can do that' });
        const m = r.re.exec(url.pathname)!;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1] ?? '']));
        const body = ['POST', 'PUT'].includes(req.method ?? '') ? await readJson(req) : {};
        return send(200, await r.handler({ params, body, url, req, res, user }));
      }
      if (!staticDir) return send(404, { error: 'Not found' });
      // Static SPA (built with `yarn build`); the dev server proxies /api instead.
      const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
      const file = join(staticDir, rel);
      const path = file.startsWith(staticDir) && existsSync(file) ? file : join(staticDir, 'index.html');
      if (!existsSync(path)) return send(404, { error: 'Web app not built. Run `yarn build` (or `yarn dev`).' });
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream', 'cache-control': path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
      res.end(readFileSync(path));
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message, details: e.details });
      console.error(e);
      send(500, { error: 'Something went wrong on the server. Nothing was changed.' });
    }
  };

  return { handle, db, server: createServer((req, res) => void handle(req, res)) };
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  // Vercel's runtime may have parsed the body already.
  const pre = (req as IncomingMessage & { body?: unknown }).body;
  if (pre !== undefined) {
    if (typeof pre === 'string') return Promise.resolve(parseBody(pre));
    return Promise.resolve(pre && typeof pre === 'object' && !Array.isArray(pre) ? (pre as Record<string, unknown>) : {});
  }
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) reject(new HttpError(413, 'Body too large'));
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolvePromise(parseBody(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function parseBody(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}
