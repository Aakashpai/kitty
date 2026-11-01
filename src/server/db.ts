import { createClient, LibsqlError, type Client, type InValue } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DocFolder, DocItem, DocShare, PlanItem, PlanVote, SharedDocs, Vault } from '../engine/index.ts';
import { formatAmount, validateTx, type Account, type Activity, type Comment, type Id, type Invite, type LedgerState, type Person, type Reconciliation, type Recurring, type Share, type Trip, type TripBudget, type Tx, type TxInput, type UserPublic } from '../engine/index.ts';

// Each entry runs once, in order; schema_migrations remembers which have been applied.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO settings VALUES ('home_currency', 'INR');
  CREATE TABLE people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    is_me INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO people (name, is_me) VALUES ('Me', 1);
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL REFERENCES people(id),
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('cash','bank','card','wallet','other')),
    currency TEXT NOT NULL CHECK (length(currency) = 3),
    opening_balance INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    start_date TEXT,
    end_date TEXT,
    currency TEXT NOT NULL CHECK (length(currency) = 3),
    notes TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE trip_members (
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    person_id INTEGER NOT NULL REFERENCES people(id),
    PRIMARY KEY (trip_id, person_id)
  );
  CREATE TABLE transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('expense','transfer','withdrawal','repayment','income','refund')),
    date TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    notes TEXT,
    category TEXT,
    trip_id INTEGER REFERENCES trips(id),
    currency TEXT NOT NULL CHECK (length(currency) = 3),
    amount INTEGER NOT NULL CHECK (amount > 0),
    payer_id INTEGER REFERENCES people(id),
    payee_id INTEGER REFERENCES people(id),
    from_account_id INTEGER REFERENCES accounts(id),
    from_amount INTEGER,
    to_account_id INTEGER REFERENCES accounts(id),
    to_amount INTEGER,
    fee_amount INTEGER,
    settled_amount INTEGER,
    settled_currency TEXT,
    linked_tx_id INTEGER REFERENCES transactions(id),
    method TEXT,
    reference TEXT,
    split_method TEXT,
    full_settlement INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_tx_date ON transactions(date);
  CREATE INDEX idx_tx_trip ON transactions(trip_id);
  CREATE INDEX idx_tx_linked ON transactions(linked_tx_id);
  CREATE TABLE splits (
    tx_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    person_id INTEGER NOT NULL REFERENCES people(id),
    amount INTEGER NOT NULL CHECK (amount >= 0),
    input REAL,
    PRIMARY KEY (tx_id, person_id)
  );
  CREATE TABLE reconciliations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    counted_amount INTEGER NOT NULL,
    expected_amount INTEGER NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id INTEGER,
    summary TEXT NOT NULL,
    payload TEXT
  );
  `,
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner','member')),
    person_id INTEGER REFERENCES people(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    person_id INTEGER NOT NULL REFERENCES people(id),
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE TABLE shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    label TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    revoked INTEGER NOT NULL DEFAULT 0
  );
  `,
  `
  ALTER TABLE trips ADD COLUMN rates TEXT;
  INSERT OR IGNORE INTO settings (key, value) VALUES ('rates', '{}');
  `,
  `
  ALTER TABLE people ADD COLUMN upi_id TEXT;
  `,
  `
  CREATE TABLE shares_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    trip_id INTEGER REFERENCES trips(id) ON DELETE CASCADE,
    person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,
    label TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    revoked INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO shares_v2 (id, token, trip_id, label, created_by, created_at, revoked) SELECT id, token, trip_id, label, created_by, created_at, revoked FROM shares;
  DROP TABLE shares;
  ALTER TABLE shares_v2 RENAME TO shares;
  `,
  `
  ALTER TABLE transactions ADD COLUMN added_by INTEGER;
  ALTER TABLE transactions ADD COLUMN edited_by INTEGER;
  ALTER TABLE transactions ADD COLUMN recurring_id INTEGER;
  ALTER TABLE transactions ADD COLUMN client_ref TEXT;
  CREATE UNIQUE INDEX idx_tx_client_ref ON transactions(client_ref) WHERE client_ref IS NOT NULL;
  ALTER TABLE trips ADD COLUMN budget TEXT;
  ALTER TABLE users ADD COLUMN seen_at TEXT;
  UPDATE users SET seen_at = datetime('now');
  CREATE TABLE receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_id INTEGER NOT NULL,
    mime TEXT NOT NULL,
    data TEXT NOT NULL,
    added_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_receipts_tx ON receipts(tx_id);
  CREATE TABLE recurring (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    every TEXT NOT NULL CHECK (every IN ('weekly','monthly')),
    next_date TEXT NOT NULL,
    template TEXT NOT NULL,
    created_by INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  `
  ALTER TABLE trips ADD COLUMN closed INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE transactions ADD COLUMN items TEXT;
  CREATE TABLE comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_id INTEGER NOT NULL,
    person_id INTEGER,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_comments_tx ON comments(tx_id);
  CREATE TABLE push_subs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  `
  CREATE TABLE api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );
  `,
  `
  CREATE TABLE vault (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    salt TEXT NOT NULL,
    check_iv TEXT NOT NULL,
    check_ct TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE doc_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES doc_folders(id) ON DELETE CASCADE,
    trip_id INTEGER REFERENCES trips(id) ON DELETE SET NULL,
    key_iv TEXT,
    key_ct TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id INTEGER NOT NULL REFERENCES doc_folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    iv TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE doc_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    folder_id INTEGER NOT NULL REFERENCES doc_folders(id) ON DELETE CASCADE,
    label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    revoked INTEGER NOT NULL DEFAULT 0
  );
  `,
  `
  CREATE TABLE doc_chunks (
    storage_key TEXT NOT NULL,
    n INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (storage_key, n)
  );
  `,
  `
  CREATE TABLE plan_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    meta TEXT,
    day TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    assignee_id INTEGER,
    sort INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE plan_votes (
    item_id INTEGER NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
    person_id INTEGER NOT NULL,
    PRIMARY KEY (item_id, person_id)
  );
  `,
  `
  CREATE TABLE plan_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL UNIQUE,
    mime TEXT NOT NULL,
    data TEXT NOT NULL
  );
  ALTER TABLE shares ADD COLUMN bookings_only INTEGER NOT NULL DEFAULT 0;
  `,
];

const parseBudget = (v: unknown): TripBudget | null => {
  if (typeof v !== 'string' || !v) return null;
  try {
    return JSON.parse(v) as TripBudget;
  } catch {
    return null;
  }
};

/** Next run of a repeating entry: a week on, or the same day next month (the 31st becomes the 30th or 28th, then back). */
export const nextDate = (date: string, every: Recurring['every'], anchor = Number(date.slice(8, 10))): string => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  if (every === 'weekly') return new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(anchor, last))).toISOString().slice(0, 10);
};

const IMAGE_ID = '(SELECT i.id FROM plan_images i WHERE i.item_id = p.id) AS image_id';
const parsePlan = (p: PlanItem): PlanItem => {
  if (typeof p.meta === 'string') { try { p.meta = JSON.parse(p.meta) as PlanItem['meta']; } catch { p.meta = null; } }
  return p;
};
const PLAN_LABEL: Record<PlanItem['kind'], string> = { day: 'Itinerary', task: 'To-do', pack: 'Packing', stay: 'Stay option', link: 'Link', note: 'Note', booking: 'Booking' };

const parseFlags = (v: unknown): Record<string, boolean> => {
  if (typeof v !== 'string' || !v) return {};
  try {
    const o = JSON.parse(v) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(o).filter(([, b]) => typeof b === 'boolean')) as Record<string, boolean>;
  } catch {
    return {};
  }
};

const parseRates = (v: unknown): Record<string, number> | null => {
  if (typeof v !== 'string' || !v) return null;
  try {
    const o = JSON.parse(v) as Record<string, number>;
    return o && typeof o === 'object' && Object.keys(o).length ? o : null;
  } catch {
    return null;
  }
};

export class HttpError extends Error {
  status: number;
  details: string[];
  constructor(status: number, message: string, details: string[] = []) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

type Val = InValue;
type Row = Record<string, Val>;
type Exec = Pick<Client, 'execute'>;
interface UserRow extends UserPublic { password_hash: string }

const TX_COLS = [
  'type', 'date', 'description', 'notes', 'category', 'trip_id', 'currency', 'amount', 'payer_id', 'payee_id',
  'from_account_id', 'from_amount', 'to_account_id', 'to_amount', 'fee_amount', 'settled_amount', 'settled_currency',
  'linked_tx_id', 'method', 'reference', 'split_method', 'full_settlement', 'items',
] as const;
/** Itemised bills are stored as JSON text; everything else is a plain column. */
const parseItems = (tx: Tx) => {
  tx.items = typeof tx.items === 'string' ? (JSON.parse(tx.items) as Tx['items']) : null;
  return tx;
};
// Receipt photos stay out of the JSON backup: a few of them would pass the 4.5 MB response limit on Vercel.
// Phone subscriptions stay out too: they belong to devices, not to the ledger.
const BACKUP_TABLES = ['settings', 'people', 'accounts', 'trips', 'trip_members', 'transactions', 'splits', 'reconciliations', 'activity', 'users', 'invites', 'shares', 'recurring', 'comments', 'vault', 'doc_folders', 'documents', 'doc_shares', 'plan_items', 'plan_votes'] as const;
const USER_COLS = 'id, email, name, role, person_id, created_at, seen_at';
const INSERT_TX = `INSERT INTO transactions (${TX_COLS.join(', ')}, added_by, recurring_id, client_ref) VALUES (${TX_COLS.map(() => '?').join(', ')}, ?, ?, ?) RETURNING id`;

const isLocal = (url: string) => url.startsWith('file:') || url === ':memory:';

/** Turns a driver error into something the API can show. Connection problems become a 503. */
function friendly(e: unknown): unknown {
  if (e instanceof HttpError) return e;
  if (e instanceof LibsqlError) {
    if (/SQLITE_CONSTRAINT/.test(e.code)) {
      if (/FOREIGN KEY/i.test(e.message)) return new HttpError(409, 'This record is still referenced by transactions. Archive it instead, or delete those transactions first.');
      if (/UNIQUE/i.test(e.message)) return new HttpError(409, 'That already exists.');
      return new HttpError(409, `Database constraint failed: ${e.message}`);
    }
    return new HttpError(503, 'The database is unreachable right now. Nothing was changed.');
  }
  if (e instanceof Error && /fetch failed|ECONN|ENOTFOUND|socket|WebSocket|Hrana/i.test(e.message)) return new HttpError(503, 'The database is unreachable right now. Nothing was changed.');
  return e;
}

const q = (x: Exec) => ({
  all: async <T = Row>(sql: string, args: Val[] = []): Promise<T[]> => (await x.execute({ sql, args })).rows as unknown as T[],
  get: async <T = Row>(sql: string, args: Val[] = []): Promise<T | undefined> => (await x.execute({ sql, args })).rows[0] as unknown as T | undefined,
  run: async (sql: string, args: Val[] = []) => {
    const r = await x.execute({ sql, args });
    return { changes: r.rowsAffected };
  },
});
type Q = ReturnType<typeof q>;

export async function openDb(url: string, authToken?: string) {
  if (url.startsWith('file:')) mkdirSync(dirname(url.slice(5)), { recursive: true });
  const client = createClient({ url, authToken });
  const root = q(client);
  try {
    if (isLocal(url)) {
      if (url !== ':memory:') await client.execute('PRAGMA journal_mode = WAL');
      await client.execute('PRAGMA foreign_keys = ON');
    }
    await client.execute('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
    const done = (await root.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations'))?.v ?? 0;
    for (let i = done; i < MIGRATIONS.length; i++) {
      await client.executeMultiple(`BEGIN; ${MIGRATIONS[i]}; INSERT INTO schema_migrations (version) VALUES (${i + 1}); COMMIT;`);
    }
  } catch (e) {
    throw friendly(e);
  }

  // Runs fn inside one write transaction; any error rolls everything back.
  const inTx = async <T>(fn: (t: Q) => Promise<T>): Promise<T> => {
    let tx;
    try {
      tx = await client.transaction('write');
    } catch (e) {
      throw friendly(e);
    }
    try {
      const out = await fn(q(tx));
      await tx.commit();
      return out;
    } catch (e) {
      await tx.rollback().catch(() => undefined);
      throw friendly(e);
    }
  };
  const read = async <T>(fn: (t: Q) => Promise<T>): Promise<T> => {
    try {
      return await fn(root);
    } catch (e) {
      throw friendly(e);
    }
  };
  const logIn = (t: Q, action: Activity['action'], entity: string, entity_id: Id | null, summary: string, payload?: unknown) =>
    t.run('INSERT INTO activity (action, entity, entity_id, summary, payload) VALUES (?, ?, ?, ?, ?)', [action, entity, entity_id, summary, payload === undefined ? null : JSON.stringify(payload)]);

  /** A folder and every folder under it (ids), or [] when it does not exist. */
  const folderTree = async (t: Q, id: Id): Promise<Id[]> => {
    if (!(await t.get('SELECT 1 FROM doc_folders WHERE id = ?', [id]))) return [];
    const ids: Id[] = [id];
    for (let i = 0; i < ids.length; i++) for (const k of await t.all<{ id: Id }>('SELECT id FROM doc_folders WHERE parent_id = ?', [ids[i]!])) ids.push(k.id);
    return ids;
  };
  const loadTx = async (t: Q, id: Id): Promise<Tx> => {
    const row = await t.get<Tx>('SELECT * FROM transactions WHERE id = ?', [id]);
    if (!row) throw new HttpError(404, 'Transaction not found');
    row.splits = await t.all<Tx['splits'][number]>('SELECT person_id, amount, input FROM splits WHERE tx_id = ? ORDER BY person_id', [id]);
    return parseItems(row);
  };
  const writeSplits = async (t: Q, id: Id, splits: TxInput['splits']) => {
    await t.run('DELETE FROM splits WHERE tx_id = ?', [id]);
    for (const s of splits) await t.run('INSERT INTO splits (tx_id, person_id, amount, input) VALUES (?, ?, ?, ?)', [id, s.person_id, s.amount, s.input]);
  };
  const txParams = (tx: TxInput): Val[] => TX_COLS.map((c) => (c === 'items' ? (tx.items?.length ? JSON.stringify(tx.items) : null) : ((tx[c] ?? null) as Val)));
  const personInUse = async (t: Q, id: Id) =>
    !!(await t.get('SELECT 1 FROM transactions WHERE payer_id = ? OR payee_id = ? LIMIT 1', [id, id])) ||
    !!(await t.get('SELECT 1 FROM splits WHERE person_id = ? LIMIT 1', [id])) ||
    !!(await t.get('SELECT 1 FROM accounts WHERE person_id = ? LIMIT 1', [id]));

  const api = {
    url,
    isLocal: isLocal(url),
    close: () => client.close(),
    // Reads a real row, not just SELECT 1: the cron in vercel.json (days 1, 10, 19, 28; never more than 9 days apart) calls this so Turso's free plan, which archives after 10 idle days, never does.
    ping: () => read((t) => t.get("SELECT value FROM settings WHERE key = 'home_currency'")),

    /** One round trip for everything the client needs; the UI reloads this after every save. `materialize` first adds any repeating entries that are due. */
    loadState: async (user: UserPublic | null, materialize = false): Promise<LedgerState> => {
      const owner = user?.role === 'owner';
      const stmts = [
        { sql: 'SELECT id, name, start_date, end_date, currency, notes, archived, rates, budget, closed FROM trips ORDER BY start_date DESC, id DESC' },
        { sql: 'SELECT trip_id, person_id FROM trip_members ORDER BY person_id' },
        { sql: 'SELECT * FROM transactions ORDER BY date DESC, id DESC' },
        { sql: 'SELECT tx_id, person_id, amount, input FROM splits ORDER BY person_id' },
        { sql: 'SELECT key, value FROM settings' },
        { sql: 'SELECT id, name, is_me, archived, upi_id FROM people ORDER BY is_me DESC, LOWER(name)' },
        { sql: 'SELECT id, person_id, name, type, currency, opening_balance, archived FROM accounts ORDER BY archived, LOWER(name)' },
        { sql: 'SELECT * FROM reconciliations ORDER BY date DESC, id DESC' },
        { sql: 'SELECT * FROM activity ORDER BY id DESC LIMIT 300' },
        { sql: 'SELECT * FROM shares WHERE revoked = 0 ORDER BY id DESC' },
        { sql: 'SELECT id, every, next_date, template, created_by FROM recurring WHERE active = 1 ORDER BY next_date, id' },
        { sql: 'SELECT id, tx_id FROM receipts ORDER BY id' },
        { sql: 'SELECT id, tx_id, person_id, body, created_at FROM comments ORDER BY id' },
        { sql: `SELECT p.*, ${IMAGE_ID} FROM plan_items p ORDER BY trip_id, kind, sort, id` },
        { sql: 'SELECT item_id, person_id FROM plan_votes' },
        ...(owner ? [{ sql: `SELECT ${USER_COLS} FROM users ORDER BY id` }, { sql: "SELECT * FROM invites WHERE used_at IS NULL AND expires_at > datetime('now') ORDER BY id DESC" }] : []),
      ];
      let rs;
      try {
        rs = await client.batch(stmts, 'read');
      } catch (e) {
        throw friendly(e);
      }
      const rows = <T>(i: number): T[] => (rs[i]?.rows ?? []) as unknown as T[];
      const trips = rows<Trip>(0);
      const members = rows<{ trip_id: Id; person_id: Id }>(1);
      for (const trip of trips) {
        trip.members = members.filter((m) => m.trip_id === trip.id).map((m) => m.person_id);
        trip.rates = parseRates(trip.rates as unknown);
        trip.budget = parseBudget(trip.budget as unknown);
      }
      const recurring = rows<Recurring & { template: string | TxInput }>(10).map((r) => ({ ...r, template: JSON.parse(r.template as string) as TxInput }));
      const today = new Date().toISOString().slice(0, 10);
      if (materialize && recurring.some((r) => r.next_date <= today)) {
        await api.runRecurring(today);
        return api.loadState(user);
      }
      const transactions = rows<Tx>(2);
      const byTx = new Map<Id, Tx['splits']>();
      for (const sp of rows<Tx['splits'][number] & { tx_id: Id }>(3)) {
        let list = byTx.get(sp.tx_id);
        if (!list) byTx.set(sp.tx_id, (list = []));
        list.push({ person_id: sp.person_id, amount: sp.amount, input: sp.input });
      }
      for (const tx of transactions) parseItems(tx).splits = byTx.get(tx.id) ?? [];
      const settingRows = rows<{ key: string; value: string }>(4);
      const setting = (k: string) => settingRows.find((r) => r.key === k)?.value;
      const state: LedgerState = {
        settings: { home_currency: setting('home_currency') ?? 'USD', rates: parseRates(setting('rates')) ?? {}, shortcut_link: setting('shortcut_link') ?? null, flags: parseFlags(setting('flags')), square_under: Number(setting('square_under')) || null },
        people: rows<Person>(5),
        accounts: rows<Account>(6),
        trips,
        transactions,
        reconciliations: rows<Reconciliation>(7),
        activity: rows<Activity>(8),
        shares: rows<Share>(9),
        recurring,
        receipts: rows<{ id: Id; tx_id: Id }>(11),
        comments: rows<Comment>(12),
        plan: rows<PlanItem>(13).map(parsePlan),
        votes: rows<PlanVote>(14),
        user,
      };
      if (owner) {
        state.users = rows<UserPublic>(15);
        state.invites = rows<Invite>(16);
      }
      return user && !owner ? memberSlice(state, user.person_id, user.id) : state;
    },
    /** Read-only view for a share link: one trip, or one person's entries across trips. No accounts, no personal money movements, no history. */
    loadSharedState: async (share: { trip_id: Id | null; person_id: Id | null; bookings_only?: 0 | 1 | null }): Promise<LedgerState> => {
      const { trip_id: tripId, person_id: personId } = share;
      const bookingsOnly = !!share.bookings_only && tripId != null;
      const scope = ["type IN ('expense','refund','repayment')"];
      if (bookingsOnly) scope.push('0'); // a family link carries no money at all
      const args: number[] = [];
      if (tripId != null) { scope.push('trip_id = ?'); args.push(tripId); }
      if (personId != null) { scope.push('(payer_id = ? OR payee_id = ? OR id IN (SELECT tx_id FROM splits WHERE person_id = ?))'); args.push(personId, personId, personId); }
      const where = scope.join(' AND ');
      // A trip link gets the trip's board (bookings only on a family link); a person link gets the bookings of their trips.
      const planWhere = tripId != null ? `p.trip_id = ?${bookingsOnly ? " AND p.kind = 'booking'" : ''}` : "p.kind = 'booking' AND p.trip_id IN (SELECT trip_id FROM trip_members WHERE person_id = ?)";
      const planArgs = [tripId ?? personId ?? -1];
      let rs;
      try {
        rs = await client.batch([
          { sql: 'SELECT id, name, start_date, end_date, currency, notes, archived, rates, budget FROM trips ORDER BY id' },
          { sql: 'SELECT trip_id, person_id FROM trip_members ORDER BY person_id' },
          { sql: `SELECT * FROM transactions WHERE ${where} ORDER BY date DESC, id DESC`, args },
          { sql: `SELECT tx_id, person_id, amount, input FROM splits WHERE tx_id IN (SELECT id FROM transactions WHERE ${where}) ORDER BY person_id`, args },
          { sql: 'SELECT key, value FROM settings' },
          { sql: 'SELECT id, name, is_me, archived, upi_id FROM people ORDER BY is_me DESC, LOWER(name)' },
          { sql: 'SELECT id, person_id, name, type, currency, archived FROM accounts ORDER BY id' },
          { sql: `SELECT p.*, ${IMAGE_ID} FROM plan_items p WHERE ${planWhere} ORDER BY kind, sort, id`, args: planArgs },
          { sql: `SELECT item_id, person_id FROM plan_votes WHERE item_id IN (SELECT id FROM plan_items p WHERE ${planWhere})`, args: planArgs },
        ], 'read');
      } catch (e) {
        throw friendly(e);
      }
      const rows = <T>(i: number): T[] => (rs[i]?.rows ?? []) as unknown as T[];
      const transactions = rows<Tx>(2);
      const members = rows<{ trip_id: Id; person_id: Id }>(1);
      const plan = rows<PlanItem>(7).map(parsePlan);
      const used = new Set([...transactions.map((t) => t.trip_id), ...plan.map((p) => p.trip_id)]);
      const trips = rows<Trip>(0).filter((t) => (tripId != null ? t.id === tripId : used.has(t.id)));
      if (tripId != null && !trips.length) throw new HttpError(404, 'This link no longer works');
      for (const trip of trips) {
        trip.members = members.filter((m) => m.trip_id === trip.id).map((m) => m.person_id);
        trip.rates = parseRates(trip.rates as unknown);
        trip.budget = parseBudget(trip.budget as unknown);
      }
      const byTx = new Map<Id, Tx['splits']>();
      for (const sp of rows<Tx['splits'][number] & { tx_id: Id }>(3)) {
        let list = byTx.get(sp.tx_id);
        if (!list) byTx.set(sp.tx_id, (list = []));
        list.push({ person_id: sp.person_id, amount: sp.amount, input: sp.input });
      }
      for (const tx of transactions) {
        parseItems(tx).splits = byTx.get(tx.id) ?? [];
        tx.reference = tx.notes = null;
      }
      const people = rows<Person>(5);
      // Account names and the real home-currency charge per entry stay, so the link values card spends exactly as the owner sees them; balances do not travel.
      const accounts = rows<Account>(6).map((a) => ({ ...a, opening_balance: 0 }));
      if (personId != null) {
        if (!people.some((p) => p.id === personId)) throw new HttpError(404, 'This link no longer works');
        for (const p of people) p.is_me = p.id === personId ? 1 : 0; // the page speaks to them
      }
      const settingRows = rows<{ key: string; value: string }>(4);
      const setting = (k: string) => settingRows.find((r) => r.key === k)?.value;
      return {
        settings: { home_currency: setting('home_currency') ?? trips[0]?.currency ?? 'USD', rates: parseRates(setting('rates')) ?? {}, flags: parseFlags(setting('flags')), square_under: Number(setting('square_under')) || null },
        people,
        accounts,
        trips,
        transactions,
        reconciliations: [],
        activity: [],
        shares: [],
        plan,
        votes: rows<PlanVote>(8),
        user: null,
        shared_person_id: personId,
        shared_bookings_only: bookingsOnly,
      };
    },
    getSetting: (key: string) => read(async (t) => (await t.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]))?.value ?? null),
    setSetting: (key: string, value: string) => read((t) => t.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value])),

    createPerson: (name: string) => inTx(async (t) => {
      const row = (await t.get<{ id: number }>('INSERT INTO people (name) VALUES (?) RETURNING id', [name]))!;
      await logIn(t, 'create', 'person', row.id, `Added ${name}`);
      return (await t.get<Person>('SELECT id, name, is_me, archived, upi_id FROM people WHERE id = ?', [row.id]))!;
    }),
    updatePerson: (id: Id, p: { name: string; archived: 0 | 1; upi_id: string | null }) => inTx(async (t) => {
      if (!(await t.run('UPDATE people SET name = ?, archived = ?, upi_id = ? WHERE id = ?', [p.name, p.archived, p.upi_id, id])).changes) throw new HttpError(404, 'Person not found');
      await logIn(t, 'update', 'person', id, `Updated ${p.name}`);
    }),
    deletePerson: (id: Id) => inTx(async (t) => {
      const p = await t.get<Person>('SELECT * FROM people WHERE id = ?', [id]);
      if (!p) throw new HttpError(404, 'Person not found');
      if (p.is_me) throw new HttpError(400, 'You cannot delete yourself');
      if (await personInUse(t, id)) throw new HttpError(409, `${p.name} appears in transactions. Archive them instead.`);
      if (await t.get('SELECT 1 FROM users WHERE person_id = ?', [id])) throw new HttpError(409, `${p.name} has a login. Remove their access first.`);
      await t.run('DELETE FROM invites WHERE person_id = ?', [id]);
      await t.run('DELETE FROM trip_members WHERE person_id = ?', [id]);
      await t.run('DELETE FROM shares WHERE person_id = ?', [id]);
      await t.run('DELETE FROM people WHERE id = ?', [id]);
      await logIn(t, 'delete', 'person', id, `Deleted ${p.name}`, p);
    }),

    createAccount: (a: Omit<Account, 'id'>) => inTx(async (t) => {
      const row = (await t.get<{ id: number }>('INSERT INTO accounts (person_id, name, type, currency, opening_balance, archived) VALUES (?, ?, ?, ?, ?, ?) RETURNING id', [a.person_id, a.name, a.type, a.currency, a.opening_balance, a.archived]))!;
      await logIn(t, 'create', 'account', row.id, `Added account ${a.name} (${a.currency})`);
      return { ...a, id: row.id };
    }),
    updateAccount: (id: Id, a: Omit<Account, 'id'>) => inTx(async (t) => {
      if (!(await t.run('UPDATE accounts SET person_id = ?, name = ?, type = ?, currency = ?, opening_balance = ?, archived = ? WHERE id = ?', [a.person_id, a.name, a.type, a.currency, a.opening_balance, a.archived, id])).changes) throw new HttpError(404, 'Account not found');
      await logIn(t, 'update', 'account', id, `Updated account ${a.name}`);
    }),
    deleteAccount: (id: Id) => inTx(async (t) => {
      const a = await t.get<Account>('SELECT * FROM accounts WHERE id = ?', [id]);
      if (!a) throw new HttpError(404, 'Account not found');
      if (await t.get('SELECT 1 FROM transactions WHERE from_account_id = ? OR to_account_id = ? LIMIT 1', [id, id])) throw new HttpError(409, `${a.name} is used by transactions. Archive it instead.`);
      await t.run('DELETE FROM accounts WHERE id = ?', [id]);
      await logIn(t, 'delete', 'account', id, `Deleted account ${a.name}`, a);
    }),

    createTrip: (tr: Omit<Trip, 'id'>) => inTx(async (t) => {
      const row = (await t.get<{ id: number }>('INSERT INTO trips (name, start_date, end_date, currency, notes, archived, rates, budget, closed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id', [tr.name, tr.start_date, tr.end_date, tr.currency, tr.notes, tr.archived, tr.rates ? JSON.stringify(tr.rates) : null, tr.budget ? JSON.stringify(tr.budget) : null, tr.closed ?? 0]))!;
      for (const m of tr.members) await t.run('INSERT INTO trip_members (trip_id, person_id) VALUES (?, ?)', [row.id, m]);
      await logIn(t, 'create', 'trip', row.id, `Created trip ${tr.name}`);
      return { ...tr, id: row.id };
    }),
    updateTrip: (id: Id, tr: Omit<Trip, 'id'>) => inTx(async (t) => {
      const was = await t.get<{ closed: number }>('SELECT closed FROM trips WHERE id = ?', [id]);
      if (!was) throw new HttpError(404, 'Trip not found');
      await t.run('UPDATE trips SET name = ?, start_date = ?, end_date = ?, currency = ?, notes = ?, archived = ?, rates = ?, budget = ?, closed = ? WHERE id = ?', [tr.name, tr.start_date, tr.end_date, tr.currency, tr.notes, tr.archived, tr.rates ? JSON.stringify(tr.rates) : null, tr.budget ? JSON.stringify(tr.budget) : null, tr.closed ?? 0, id]);
      await t.run('DELETE FROM trip_members WHERE trip_id = ?', [id]);
      for (const m of tr.members) await t.run('INSERT INTO trip_members (trip_id, person_id) VALUES (?, ?)', [id, m]);
      await logIn(t, 'update', 'trip', id, !!was.closed !== !!tr.closed ? `${tr.closed ? 'Closed' : 'Reopened'} trip ${tr.name}` : `Updated trip ${tr.name}`);
    }),
    deleteTrip: (id: Id) => inTx(async (t) => {
      const tr = await t.get<Trip>('SELECT * FROM trips WHERE id = ?', [id]);
      if (!tr) throw new HttpError(404, 'Trip not found');
      if (await t.get('SELECT 1 FROM transactions WHERE trip_id = ? LIMIT 1', [id])) throw new HttpError(409, 'This trip has transactions. Archive it, or move its transactions first.');
      await t.run('DELETE FROM shares WHERE trip_id = ?', [id]);
      await t.run('DELETE FROM trip_members WHERE trip_id = ?', [id]);
      await t.run('DELETE FROM trips WHERE id = ?', [id]);
      await logIn(t, 'delete', 'trip', id, `Deleted trip ${tr.name}`, tr);
    }),

    /** `by` is the person recording it; `client_ref` makes a resend from the offline queue return the first copy instead of a duplicate. */
    createTx: (tx: TxInput, by: Id | null = null, extra: { client_ref?: string | null; repeat?: Recurring['every'] | null } = {}) => inTx(async (t) => {
      if (extra.client_ref) {
        const dup = await t.get<{ id: number }>('SELECT id FROM transactions WHERE client_ref = ?', [extra.client_ref]);
        if (dup) return loadTx(t, dup.id);
      }
      const row = (await t.get<{ id: number }>(INSERT_TX, [...txParams(tx), by, null, extra.client_ref ?? null]))!;
      await writeSplits(t, row.id, tx.splits);
      if (extra.repeat) {
        const { id: _id, ...template } = tx;
        const rule = (await t.get<{ id: number }>('INSERT INTO recurring (every, next_date, template, created_by) VALUES (?, ?, ?, ?) RETURNING id', [extra.repeat, nextDate(tx.date, extra.repeat), JSON.stringify(template), by]))!;
        await t.run('UPDATE transactions SET recurring_id = ? WHERE id = ?', [rule.id, row.id]);
      }
      const saved = await loadTx(t, row.id);
      await logIn(t, 'create', 'transaction', row.id, `Added ${tx.type}: ${txLabel(saved)}`, saved);
      return saved;
    }),
    updateTx: (id: Id, tx: TxInput, by: Id | null = null) => inTx(async (t) => {
      const before = await loadTx(t, id);
      await t.run(`UPDATE transactions SET ${TX_COLS.map((c) => `${c} = ?`).join(', ')}, edited_by = ?, updated_at = datetime('now') WHERE id = ?`, [...txParams(tx), by, id]);
      await writeSplits(t, id, tx.splits);
      const saved = await loadTx(t, id);
      await logIn(t, 'update', 'transaction', id, `Edited ${tx.type}: ${txLabel(saved)}`, { before, after: saved });
      return saved;
    }),
    deleteTx: (id: Id) => inTx(async (t) => {
      const tx = await loadTx(t, id);
      if (await t.get('SELECT 1 FROM transactions WHERE linked_tx_id = ? LIMIT 1', [id])) throw new HttpError(409, 'This expense has refunds linked to it. Delete or unlink the refunds first.');
      await t.run('DELETE FROM splits WHERE tx_id = ?', [id]);
      await t.run('DELETE FROM receipts WHERE tx_id = ?', [id]);
      await t.run('DELETE FROM comments WHERE tx_id = ?', [id]);
      await t.run('DELETE FROM transactions WHERE id = ?', [id]);
      await logIn(t, 'delete', 'transaction', id, `Deleted ${tx.type}: ${txLabel(tx)}`, tx);
    }),
    getTx: (id: Id) => read((t) => loadTx(t, id)),

    /**
     * Adds every due copy of each repeating entry (catching up if nobody opened the app for a while) and moves its next date
     * on. A rule whose person, trip or account no longer checks out is switched off rather than writing a broken entry.
     */
    runRecurring: async (today: string) => {
      const ctx = await api.loadState(null);
      for (const r of ctx.recurring ?? []) {
        if (r.next_date > today) continue;
        if (validateTx(r.template, ctx).length || ctx.trips.some((t) => t.id === r.template.trip_id && t.closed)) {
          await read((t) => t.run('UPDATE recurring SET active = 0 WHERE id = ?', [r.id]));
          continue;
        }
        await inTx(async (t) => {
          // Re-read inside the write lock: a request racing this one may already have done it.
          const cur = await t.get<{ next_date: string }>('SELECT next_date FROM recurring WHERE id = ? AND active = 1', [r.id]);
          if (!cur || cur.next_date > today) return;
          const anchor = Number(r.template.date.slice(8, 10));
          let next = cur.next_date;
          for (let n = 0; next <= today && n < 120; n++) {
            const copy = { ...r.template, date: next };
            const row = (await t.get<{ id: number }>(INSERT_TX, [...txParams(copy), r.created_by, r.id, null]))!;
            await writeSplits(t, row.id, copy.splits);
            await logIn(t, 'create', 'transaction', row.id, `Repeated ${copy.type}: ${copy.description || copy.type} (${formatAmount(copy.amount, copy.currency)})`);
            next = nextDate(next, r.every, anchor);
          }
          await t.run('UPDATE recurring SET next_date = ? WHERE id = ?', [next, r.id]);
        });
      }
    },
    stopRecurring: (id: Id) => inTx(async (t) => {
      if (!(await t.run('UPDATE recurring SET active = 0 WHERE id = ? AND active = 1', [id])).changes) throw new HttpError(404, 'Repeating entry not found');
      await logIn(t, 'update', 'recurring', id, 'Stopped a repeating entry');
    }),

    addReceipt: (txId: Id, mime: string, data: string, by: Id | null) => inTx(async (t) => {
      if (!(await t.get('SELECT 1 FROM transactions WHERE id = ?', [txId]))) throw new HttpError(404, 'Transaction not found');
      const row = (await t.get<{ id: number }>('INSERT INTO receipts (tx_id, mime, data, added_by) VALUES (?, ?, ?, ?) RETURNING id', [txId, mime, data, by]))!;
      await logIn(t, 'update', 'transaction', txId, 'Added a receipt photo');
      return { id: row.id, tx_id: txId };
    }),
    getReceipt: (id: Id) => read((t) => t.get<{ tx_id: Id; mime: string; data: string }>('SELECT tx_id, mime, data FROM receipts WHERE id = ?', [id])),
    deleteReceipt: (id: Id) => inTx(async (t) => {
      const r = await t.get<{ tx_id: Id }>('SELECT tx_id FROM receipts WHERE id = ?', [id]);
      if (!r) throw new HttpError(404, 'Receipt not found');
      await t.run('DELETE FROM receipts WHERE id = ?', [id]);
      await logIn(t, 'update', 'transaction', r.tx_id, 'Removed a receipt photo');
    }),
    /** The trip's name when it is closed (its entries are locked), else undefined. */
    closedTrip: (tripId: Id | null | undefined) => (tripId == null ? Promise.resolve(undefined) : read(async (t) => (await t.get<{ name: string }>('SELECT name FROM trips WHERE id = ? AND closed = 1', [tripId]))?.name)),

    addComment: (txId: Id, personId: Id | null, body: string) => inTx(async (t) => {
      if (!(await t.get('SELECT 1 FROM transactions WHERE id = ?', [txId]))) throw new HttpError(404, 'Transaction not found');
      return (await t.get<Comment>('INSERT INTO comments (tx_id, person_id, body) VALUES (?, ?, ?) RETURNING id, tx_id, person_id, body, created_at', [txId, personId, body]))!;
    }),
    deleteComment: (id: Id) => inTx(async (t) => {
      if (!(await t.run('DELETE FROM comments WHERE id = ?', [id])).changes) throw new HttpError(404, 'Comment not found');
    }),

    /** Settings that must be made once and never replaced (push keys): the first writer wins, everyone reads that. */
    initSetting: async (key: string, value: string) => {
      await read((t) => t.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, value]));
      return (await api.getSetting(key))!;
    },
    savePushSub: (userId: Id, s: { endpoint: string; p256dh: string; auth: string }) =>
      read((t) => t.run('INSERT INTO push_subs (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth', [userId, s.endpoint, s.p256dh, s.auth])),
    removePushSub: (endpoint: string) => read((t) => t.run('DELETE FROM push_subs WHERE endpoint = ?', [endpoint])),
    /** Every device that asked for notifications, with whose it is. One small query; empty means nothing to send. */
    pushTargets: () => read((t) => t.all<{ user_id: Id; role: UserPublic['role']; person_id: Id | null; email: string; endpoint: string; p256dh: string; auth: string }>('SELECT s.user_id, u.role, u.person_id, u.email, s.endpoint, s.p256dh, s.auth FROM push_subs s JOIN users u ON u.id = s.user_id')),
    names: () => read(async (t) => ({
      people: new Map((await t.all<{ id: Id; name: string }>('SELECT id, name FROM people')).map((p) => [p.id, p.name])),
      trips: new Map((await t.all<{ id: Id; name: string }>('SELECT id, name FROM trips')).map((p) => [p.id, p.name])),
    })),
    // Shortcut keys: only a hash is stored, so the key itself exists on the phone alone.
    createKey: (userId: Id, tokenHash: string) => read(async (t) => (await t.get<{ id: Id; created_at: string }>('INSERT INTO api_keys (user_id, token_hash) VALUES (?, ?) RETURNING id, created_at', [userId, tokenHash]))!),
    listKeys: (userId: Id) => read((t) => t.all<{ id: Id; created_at: string; last_used_at: string | null }>('SELECT id, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY id DESC', [userId])),
    deleteKey: (id: Id, userId: Id) => read(async (t) => {
      if (!(await t.run('DELETE FROM api_keys WHERE id = ? AND user_id = ?', [id, userId])).changes) throw new HttpError(404, 'Key not found');
    }),
    userByKey: (tokenHash: string) => read(async (t) => {
      const u = await t.get<UserPublic>(`SELECT ${USER_COLS.split(', ').map((c) => `u.${c}`).join(', ')} FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.token_hash = ?`, [tokenHash]);
      if (u) await t.run("UPDATE api_keys SET last_used_at = datetime('now') WHERE token_hash = ?", [tokenHash]);
      return u;
    }),
    markSeen: (userId: Id) => read((t) => t.run("UPDATE users SET seen_at = datetime('now') WHERE id = ?", [userId])),

    createReconciliation: (r: Omit<Reconciliation, 'id' | 'created_at'>) => inTx(async (t) => {
      const row = (await t.get<{ id: number }>('INSERT INTO reconciliations (account_id, date, counted_amount, expected_amount, note) VALUES (?, ?, ?, ?, ?) RETURNING id', [r.account_id, r.date, r.counted_amount, r.expected_amount, r.note]))!;
      const acct = await t.get<Account>('SELECT name, currency FROM accounts WHERE id = ?', [r.account_id]);
      await logIn(t, 'create', 'reconciliation', row.id, `Counted ${acct?.name ?? 'account'}: ${formatAmount(r.counted_amount, acct?.currency ?? '')} (ledger expected ${formatAmount(r.expected_amount, acct?.currency ?? '')})`);
      return (await t.get<Reconciliation>('SELECT * FROM reconciliations WHERE id = ?', [row.id]))!;
    }),
    deleteReconciliation: (id: Id) => inTx(async (t) => {
      if (!(await t.run('DELETE FROM reconciliations WHERE id = ?', [id])).changes) throw new HttpError(404, 'Reconciliation not found');
      await logIn(t, 'delete', 'reconciliation', id, 'Removed a cash count');
    }),

    // --- access ---------------------------------------------------------------------------------
    userCount: () => read(async (t) => (await t.get<{ n: number }>('SELECT COUNT(*) AS n FROM users'))!.n),
    getUser: (id: Id) => read((t) => t.get<UserPublic>(`SELECT ${USER_COLS} FROM users WHERE id = ?`, [id])),
    getUserAuth: (id: Id) => read((t) => t.get<UserRow>(`SELECT ${USER_COLS}, password_hash FROM users WHERE id = ?`, [id])),
    getUserByEmail: (email: string) => read((t) => t.get<UserRow>(`SELECT ${USER_COLS}, password_hash FROM users WHERE email = ?`, [email])),
    createUser: (u: { email: string; name: string; password_hash: string; role: 'owner' | 'member'; person_id: Id | null }, inviteId?: Id) => inTx(async (t) => {
      if (u.role === 'owner' && (await t.get('SELECT 1 FROM users LIMIT 1'))) throw new HttpError(409, 'The owner account already exists');
      if (inviteId != null) {
        const inv = await t.get<Invite>("SELECT * FROM invites WHERE id = ? AND used_at IS NULL AND expires_at > datetime('now')", [inviteId]);
        if (!inv) throw new HttpError(410, 'This invite has expired or was already used');
        await t.run("UPDATE invites SET used_at = datetime('now') WHERE id = ?", [inviteId]);
      }
      const row = (await t.get<{ id: number }>("INSERT INTO users (email, name, password_hash, role, person_id, seen_at) VALUES (?, ?, ?, ?, ?, datetime('now')) RETURNING id", [u.email, u.name, u.password_hash, u.role, u.person_id]))!;
      if (u.person_id != null) await t.run('UPDATE people SET name = ? WHERE id = ? AND is_me = 1', [u.name, u.person_id]);
      await logIn(t, 'create', 'user', row.id, `${u.name} (${u.email}) can now sign in`);
      return (await t.get<UserPublic>(`SELECT ${USER_COLS} FROM users WHERE id = ?`, [row.id]))!;
    }),
    setPassword: (id: Id, password_hash: string) => inTx(async (t) => {
      if (!(await t.run('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash, id])).changes) throw new HttpError(404, 'User not found');
      await logIn(t, 'update', 'user', id, 'Changed password');
    }),
    deleteUser: (id: Id) => inTx(async (t) => {
      const u = await t.get<UserPublic>(`SELECT ${USER_COLS} FROM users WHERE id = ?`, [id]);
      if (!u) throw new HttpError(404, 'User not found');
      if (u.role === 'owner') throw new HttpError(400, 'The owner account cannot be removed');
      await t.run('UPDATE shares SET created_by = NULL WHERE created_by = ?', [id]);
      await t.run('DELETE FROM invites WHERE created_by = ?', [id]);
      await t.run('DELETE FROM push_subs WHERE user_id = ?', [id]);
      await t.run('DELETE FROM api_keys WHERE user_id = ?', [id]);
      await t.run('DELETE FROM users WHERE id = ?', [id]);
      await logIn(t, 'delete', 'user', id, `Removed access for ${u.name} (${u.email})`);
    }),
    createInvite: (inv: { token: string; person_id: Id; created_by: Id; expires_at: string }) => inTx(async (t) => {
      if (!(await t.get('SELECT 1 FROM people WHERE id = ?', [inv.person_id]))) throw new HttpError(404, 'Person not found');
      if (await t.get('SELECT 1 FROM users WHERE person_id = ?', [inv.person_id])) throw new HttpError(409, 'That person already has a login');
      await t.run('DELETE FROM invites WHERE person_id = ? AND used_at IS NULL', [inv.person_id]);
      const row = (await t.get<{ id: number }>('INSERT INTO invites (token, person_id, created_by, expires_at) VALUES (?, ?, ?, ?) RETURNING id', [inv.token, inv.person_id, inv.created_by, inv.expires_at]))!;
      return (await t.get<Invite>('SELECT * FROM invites WHERE id = ?', [row.id]))!;
    }),
    getInvite: (token: string) => read((t) => t.get<Invite & { person_name: string; owner_name: string }>("SELECT i.*, p.name AS person_name, u.name AS owner_name FROM invites i JOIN people p ON p.id = i.person_id JOIN users u ON u.id = i.created_by WHERE i.token = ? AND i.used_at IS NULL AND i.expires_at > datetime('now')", [token])),
    deleteInvite: (id: Id) => inTx(async (t) => {
      if (!(await t.run('DELETE FROM invites WHERE id = ?', [id])).changes) throw new HttpError(404, 'Invite not found');
    }),
    createShare: (s: { token: string; trip_id: Id | null; person_id: Id | null; label: string | null; created_by: Id; bookings_only?: 0 | 1 }) => inTx(async (t) => {
      if (s.trip_id == null && s.person_id == null) throw new HttpError(400, 'Pick a trip or a person to share');
      if (s.trip_id != null && !(await t.get('SELECT 1 FROM trips WHERE id = ?', [s.trip_id]))) throw new HttpError(404, 'Trip not found');
      if (s.person_id != null && !(await t.get('SELECT 1 FROM people WHERE id = ?', [s.person_id]))) throw new HttpError(404, 'Person not found');
      const row = (await t.get<{ id: number }>('INSERT INTO shares (token, trip_id, person_id, label, created_by, bookings_only) VALUES (?, ?, ?, ?, ?, ?) RETURNING id', [s.token, s.trip_id, s.person_id, s.label, s.created_by, s.trip_id != null && s.bookings_only ? 1 : 0]))!;
      await logIn(t, 'create', 'share', row.id, s.person_id != null ? `Created a view-only link for person #${s.person_id}` : `Created a view-only link for trip #${s.trip_id}`);
      return (await t.get<Share>('SELECT * FROM shares WHERE id = ?', [row.id]))!;
    }),
    getShare: (token: string) => read((t) => t.get<Share>('SELECT * FROM shares WHERE token = ? AND revoked = 0', [token])),
    revokeShare: (id: Id) => inTx(async (t) => {
      if (!(await t.run('UPDATE shares SET revoked = 1 WHERE id = ?', [id])).changes) throw new HttpError(404, 'Link not found');
      await logIn(t, 'delete', 'share', id, 'Revoked a view-only link');
    }),

    backup: () => read(async (t) => {
      const out: Record<string, unknown> = { format: 'ledger-backup', version: MIGRATIONS.length, exported_at: new Date().toISOString() };
      for (const table of BACKUP_TABLES) out[table] = await t.all(`SELECT * FROM ${table}`);
      return out;
    }),
    /** Replaces everything with the contents of a backup, atomically. Logins are kept unless the backup has its own. */
    clearActivity: () => inTx(async (t) => { await t.run('DELETE FROM activity'); }),

    restore: (data: Record<string, unknown>) => inTx(async (t) => {
      if (data.format !== 'ledger-backup' || !Array.isArray(data.people) || !Array.isArray(data.transactions)) throw new HttpError(400, 'Not a ledger backup file');
      const tables = BACKUP_TABLES.filter((name) => Array.isArray(data[name]) || !['users', 'invites', 'shares', 'vault', 'doc_folders', 'documents', 'doc_shares', 'plan_items', 'plan_votes'].includes(name));
      for (const table of [...tables].reverse()) await t.run(`DELETE FROM ${table}`);
      for (const table of tables) {
        for (const row of (data[table] as Row[] | undefined) ?? []) {
          const cols = Object.keys(row);
          await t.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c] ?? null));
        }
      }
      if (!(await t.get('SELECT 1 FROM people WHERE is_me = 1'))) throw new HttpError(400, 'Backup has no "me" person');
      await t.run('DELETE FROM receipts WHERE tx_id NOT IN (SELECT id FROM transactions)');
      await t.run('DELETE FROM plan_images WHERE item_id NOT IN (SELECT id FROM plan_items)');
      await logIn(t, 'restore', 'ledger', null, `Restored backup from ${String(data.exported_at ?? 'unknown date')}`);
    }),
    // --- documents: encrypted in the browser; here only wrapped keys, names and sizes --------------------------
    /** Bytes in use: the database file (entries, bill photos, in-database documents) and all documents' sizes. */
    storageUse: () => read(async (t) => {
      const files = (await t.get<{ n: number | null }>('SELECT SUM(size) AS n FROM documents'))?.n ?? 0;
      // The file's real size; a host that refuses the pragma gets the big columns added up instead.
      const database = await t.get<{ n: number }>('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()').then((r) => r?.n ?? 0)
        .catch(async () => (await t.get<{ n: number | null }>('SELECT (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM receipts) + (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM doc_chunks) AS n'))?.n ?? 0);
      return { files: Number(files), database: Number(database) };
    }),
    docsState: () => read(async (t) => ({
      vault: (await t.get<Vault>('SELECT salt, check_iv, check_ct FROM vault WHERE id = 1')) ?? null,
      folders: await t.all<DocFolder>('SELECT * FROM doc_folders ORDER BY (trip_id IS NOT NULL), LOWER(name), id'),
      documents: await t.all<DocItem>('SELECT * FROM documents ORDER BY created_at DESC, id DESC'),
      shares: await t.all<DocShare>('SELECT * FROM doc_shares WHERE revoked = 0 ORDER BY id DESC'),
    })),
    createVault: (v: Vault) => inTx(async (t) => {
      if (await t.get('SELECT 1 FROM vault WHERE id = 1')) throw new HttpError(409, 'The vault is already set up');
      await t.run('INSERT INTO vault (id, salt, check_iv, check_ct) VALUES (1, ?, ?, ?)', [v.salt, v.check_iv, v.check_ct]);
      await logIn(t, 'create', 'vault', 1, 'Set up the document vault');
    }),
    rewrapVault: (v: Vault, folders: { id: Id; key_iv: string; key_ct: string }[]) => inTx(async (t) => {
      if (!(await t.run('UPDATE vault SET salt = ?, check_iv = ?, check_ct = ? WHERE id = 1', [v.salt, v.check_iv, v.check_ct])).changes) throw new HttpError(404, 'No vault yet');
      for (const f of folders) await t.run('UPDATE doc_folders SET key_iv = ?, key_ct = ? WHERE id = ? AND parent_id IS NULL', [f.key_iv, f.key_ct, f.id]);
      await logIn(t, 'update', 'vault', 1, 'Re-keyed the document vault after a password change');
    }),
    getFolder: (id: Id) => read(async (t) => {
      const f = await t.get<DocFolder>('SELECT * FROM doc_folders WHERE id = ?', [id]);
      if (!f) throw new HttpError(404, 'Folder not found');
      return f;
    }),
    createFolder: (f: { name: string; parent_id: Id | null; trip_id: Id | null; key_iv: string | null; key_ct: string | null }) => inTx(async (t) => {
      if (f.parent_id != null && !(await t.get('SELECT 1 FROM doc_folders WHERE id = ?', [f.parent_id]))) throw new HttpError(404, 'Folder not found');
      if (f.parent_id == null && !(f.key_iv && f.key_ct)) throw new HttpError(400, 'A top-level folder needs its wrapped key');
      if (f.trip_id != null && !(await t.get('SELECT 1 FROM trips WHERE id = ?', [f.trip_id]))) throw new HttpError(404, 'Trip not found');
      if (f.trip_id != null && (await t.get('SELECT 1 FROM doc_folders WHERE trip_id = ? AND parent_id IS NULL', [f.trip_id]))) throw new HttpError(409, 'This trip already has a folder');
      const top = f.parent_id == null;
      const row = (await t.get<{ id: number }>('INSERT INTO doc_folders (name, parent_id, trip_id, key_iv, key_ct) VALUES (?, ?, ?, ?, ?) RETURNING id', [f.name, f.parent_id, top ? f.trip_id : null, top ? f.key_iv : null, top ? f.key_ct : null]))!;
      await logIn(t, 'create', 'folder', row.id, `Created document folder ${f.name}`);
      return (await t.get<DocFolder>('SELECT * FROM doc_folders WHERE id = ?', [row.id]))!;
    }),
    renameFolder: (id: Id, name: string) => inTx(async (t) => {
      if (!(await t.run('UPDATE doc_folders SET name = ? WHERE id = ?', [name, id])).changes) throw new HttpError(404, 'Folder not found');
    }),
    /** Removes a folder tree and its metadata; returns the storage keys so the caller can delete the blobs. */
    deleteFolder: (id: Id) => inTx(async (t) => {
      const ids = await folderTree(t, id);
      if (!ids.length) throw new HttpError(404, 'Folder not found');
      const marks = ids.map(() => '?').join(', ');
      const keys = (await t.all<{ storage_key: string }>(`SELECT storage_key FROM documents WHERE folder_id IN (${marks})`, ids)).map((r) => r.storage_key);
      await t.run(`DELETE FROM documents WHERE folder_id IN (${marks})`, ids);
      if (keys.length) await t.run(`DELETE FROM doc_chunks WHERE storage_key IN (${keys.map(() => '?').join(', ')})`, keys);
      await t.run(`DELETE FROM doc_shares WHERE folder_id IN (${marks})`, ids);
      await t.run(`DELETE FROM doc_folders WHERE id IN (${marks})`, ids);
      await logIn(t, 'delete', 'folder', id, `Deleted a document folder (${keys.length} file${keys.length === 1 ? '' : 's'})`);
      return keys;
    }),
    createDocument: (d: Omit<DocItem, 'id' | 'created_at'>) => inTx(async (t) => {
      if (!(await t.get('SELECT 1 FROM doc_folders WHERE id = ?', [d.folder_id]))) throw new HttpError(404, 'Folder not found');
      const row = (await t.get<{ id: number }>('INSERT INTO documents (folder_id, name, mime, size, storage_key, iv) VALUES (?, ?, ?, ?, ?, ?) RETURNING id', [d.folder_id, d.name, d.mime, d.size, d.storage_key, d.iv]))!;
      await logIn(t, 'create', 'document', row.id, `Added document ${d.name}`);
      return (await t.get<DocItem>('SELECT * FROM documents WHERE id = ?', [row.id]))!;
    }),
    getDocument: (id: Id) => read(async (t) => {
      const d = await t.get<DocItem>('SELECT * FROM documents WHERE id = ?', [id]);
      if (!d) throw new HttpError(404, 'Document not found');
      return d;
    }),
    renameDocument: (id: Id, name: string) => inTx(async (t) => {
      if (!(await t.run('UPDATE documents SET name = ? WHERE id = ?', [name, id])).changes) throw new HttpError(404, 'Document not found');
    }),
    deleteDocument: (id: Id) => inTx(async (t) => {
      const d = await t.get<DocItem>('SELECT * FROM documents WHERE id = ?', [id]);
      if (!d) throw new HttpError(404, 'Document not found');
      await t.run('DELETE FROM documents WHERE id = ?', [id]);
      await t.run('DELETE FROM doc_chunks WHERE storage_key = ?', [d.storage_key]);
      await logIn(t, 'delete', 'document', id, `Deleted document ${d.name}`);
      return d.storage_key;
    }),
    createDocShare: (s: { token: string; folder_id: Id; label: string | null }) => inTx(async (t) => {
      const f = await t.get<DocFolder>('SELECT * FROM doc_folders WHERE id = ?', [s.folder_id]);
      if (!f) throw new HttpError(404, 'Folder not found');
      if (f.parent_id != null) throw new HttpError(400, 'Share the top-level folder; its subfolders come with it');
      const row = (await t.get<{ id: number }>('INSERT INTO doc_shares (token, folder_id, label) VALUES (?, ?, ?) RETURNING id', [s.token, s.folder_id, s.label]))!;
      await logIn(t, 'create', 'share', row.id, `Created a view-only link for the documents in ${f.name}`);
      return (await t.get<DocShare>('SELECT * FROM doc_shares WHERE id = ?', [row.id]))!;
    }),
    revokeDocShare: (id: Id) => inTx(async (t) => {
      if (!(await t.run('UPDATE doc_shares SET revoked = 1 WHERE id = ?', [id])).changes) throw new HttpError(404, 'Link not found');
      await logIn(t, 'delete', 'share', id, 'Revoked a document link');
    }),
    docShareByToken: (token: string) => read((t) => t.get<DocShare>('SELECT * FROM doc_shares WHERE token = ? AND revoked = 0', [token])),
    /** Everything under one top-level folder, for a share link: no storage keys, no wrapped keys. */
    sharedDocs: (rootId: Id) => read(async (t): Promise<SharedDocs> => {
      const root = await t.get<DocFolder>('SELECT id, name, trip_id FROM doc_folders WHERE id = ?', [rootId]);
      if (!root) throw new HttpError(404, 'This link no longer works');
      const ids = await folderTree(t, rootId);
      const marks = ids.map(() => '?').join(', ');
      return {
        folder: { id: root.id, name: root.name, trip_id: root.trip_id },
        folders: await t.all<Pick<DocFolder, 'id' | 'name' | 'parent_id'>>(`SELECT id, name, parent_id FROM doc_folders WHERE id IN (${marks}) AND id != ? ORDER BY LOWER(name)`, [...ids, rootId]),
        documents: await t.all<Omit<DocItem, 'storage_key'>>(`SELECT id, folder_id, name, mime, size, iv, created_at FROM documents WHERE folder_id IN (${marks}) ORDER BY created_at DESC, id DESC`, ids),
      };
    }),
    // Ciphertext in the database, in pieces small enough for one request each. Stays out of the JSON backup.
    putChunk: (key: string, n: number, data: Uint8Array) => inTx((t) => t.run('INSERT OR REPLACE INTO doc_chunks (storage_key, n, data) VALUES (?, ?, ?)', [key, n, data])),
    getChunk: (key: string, n: number) => read(async (t) => {
      const row = await t.get<{ data: ArrayBuffer | Uint8Array }>('SELECT data FROM doc_chunks WHERE storage_key = ? AND n = ?', [key, n]);
      return row ? Buffer.from(row.data as ArrayBuffer) : null;
    }),
    chunkCount: (key: string) => read(async (t) => (await t.get<{ n: number }>('SELECT COUNT(*) AS n FROM doc_chunks WHERE storage_key = ?', [key]))!.n),
    // --- trip plan: board items and votes ----------------------------------------------------------------------
    /** A booking's photo: replacing it gives it a new id, so a phone's saved copy of an id never goes stale. */
    setPlanImage: (itemId: Id, mime: string, data: string) => inTx(async (t) => {
      await t.run('DELETE FROM plan_images WHERE item_id = ?', [itemId]);
      return (await t.get<{ id: number }>('INSERT INTO plan_images (item_id, mime, data) VALUES (?, ?, ?) RETURNING id', [itemId, mime, data]))!.id;
    }),
    removePlanImage: (itemId: Id) => inTx((t) => t.run('DELETE FROM plan_images WHERE item_id = ?', [itemId])),
    getPlanImage: (id: Id) => read((t) => t.get<{ item_id: Id; mime: string; data: string }>('SELECT item_id, mime, data FROM plan_images WHERE id = ?', [id])),
    planItem: (id: Id) => read(async (t) => {
      const r = await t.get<PlanItem>('SELECT * FROM plan_items WHERE id = ?', [id]);
      if (!r) throw new HttpError(404, 'Plan item not found');
      return parsePlan(r);
    }),
    isTripMember: (tripId: Id, personId: Id) => read(async (t) => !!(await t.get('SELECT 1 FROM trip_members WHERE trip_id = ? AND person_id = ?', [tripId, personId]))),
    createPlanItem: (p: Pick<PlanItem, 'trip_id' | 'kind' | 'title' | 'body' | 'meta' | 'day' | 'assignee_id' | 'created_by'>) => inTx(async (t) => {
      if (!(await t.get('SELECT 1 FROM trips WHERE id = ?', [p.trip_id]))) throw new HttpError(404, 'Trip not found');
      const sort = ((await t.get<{ m: number | null }>('SELECT MAX(sort) AS m FROM plan_items WHERE trip_id = ? AND kind = ?', [p.trip_id, p.kind]))?.m ?? 0) + 1;
      const row = (await t.get<{ id: number }>('INSERT INTO plan_items (trip_id, kind, title, body, meta, day, assignee_id, sort, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id', [p.trip_id, p.kind, p.title, p.body, p.meta ? JSON.stringify(p.meta) : null, p.day, p.assignee_id, sort, p.created_by]))!;
      await logIn(t, 'create', 'plan', row.id, `${PLAN_LABEL[p.kind]}: ${p.title}`);
      return parsePlan((await t.get<PlanItem>('SELECT * FROM plan_items WHERE id = ?', [row.id]))!);
    }),
    updatePlanItem: (id: Id, patch: Partial<Pick<PlanItem, 'title' | 'body' | 'meta' | 'day' | 'done' | 'assignee_id'>>) => inTx(async (t) => {
      const cols: string[] = [];
      const args: Val[] = [];
      for (const [k, v] of Object.entries(patch)) { cols.push(`${k} = ?`); args.push(k === 'meta' ? (v ? JSON.stringify(v) : null) : (v as Val)); }
      if (!cols.length) return;
      if (!(await t.run(`UPDATE plan_items SET ${cols.join(', ')} WHERE id = ?`, [...args, id])).changes) throw new HttpError(404, 'Plan item not found');
    }),
    /** Marks one stay as the pick and clears the others on the same trip. */
    chooseStay: (id: Id) => inTx(async (t) => {
      const it = await t.get<PlanItem>('SELECT * FROM plan_items WHERE id = ? AND kind = ?', [id, 'stay']);
      if (!it) throw new HttpError(404, 'Stay option not found');
      for (const s of await t.all<PlanItem>('SELECT id, meta FROM plan_items WHERE trip_id = ? AND kind = ?', [it.trip_id, 'stay'])) {
        const meta = parsePlan(s).meta ?? {};
        await t.run('UPDATE plan_items SET meta = ? WHERE id = ?', [JSON.stringify({ ...meta, chosen: s.id === id }), s.id]);
      }
      await logIn(t, 'update', 'plan', id, `Picked the stay: ${it.title}`);
    }),
    deletePlanItem: (id: Id) => inTx(async (t) => {
      const it = await t.get<PlanItem>('SELECT * FROM plan_items WHERE id = ?', [id]);
      if (!it) throw new HttpError(404, 'Plan item not found');
      await t.run('DELETE FROM plan_votes WHERE item_id = ?', [id]);
      await t.run('DELETE FROM plan_images WHERE item_id = ?', [id]);
      await t.run('DELETE FROM plan_items WHERE id = ?', [id]);
      await logIn(t, 'delete', 'plan', id, `Removed ${PLAN_LABEL[it.kind].toLowerCase()}: ${it.title}`);
    }),
    /** Toggles a person's vote; returns whether they now have one. */
    toggleVote: (itemId: Id, personId: Id) => inTx(async (t) => {
      if (await t.get('SELECT 1 FROM plan_votes WHERE item_id = ? AND person_id = ?', [itemId, personId])) {
        await t.run('DELETE FROM plan_votes WHERE item_id = ? AND person_id = ?', [itemId, personId]);
        return false;
      }
      await t.run('INSERT INTO plan_votes (item_id, person_id) VALUES (?, ?)', [itemId, personId]);
      return true;
    }),
    /** True when `folderId` sits inside the tree rooted at `rootId`. */
    folderWithin: (folderId: Id, rootId: Id) => read(async (t) => (await folderTree(t, rootId)).includes(folderId)),

    snapshot: async (path: string) => {
      if (!isLocal(url)) throw new HttpError(400, 'Snapshots are only available for a local database file; download a JSON backup instead.');
      mkdirSync(dirname(path), { recursive: true });
      await client.execute(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
    },
    isEmpty: () => read(async (t) => !(await t.get('SELECT 1 FROM transactions LIMIT 1'))),
    log: (action: Activity['action'], entity: string, entity_id: Id | null, summary: string, payload?: unknown) => read((t) => logIn(t, action, entity, entity_id, summary, payload)),
  };
  return api;
}

export type Db = Awaited<ReturnType<typeof openDb>>;

const txLabel = (tx: Tx) => `${tx.description || tx.type} (${formatAmount(tx.amount, tx.currency)})`;

/** True when the person pays, receives or shares in the entry. */
export const involves = (t: Pick<Tx, 'payer_id' | 'payee_id' | 'splits'>, pid: Id | null) =>
  pid != null && (t.payer_id === pid || t.payee_id === pid || t.splits.some((s) => s.person_id === pid));

/**
 * What a member (not the owner) sees: each trip is a group, so only the trips they belong to, the entries in those trips
 * or involving them, and the people and accounts those touch. Other people's accounts come as names only (no balance),
 * history only for visible entries, links only their own. The page speaks to them, so they are "me".
 */
function memberSlice(s: LedgerState, pid: Id | null, uid: Id): LedgerState {
  const trips = s.trips.filter((t) => pid != null && t.members.includes(pid));
  const tripIds = new Set(trips.map((t) => t.id));
  const transactions = s.transactions.filter((t) => (t.trip_id != null && tripIds.has(t.trip_id)) || involves(t, pid));
  const txIds = new Set(transactions.map((t) => t.id));
  const seen = new Set<Id | null>([pid, ...trips.flatMap((t) => t.members), ...transactions.flatMap((t) => [t.payer_id, t.payee_id, t.added_by ?? null, t.edited_by ?? null, ...t.splits.map((x) => x.person_id)])]);
  const used = new Set(transactions.flatMap((t) => [t.from_account_id, t.to_account_id]));
  const accounts = s.accounts.filter((a) => a.person_id === pid || used.has(a.id)).map((a) => (a.person_id === pid ? a : { ...a, opening_balance: 0 }));
  const own = new Set(accounts.filter((a) => a.person_id === pid).map((a) => a.id));
  return {
    ...s,
    people: s.people.filter((p) => seen.has(p.id)).map((p) => ({ ...p, is_me: p.id === pid ? 1 : 0 })),
    accounts,
    trips,
    transactions,
    reconciliations: s.reconciliations.filter((r) => own.has(r.account_id)),
    activity: s.activity.filter((a) => a.entity === 'transaction' && a.entity_id != null && txIds.has(a.entity_id)),
    shares: s.shares.filter((x) => x.created_by === uid),
    recurring: s.recurring?.filter((r) => (r.template.trip_id != null && tripIds.has(r.template.trip_id)) || involves(r.template, pid)),
    receipts: s.receipts?.filter((r) => txIds.has(r.tx_id)),
    comments: s.comments?.filter((x) => txIds.has(x.tx_id)),
  };
}
