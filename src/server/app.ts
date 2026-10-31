import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { ACCOUNT_TYPES, allocate, formatAmount, guessCategory, normalizeTx, parseMoney, validateTx, type Account, type LedgerState, type Recurring, type Trip, type TripBudget, type UserPublic } from '../engine/index.ts';
import { HttpError, involves, openDb, type Db } from './db.ts';
import { RateLimiter, createSession, hashPassword, isEmail, parseCookies, passwordFingerprint, randomToken, readSession, tokenHash, verifyPassword } from './auth.ts';
import { seed } from './seed.ts';
import { CHUNK, MAX_DOC, isStorageKey, objectStoreFromEnv } from './storage.ts';
import { FEATURES, type DocItem, type Id, type PlanItem, type PlanMeta } from '../engine/index.ts';
import { announce, publicKey } from './push.ts';

interface Ctx {
  params: Record<string, string>;
  body: Record<string, unknown>;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  user: UserPublic | null;
}
type Handler = (c: Ctx) => unknown;
type Access = 'public' | 'user' | 'owner' | 'key'; // key: a signed-in session or a Shortcut key (Authorization: Bearer)
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
/** A reply that is not JSON (receipt photos). */
class Raw {
  type: string;
  body: Buffer;
  constructor(type: string, body: Buffer) {
    this.type = type;
    this.body = body;
  }
}
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
/** { total, categories: { Food: n } } in minor units of the home currency; blanks drop out, an all-blank budget is null. */
const budget = (v: unknown): TripBudget | null => {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
  const b = v as { total?: unknown; categories?: unknown };
  const amount = (x: unknown, label: string): number | null => {
    if (x == null || x === '') return null;
    const n = int(x, label);
    if (n <= 0) throw new HttpError(400, `${label} must be more than zero`);
    return n;
  };
  const categories: Record<string, number> = {};
  for (const [k, x] of Object.entries(b.categories && typeof b.categories === 'object' ? b.categories : {})) {
    const n = amount(x, `${k} budget`);
    if (n != null && k.trim()) categories[k.trim().slice(0, 40)] = n;
  }
  const total = amount(b.total, 'Budget');
  return total != null || Object.keys(categories).length ? { total, categories } : null;
};
const repeat = (v: unknown): Recurring['every'] | null => {
  if (v == null || v === '') return null;
  if (v !== 'weekly' && v !== 'monthly') throw new HttpError(400, 'Repeat must be weekly or monthly');
  return v;
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
  const routes: { method: string; re: RegExp; keys: string[]; access: Access; handler: Handler; raw: boolean }[] = [];
  const route = (method: string, path: string, access: Access, handler: Handler, opts: { raw?: boolean } = {}) => {
    const keys: string[] = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), '([A-Za-z0-9_-]+)')) + '$');
    routes.push({ method, re, keys, access, handler, raw: !!opts.raw });
  };
  const ctxOf = async (user: UserPublic | null) => db.loadState(user);
  const isOwner = (c: Ctx) => c.user?.role === 'owner';
  // Members may only touch what their own slice of the ledger holds (each trip is a group); the owner sees everything.
  const mustSee = async (c: Ctx, has: (s: LedgerState) => boolean, what: string) => {
    if (!isOwner(c) && !has(await ctxOf(c.user))) throw new HttpError(404, `${what} not found`);
  };
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
  route('POST', '/api/shares', 'user', async (c) => {
    const trip_id = c.body.trip_id == null || c.body.trip_id === '' ? null : int(c.body.trip_id, 'Trip');
    const person_id = c.body.person_id == null || c.body.person_id === '' ? null : int(c.body.person_id, 'Person');
    await mustSee(c, (s) => s.trips.some((t) => t.id === trip_id) && (person_id == null || s.people.some((p) => p.id === person_id)), 'Trip'); // members share one of their trips only
    return db.createShare({ token: randomToken(18), trip_id, person_id, label: optStr(c.body.label), created_by: c.user!.id });
  });
  route('DELETE', '/api/shares/:id', 'user', async (c) => {
    await mustSee(c, (s) => s.shares.some((x) => x.id === Number(c.params.id)), 'Link');
    return (await db.revokeShare(Number(c.params.id)), { ok: true });
  });
  route('GET', '/api/shared/:token', 'public', async (c) => {
    const share = await db.getShare(c.params.token ?? '');
    if (!share) throw new HttpError(404, 'This link has been turned off or never existed.');
    return db.loadSharedState(share);
  });

  // --- ledger ---------------------------------------------------------------------------------
  route('GET', '/api/state', 'user', (c) => db.loadState(c.user, true));
  route('POST', '/api/seen', 'user', async (c) => (await db.markSeen(c.user!.id), { ok: true }));
  route('PUT', '/api/settings', 'owner', async (c) => {
    if (c.body.home_currency !== undefined) await db.setSetting('home_currency', currency(c.body.home_currency));
    if (c.body.rates !== undefined) await db.setSetting('rates', JSON.stringify(rates(c.body.rates) ?? {}));
    if (c.body.flags !== undefined) {
      const raw = (c.body.flags && typeof c.body.flags === 'object' ? c.body.flags : {}) as Record<string, unknown>;
      const known = new Set<string>(FEATURES.map((f) => f.key));
      for (const [k, v] of Object.entries(raw)) if (!known.has(k) || typeof v !== 'boolean') throw new HttpError(400, `Unknown feature flag ${k}`);
      await db.setSetting('flags', JSON.stringify(raw));
    }
    if (c.body.shortcut_link !== undefined) {
      const link = optStr(c.body.shortcut_link);
      if (link && !/^https:\/\/www\.icloud\.com\/shortcuts\/[A-Za-z0-9]+$/.test(link)) throw new HttpError(400, 'Paste the iCloud link from Shortcuts (https://www.icloud.com/shortcuts/…)');
      await db.setSetting('shortcut_link', link ?? '');
    }
    return { ok: true };
  });

  route('POST', '/api/people', 'owner', (c) => db.createPerson(str(c.body.name, 'Name')));
  route('PUT', '/api/people/:id', 'user', async (c) => {
    if (!isOwner(c) && Number(c.params.id) !== c.user!.person_id) throw new HttpError(403, 'You can only edit your own name and UPI ID');
    return (await db.updatePerson(Number(c.params.id), { name: str(c.body.name, 'Name'), archived: flag(c.body.archived), upi_id: upi(c.body.upi_id) }), { ok: true });
  });
  route('DELETE', '/api/people/:id', 'owner', async (c) => (await db.deletePerson(Number(c.params.id)), { ok: true }));

  const accountBody = async (c: Ctx): Promise<Omit<Account, 'id'>> => {
    const b = c.body;
    const type = String(b.type ?? 'cash') as Account['type'];
    if (!ACCOUNT_TYPES.includes(type)) throw new HttpError(400, 'Unknown account type');
    const people = (await ctxOf(c.user)).people;
    const fallback = people.find((p) => p.id === c.user?.person_id) ?? people.find((p) => p.is_me);
    const person_id = b.person_id == null || b.person_id === '' ? fallback?.id : int(b.person_id, 'Owner');
    if (person_id == null || !people.some((p) => p.id === person_id)) throw new HttpError(400, 'Owner not found');
    if (!isOwner(c) && person_id !== c.user!.person_id) throw new HttpError(403, 'You can only manage your own accounts');
    return { person_id, name: str(b.name, 'Name'), type, currency: currency(b.currency), opening_balance: int(b.opening_balance ?? 0, 'Opening balance'), archived: flag(b.archived) };
  };
  route('POST', '/api/accounts', 'user', async (c) => db.createAccount(await accountBody(c)));
  const ownAccount = (c: Ctx, id: number) => mustSee(c, (s) => s.accounts.some((a) => a.id === id && a.person_id === c.user!.person_id), 'Account');
  route('PUT', '/api/accounts/:id', 'user', async (c) => (await ownAccount(c, Number(c.params.id)), await db.updateAccount(Number(c.params.id), await accountBody(c)), { ok: true }));
  route('DELETE', '/api/accounts/:id', 'user', async (c) => (await ownAccount(c, Number(c.params.id)), await db.deleteAccount(Number(c.params.id)), { ok: true }));

  const tripBody = async (c: Ctx): Promise<Omit<Trip, 'id'>> => {
    const b = c.body;
    const people = (await ctxOf(c.user)).people;
    const members = [...new Set((Array.isArray(b.members) ? b.members : []).map((m) => int(m, 'Member')))];
    if (members.some((m) => !people.some((p) => p.id === m))) throw new HttpError(400, 'Member not found');
    const start_date = b.start_date ? date(b.start_date, 'Start date') : null;
    const end_date = b.end_date ? date(b.end_date, 'End date') : null;
    if (start_date && end_date && end_date < start_date) throw new HttpError(400, 'End date is before the start date');
    return { name: str(b.name, 'Name'), start_date, end_date, currency: currency(b.currency), notes: optStr(b.notes), archived: flag(b.archived), members, rates: rates(b.rates), budget: budget(b.budget), closed: flag(b.closed) };
  };
  route('POST', '/api/trips', 'owner', async (c) => db.createTrip(await tripBody(c)));
  route('PUT', '/api/trips/:id', 'owner', async (c) => (await db.updateTrip(Number(c.params.id), await tripBody(c)), { ok: true }));
  route('DELETE', '/api/trips/:id', 'owner', async (c) => (await db.deleteTrip(Number(c.params.id)), { ok: true }));

  const txBody = async (c: Ctx, id?: number) => {
    const tx = normalizeTx(id == null ? c.body : { ...c.body, id });
    const ctx = await ctxOf(c.user);
    const errors = validateTx(tx, ctx); // a member's ctx holds only their trips, people and accounts
    // A closed trip's spending is locked until the owner reopens it; settle-ups (repayments) still go in, so its own balances can clear.
    const old = id != null ? ctx.transactions.find((t) => t.id === id) : undefined;
    const settling = tx.type === 'repayment' && (!old || old.type === 'repayment');
    const shut = settling ? undefined : (await db.closedTrip(tx.trip_id)) ?? (old ? await db.closedTrip(old.trip_id) : undefined);
    if (shut) throw new HttpError(409, `${shut} is closed. Reopen it to change its entries.`);
    if (!isOwner(c)) {
      if (id != null && !ctx.transactions.some((t) => t.id === id)) throw new HttpError(404, 'Transaction not found');
      if (tx.trip_id == null && !involves(tx, c.user!.person_id)) errors.push('An entry outside your trips has to include you');
    }
    if (errors.length) throw new HttpError(422, 'Transaction is not valid', errors);
    return tx;
  };
  route('POST', '/api/transactions', 'user', async (c) => {
    const tx = await txBody(c);
    const every = repeat(c.body.repeat);
    if (every && tx.type === 'refund') throw new HttpError(400, 'A refund cannot repeat');
    const saved = await db.createTx(tx, c.user!.person_id, { client_ref: optStr(c.body.queue_ref)?.slice(0, 64), repeat: every });
    await announce(db, c.user!, saved, 'added');
    return saved;
  });
  route('PUT', '/api/transactions/:id', 'user', async (c) => {
    const saved = await db.updateTx(Number(c.params.id), await txBody(c, Number(c.params.id)), c.user!.person_id);
    await announce(db, c.user!, saved, 'edited');
    return saved;
  });
  const seeTx = (c: Ctx) => mustSee(c, (s) => s.transactions.some((t) => t.id === Number(c.params.id)), 'Transaction');
  route('DELETE', '/api/transactions/:id', 'user', async (c) => {
    await seeTx(c);
    const old = await db.getTx(Number(c.params.id));
    const shut = old.type === 'repayment' ? undefined : await db.closedTrip(old.trip_id);
    if (shut) throw new HttpError(409, `${shut} is closed. Reopen it to change its entries.`);
    return (await db.deleteTx(Number(c.params.id)), { ok: true });
  });
  route('GET', '/api/transactions/:id', 'user', async (c) => (await seeTx(c), db.getTx(Number(c.params.id))));
  route('DELETE', '/api/recurring/:id', 'user', async (c) => {
    await mustSee(c, (s) => !!s.recurring?.some((r) => r.id === Number(c.params.id)), 'Repeating entry');
    return (await db.stopRecurring(Number(c.params.id)), { ok: true });
  });

  route('POST', '/api/transactions/:id/comments', 'user', async (c) => {
    await seeTx(c);
    const comment = await db.addComment(Number(c.params.id), c.user!.person_id, str(c.body.body, 'Comment', 1000));
    await announce(db, c.user!, await db.getTx(Number(c.params.id)), { comment: comment.body });
    return comment;
  });
  // Members remove their own comments; the owner can remove any.
  route('DELETE', '/api/comments/:id', 'user', async (c) => {
    await mustSee(c, (s) => !!s.comments?.some((x) => x.id === Number(c.params.id) && x.person_id === c.user!.person_id), 'Comment');
    return (await db.deleteComment(Number(c.params.id)), { ok: true });
  });

  // --- Apple Pay → Kitty (iPhone Shortcuts "Transaction" automation) --------------------------
  route('GET', '/api/keys', 'user', (c) => db.listKeys(c.user!.id));
  route('POST', '/api/keys', 'user', async (c) => {
    const token = `kitty_${randomToken(24)}`;
    return { ...(await db.createKey(c.user!.id, tokenHash(token))), token }; // shown once; only the hash is kept
  });
  route('DELETE', '/api/keys/:id', 'user', async (c) => (await db.deleteKey(Number(c.params.id), c.user!.id), { ok: true }));
  /**
   * Called on every Apple Pay tap. Without `action` it says whether to ask (only on the dates of an open trip you are on)
   * and what to ask; with action split / mine it records the expense, with edit it returns a link to the prefilled form.
   * Replies to an action are plain text so the Shortcut can show them as a notification as they are.
   */
  route('POST', '/api/shortcut', 'key', async (c) => {
    const user = c.user!;
    const pid = user.person_id;
    const state = await ctxOf(user);
    const day = /^\d{4}-\d{2}-\d{2}/.exec(String(c.body.date ?? ''))?.[0] ?? new Date().toISOString().slice(0, 10); // the phone's local date
    const action = String(c.body.action ?? '').trim().toLowerCase();
    const text = (s: string) => new Raw('text/plain; charset=utf-8', Buffer.from(s));
    const live = state.trips.filter((t) => !t.closed && !t.archived && pid != null && t.members.includes(pid) && t.start_date && t.end_date && t.start_date <= day && day <= t.end_date);
    if (!live.length) return action ? text(action.startsWith('skip') ? '' : 'No trip on today’s date in Kitty, so nothing was added.') : { ask: 'no' };
    const money = parseMoney(String(c.body.amount ?? ''), live[0]!.currency);
    if (!money) return action ? text('Kitty could not read that amount. Add it in the app.') : { ask: 'no' };
    const trip = live.find((t) => t.currency === money.currency) ?? live[0]!;
    const merchant = String(c.body.merchant ?? '').trim().slice(0, 100) || 'Apple Pay';
    const label = `${formatAmount(money.amount, money.currency)} at ${merchant}`;
    const category = guessCategory(merchant);
    if (!action) return { ask: 'yes', prompt: `${label}: add to ${trip.name}?`, trip: trip.name };
    if (action.startsWith('skip')) return text('');
    if (action.startsWith('edit')) {
      const origin = `${String(c.req.headers['x-forwarded-proto'] ?? 'http').split(',')[0]}://${c.req.headers.host}`;
      return text(`${origin}/#/add?${new URLSearchParams({ amount: String(money.amount), currency: money.currency, description: merchant, trip: String(trip.id), date: day, ...(category ? { category } : {}) })}`);
    }
    const mine = action.startsWith('just') || action === 'mine';
    if (!mine && !action.startsWith('split')) throw new HttpError(400, 'Choice must be split, mine, edit or skip');
    const people = mine ? [pid!] : trip.members;
    const shares = allocate(money.amount, people.map(() => 1));
    const card = optStr(c.body.card)?.slice(0, 60);
    // "Kitty expense" (typed in) says paid: cash, so the money leaves your cash wallet in that currency and cash in hand stays right.
    const cash = String(c.body.paid ?? '').toLowerCase() === 'cash' ? state.accounts.find((a) => a.person_id === pid && a.type === 'cash' && !a.archived && a.currency === money.currency) : undefined;
    const source = cash ? `Cash (${cash.name})` : c.body.paid ? 'Kitty expense shortcut' : `Apple Pay${card ? ` (${card})` : ''}`;
    const tx = normalizeTx({ type: 'expense', date: day, description: merchant, category, trip_id: trip.id, currency: money.currency, amount: money.amount, payer_id: pid, from_account_id: cash?.id ?? null, split_method: 'equal', splits: people.map((p, i) => ({ person_id: p, amount: shares[i], input: null })), notes: `From ${source}` });
    const errors = validateTx(tx, state);
    if (errors.length) return text(`Not added: ${errors[0]}`);
    const saved = await db.createTx(tx, pid);
    await announce(db, user, saved, 'added');
    return text(`Added to ${trip.name}: ${label}${mine ? ', just you' : `, split ${people.length} ways`}${cash ? `, from ${cash.name}` : ''}`);
  });

  route('GET', '/api/push/key', 'user', async () => ({ key: await publicKey(db) }));
  route('POST', '/api/push', 'user', async (c) => {
    const keys = (c.body.keys ?? {}) as { p256dh?: unknown; auth?: unknown };
    const endpoint = str(c.body.endpoint, 'Endpoint', 1000);
    if (!/^https:\/\//.test(endpoint)) throw new HttpError(400, 'Not a push subscription');
    await db.savePushSub(c.user!.id, { endpoint, p256dh: str(keys.p256dh, 'Key', 200), auth: str(keys.auth, 'Auth', 100) });
    return { ok: true };
  });
  route('POST', '/api/push/off', 'user', async (c) => (await db.removePushSub(str(c.body.endpoint, 'Endpoint', 1000)), { ok: true }));

  // Receipt photos arrive already shrunk by the browser, as a data URL.
  route('POST', '/api/transactions/:id/receipts', 'user', async (c) => {
    await seeTx(c);
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/.exec(String(c.body.data ?? ''));
    if (!m) throw new HttpError(400, 'Attach a JPEG, PNG or WebP photo');
    if (m[2]!.length > 3_000_000) throw new HttpError(413, 'That photo is too large');
    return db.addReceipt(Number(c.params.id), m[1]!, m[2]!, c.user!.person_id);
  });
  route('GET', '/api/receipts/:id', 'user', async (c) => {
    const r = await db.getReceipt(Number(c.params.id));
    if (!r) throw new HttpError(404, 'Receipt not found');
    await mustSee(c, (s) => s.transactions.some((t) => t.id === r.tx_id), 'Receipt');
    return new Raw(r.mime, Buffer.from(r.data, 'base64'));
  });
  route('DELETE', '/api/receipts/:id', 'user', async (c) => {
    await mustSee(c, (s) => !!s.receipts?.some((r) => r.id === Number(c.params.id)), 'Receipt');
    return (await db.deleteReceipt(Number(c.params.id)), { ok: true });
  });

  route('POST', '/api/reconciliations', 'user', async (c) => {
    const account_id = int(c.body.account_id, 'Account');
    await ownAccount(c, account_id);
    return db.createReconciliation({ account_id, date: date(c.body.date, 'Date'), counted_amount: int(c.body.counted_amount, 'Counted amount'), expected_amount: int(c.body.expected_amount, 'Expected amount'), note: optStr(c.body.note) });
  });
  route('DELETE', '/api/reconciliations/:id', 'user', async (c) => {
    await mustSee(c, (s) => s.reconciliations.some((r) => r.id === Number(c.params.id)), 'Reconciliation');
    return (await db.deleteReconciliation(Number(c.params.id)), { ok: true });
  });

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

  // --- documents: encrypted in the browser; the API keeps wrapped keys and serves ciphertext in chunks ---------
  const store = objectStoreFromEnv(); // R2 when its variables are set; otherwise the blobs live in the database
  const b64 = (v: unknown, label: string) => {
    const s = String(v ?? '');
    if (!/^[A-Za-z0-9_-]{8,4096}$/.test(s)) throw new HttpError(400, `${label} is not valid`);
    return s;
  };
  const optId = (v: unknown, label: string) => (v == null || v === '' ? null : int(v, label));
  const storageKey = (v: unknown) => {
    const s = String(v ?? '');
    if (!isStorageKey(s)) throw new HttpError(400, 'Storage key is not valid');
    return s;
  };
  const chunkIndex = (c: Ctx) => {
    const n = Number(c.url.searchParams.get('n'));
    if (!Number.isInteger(n) || n < 0 || n > MAX_DOC / CHUNK) throw new HttpError(400, 'Bad chunk number');
    return n;
  };
  const chunkReply = async (key: string, c: Ctx) => {
    const data = await db.getChunk(key, chunkIndex(c));
    if (!data) throw new HttpError(404, 'Not found');
    return new Raw('application/octet-stream', data);
  };
  /** How the browser fetches a document's ciphertext: one signed URL (R2) or a chunk URL plus how many chunks. */
  const location = async (doc: DocItem, chunkUrl: string) => (store ? { url: await store.downloadUrl(doc.storage_key) } : { url: chunkUrl, chunks: await db.chunkCount(doc.storage_key) });
  route('GET', '/api/docs', 'owner', async () => ({ storage: store?.kind ?? 'db', ...(await db.docsState()) }));
  route('POST', '/api/docs/vault', 'owner', async (c) => (await db.createVault({ salt: b64(c.body.salt, 'Salt'), check_iv: b64(c.body.check_iv, 'Check'), check_ct: b64(c.body.check_ct, 'Check') }), { ok: true }));
  route('PUT', '/api/docs/vault', 'owner', async (c) => {
    const folders = (Array.isArray(c.body.folders) ? c.body.folders : []).map((f) => {
      const o = (f ?? {}) as Record<string, unknown>;
      return { id: int(o.id, 'Folder'), key_iv: b64(o.key_iv, 'Key'), key_ct: b64(o.key_ct, 'Key') };
    });
    await db.rewrapVault({ salt: b64(c.body.salt, 'Salt'), check_iv: b64(c.body.check_iv, 'Check'), check_ct: b64(c.body.check_ct, 'Check') }, folders);
    return { ok: true };
  });
  route('POST', '/api/docs/folders', 'owner', async (c) => db.createFolder({ name: str(c.body.name, 'Name'), parent_id: optId(c.body.parent_id, 'Folder'), trip_id: optId(c.body.trip_id, 'Trip'), key_iv: c.body.key_iv == null ? null : b64(c.body.key_iv, 'Key'), key_ct: c.body.key_ct == null ? null : b64(c.body.key_ct, 'Key') }));
  route('PUT', '/api/docs/folders/:id', 'owner', async (c) => (await db.renameFolder(Number(c.params.id), str(c.body.name, 'Name')), { ok: true }));
  route('DELETE', '/api/docs/folders/:id', 'owner', async (c) => {
    const keys = await db.deleteFolder(Number(c.params.id));
    if (store) await Promise.allSettled(keys.map((k) => store.remove(k)));
    return { ok: true };
  });
  // Upload: the browser encrypts, then either PUTs to a signed bucket URL or PUTs the ciphertext here one chunk at a time.
  // ponytail: chunks of an upload that never gets registered stay behind; sweep them if the database ever grows for no reason.
  route('POST', '/api/docs/upload', 'owner', async (c) => {
    const folder = await db.getFolder(int(c.body.folder_id, 'Folder'));
    const size = int(c.body.size, 'Size');
    if (size <= 0 || size > MAX_DOC) throw new HttpError(400, 'Files can be up to 200 MB');
    const storage_key = `d${folder.id}_${randomToken(18)}`;
    return store ? { storage_key, url: await store.uploadUrl(storage_key) } : { storage_key, url: `/api/docs/blob/${storage_key}`, chunk: CHUNK };
  });
  route('PUT', '/api/docs/blob/:key', 'owner', async (c) => {
    if (store) throw new HttpError(400, 'Uploads go straight to the bucket');
    const key = storageKey(c.params.key);
    const n = chunkIndex(c);
    const data = await readRaw(c.req, CHUNK);
    if (!data.length) throw new HttpError(400, 'Empty chunk');
    await db.putChunk(key, n, data);
    return { ok: true };
  }, { raw: true });
  route('GET', '/api/docs/blob/:key', 'owner', (c) => chunkReply(storageKey(c.params.key), c));
  route('POST', '/api/docs/shares', 'owner', async (c) => db.createDocShare({ token: randomToken(18), folder_id: int(c.body.folder_id, 'Folder'), label: optStr(c.body.label) }));
  route('DELETE', '/api/docs/shares/:id', 'owner', async (c) => (await db.revokeDocShare(Number(c.params.id)), { ok: true }));
  const sharedDoc = async (c: Ctx) => {
    const share = await db.docShareByToken(c.params.token ?? '');
    if (!share) throw new HttpError(404, 'This link has been turned off or never existed.');
    if (c.params.id == null) return { share, doc: null };
    const doc = await db.getDocument(Number(c.params.id));
    if (!(await db.folderWithin(doc.folder_id, share.folder_id))) throw new HttpError(404, 'Document not found');
    return { share, doc };
  };
  route('GET', '/api/docs/shared/:token', 'public', async (c) => db.sharedDocs((await sharedDoc(c)).share.folder_id));
  route('GET', '/api/docs/shared/:token/:id/url', 'public', async (c) => {
    const { share, doc } = await sharedDoc(c);
    return location(doc!, `/api/docs/shared/${share.token}/${doc!.id}/blob`);
  });
  route('GET', '/api/docs/shared/:token/:id/blob', 'public', async (c) => chunkReply((await sharedDoc(c)).doc!.storage_key, c));
  route('POST', '/api/docs', 'owner', async (c) => {
    const storage_key = storageKey(c.body.storage_key);
    if (!store && !(await db.chunkCount(storage_key))) throw new HttpError(400, 'Nothing was uploaded for this file');
    return db.createDocument({ folder_id: int(c.body.folder_id, 'Folder'), name: str(c.body.name, 'Name', 200), mime: str(c.body.mime, 'Type', 100), size: int(c.body.size, 'Size'), storage_key, iv: b64(c.body.iv, 'IV') });
  });
  route('GET', '/api/docs/:id/url', 'owner', async (c) => {
    const doc = await db.getDocument(Number(c.params.id));
    return location(doc, `/api/docs/blob/${doc.storage_key}`);
  });
  route('PUT', '/api/docs/:id', 'owner', async (c) => (await db.renameDocument(Number(c.params.id), str(c.body.name, 'Name', 200)), { ok: true }));
  route('DELETE', '/api/docs/:id', 'owner', async (c) => {
    const key = await db.deleteDocument(Number(c.params.id));
    if (store) await store.remove(key).catch(() => undefined);
    return { ok: true };
  });

  // --- trip plan: board, stay shortlist with votes, checklists. Members edit; a trip link can vote and tick --------
  const PLAN_KINDS = ['day', 'task', 'pack', 'stay', 'link', 'note'] as const;
  const planKind = (v: unknown): PlanItem['kind'] => {
    const k = String(v ?? '');
    if (!(PLAN_KINDS as readonly string[]).includes(k)) throw new HttpError(400, 'Unknown plan item kind');
    return k as PlanItem['kind'];
  };
  const planMeta = (v: unknown): PlanMeta | null => {
    if (v == null) return null;
    const o = (typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const price = o.price == null || o.price === '' ? null : int(o.price, 'Price');
    if (price != null && price < 0) throw new HttpError(400, 'Price cannot be negative');
    return { price, distance: optStr(o.distance), chosen: o.chosen === true };
  };
  const planUrl = (v: unknown, kind: PlanItem['kind']) => {
    const s = optStr(v);
    if (s && (kind === 'link' || kind === 'stay') && !/^https?:\/\//i.test(s)) throw new HttpError(400, 'Links must start with http:// or https://');
    return s;
  };
  const seeTrip = (c: Ctx, tripId: Id) => mustSee(c, (s) => s.trips.some((t) => t.id === tripId), 'Trip');
  const planOf = async (c: Ctx) => {
    const it = await db.planItem(Number(c.params.id));
    await seeTrip(c, it.trip_id);
    return it;
  };
  route('POST', '/api/trips/:id/plan', 'user', async (c) => {
    const trip_id = Number(c.params.id);
    await seeTrip(c, trip_id);
    const kind = planKind(c.body.kind);
    return db.createPlanItem({ trip_id, kind, title: str(c.body.title, 'Title', 300), body: planUrl(c.body.body, kind), meta: kind === 'stay' ? planMeta(c.body.meta) : null, day: c.body.day ? date(c.body.day, 'Day') : null, assignee_id: optId(c.body.assignee_id, 'Assignee'), created_by: c.user!.person_id ?? null });
  });
  route('PUT', '/api/plan/:id', 'user', async (c) => {
    const it = await planOf(c);
    const patch: Parameters<typeof db.updatePlanItem>[1] = {};
    if (c.body.title !== undefined) patch.title = str(c.body.title, 'Title', 300);
    if (c.body.body !== undefined) patch.body = planUrl(c.body.body, it.kind);
    if (c.body.meta !== undefined) patch.meta = it.kind === 'stay' ? planMeta(c.body.meta) : null;
    if (c.body.day !== undefined) patch.day = c.body.day ? date(c.body.day, 'Day') : null;
    if (c.body.done !== undefined) patch.done = flag(c.body.done);
    if (c.body.assignee_id !== undefined) patch.assignee_id = optId(c.body.assignee_id, 'Assignee');
    await db.updatePlanItem(it.id, patch);
    return { ok: true };
  });
  route('POST', '/api/plan/:id/choose', 'user', async (c) => (await db.chooseStay((await planOf(c)).id), { ok: true }));
  route('DELETE', '/api/plan/:id', 'user', async (c) => (await db.deletePlanItem((await planOf(c)).id), { ok: true }));
  route('POST', '/api/plan/:id/vote', 'user', async (c) => {
    const it = await planOf(c);
    const person = isOwner(c) && c.body.person_id != null ? int(c.body.person_id, 'Person') : c.user!.person_id;
    if (person == null) throw new HttpError(400, 'Your login is not linked to a person');
    return { voted: await db.toggleVote(it.id, person) };
  });
  // From a trip link: pick your name, then vote or tick. Trusted as far as the link is.
  const linkMember = async (c: Ctx) => {
    const share = await db.getShare(c.params.token ?? '');
    if (!share || share.trip_id == null) throw new HttpError(404, 'This link has been turned off or never existed.');
    const it = await db.planItem(Number(c.params.id));
    if (it.trip_id !== share.trip_id) throw new HttpError(404, 'Not on this trip');
    const person = int(c.body.person_id, 'Person');
    if (!(await db.isTripMember(share.trip_id, person))) throw new HttpError(400, 'Pick a name from this trip');
    return { it, person };
  };
  route('POST', '/api/shared/:token/plan/:id/vote', 'public', async (c) => {
    const { it, person } = await linkMember(c);
    if (it.kind !== 'stay') throw new HttpError(400, 'Only stay options take votes');
    return { voted: await db.toggleVote(it.id, person) };
  });
  route('PUT', '/api/shared/:token/plan/:id/done', 'public', async (c) => {
    const { it } = await linkMember(c);
    if (it.kind !== 'task' && it.kind !== 'pack') throw new HttpError(400, 'Only checklist items can be ticked');
    await db.updatePlanItem(it.id, { done: flag(c.body.done) });
    return { ok: true };
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
        let user: UserPublic | null = row && passwordFingerprint(row.password_hash) === session!.fp ? (({ password_hash: _p, ...pub }) => pub)(row) : null;
        const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
        if (!user && r.access === 'key' && bearer) user = (await db.userByKey(tokenHash(bearer))) ?? null;
        if (r.access !== 'public' && !user) return send(401, { error: 'Sign in to continue', code: 'unauthenticated' });
        if (r.access === 'owner' && user?.role !== 'owner') return send(403, { error: 'Only the owner can do that' });
        const m = r.re.exec(url.pathname)!;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1] ?? '']));
        const body = !r.raw && ['POST', 'PUT'].includes(req.method ?? '') ? await readJson(req) : {};
        const out = await r.handler({ params, body, url, req, res, user });
        if (out instanceof Raw) {
          res.writeHead(200, { 'content-type': out.type, 'cache-control': 'private, max-age=31536000, immutable' }); // a receipt never changes; removing it retires the id
          return res.end(out.body);
        }
        return send(200, out);
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

/** The whole request body as bytes (one document chunk). */
function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((ok, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) reject(new HttpError(413, 'File too large'));
      else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
