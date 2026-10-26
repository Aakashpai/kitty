import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { computeBalances, pairwiseDebts, type LedgerState, type Tx } from '../engine/index.ts';
import { createApp } from './app.ts';
import { seed } from './seed.ts';

const SECRET = 'test-secret';
const boot = async () => {
  const app = await createApp({ url: ':memory:', staticDir: null, secret: SECRET });
  await new Promise<void>((r) => app.server.listen(0, r));
  const base = `http://localhost:${(app.server.address() as { port: number }).port}`;
  return { ...app, base };
};
const app = await boot();
after(() => { app.server.close(); app.db.close(); });

type Json = Record<string, unknown> & { error?: string; details?: string[] };
/** A tiny browser: remembers the session cookie between calls. */
const jar = (base = app.base) => {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0]!;
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, body);
    assert.equal(r.status, 200, `${method} ${path}: ${JSON.stringify(r.json)}`);
    return r.json;
  };
  return { call, ok, state: async () => (await ok('GET', '/api/state')) as unknown as LedgerState };
};
const owner = jar();
const anon = jar();

test('fresh ledger: setup required, nothing readable before sign-in', async () => {
  assert.deepEqual((await anon.ok('GET', '/api/auth/status')), { needsSetup: true, user: null });
  assert.equal((await anon.call('GET', '/api/state')).status, 401);
  assert.equal((await anon.call('POST', '/api/transactions', {})).status, 401);
  assert.equal((await anon.call('POST', '/api/auth/setup', { email: 'me@example.com', name: 'Aakash', password: 'short' })).status, 400);
  assert.equal((await anon.call('POST', '/api/auth/setup', { email: 'not-an-email', name: 'Aakash', password: 'longenough' })).status, 400);
  const setup = await owner.ok('POST', '/api/auth/setup', { email: 'Me@Example.com', name: 'Aakash', password: 'correct horse battery' });
  assert.equal((setup.user as { role: string }).role, 'owner');
  assert.equal((await anon.call('POST', '/api/auth/setup', { email: 'x@example.com', name: 'X', password: 'longenough' })).status, 409, 'setup is one-time');
  const status = await owner.ok('GET', '/api/auth/status');
  assert.equal(status.needsSetup, false);
  assert.equal((status.user as { email: string }).email, 'me@example.com');
  const s = await owner.state();
  assert.equal(s.user?.role, 'owner');
  assert.equal(s.people.find((p) => p.is_me)?.name, 'Aakash', 'owner name replaces the placeholder "Me"');
  assert.ok(Array.isArray(s.users) && s.users.length === 1);
});

test('login and logout', async () => {
  const j = jar();
  assert.equal((await j.call('POST', '/api/auth/login', { email: 'me@example.com', password: 'wrong password' })).status, 401);
  assert.equal((await j.call('GET', '/api/state')).status, 401);
  await j.ok('POST', '/api/auth/login', { email: 'ME@example.com', password: 'correct horse battery' });
  assert.equal((await j.call('GET', '/api/state')).status, 200);
  await j.ok('POST', '/api/auth/logout');
  assert.equal((await j.call('GET', '/api/state')).status, 401);
  // a forged cookie is rejected
  const forged = await fetch(app.base + '/api/state', { headers: { cookie: 'ledger_session=eyJ1aWQiOjEsImV4cCI6OTk5OTk5OTk5OTk5OX0.bad' } });
  assert.equal(forged.status, 401);
});

test('ledger end to end: people, accounts, trip, every transaction type, balances, guards', async () => {
  const s0 = await owner.state();
  const me = s0.people.find((p) => p.is_me)!.id;
  const alice = (await owner.ok('POST', '/api/people', { name: 'Alice' })).id as number;
  const bob = (await owner.ok('POST', '/api/people', { name: 'Bob' })).id as number;
  assert.equal((await owner.call('POST', '/api/people', { name: '  ' })).status, 400);

  const bank = (await owner.ok('POST', '/api/accounts', { name: 'Bank', type: 'bank', currency: 'inr', opening_balance: 10_000_000 })).id as number;
  const cash = (await owner.ok('POST', '/api/accounts', { name: 'SGD cash', type: 'cash', currency: 'SGD' })).id as number;
  assert.equal((await owner.call('POST', '/api/accounts', { name: 'X', type: 'piggy', currency: 'SGD' })).status, 400);

  const trip = (await owner.ok('POST', '/api/trips', { name: 'SG', currency: 'SGD', start_date: '2026-03-12', end_date: '2026-03-16', members: [me, alice, bob] })).id as number;
  assert.equal((await owner.call('POST', '/api/trips', { name: 'Bad', currency: 'SGD', start_date: '2026-03-12', end_date: '2026-03-01' })).status, 400);

  await owner.ok('POST', '/api/transactions', { type: 'withdrawal', date: '2026-03-12', currency: 'INR', amount: 3_100_000, payer_id: me, from_account_id: bank, to_account_id: cash, to_amount: 50_000, fee_amount: 20_000, trip_id: trip, description: 'ATM' });
  const dinner = await owner.ok('POST', '/api/transactions', { type: 'expense', date: '2026-03-12', description: 'Dinner', currency: 'SGD', amount: 12_000, payer_id: me, from_account_id: cash, trip_id: trip, split_method: 'equal', splits: [{ person_id: me, amount: 4_000 }, { person_id: alice, amount: 4_000 }, { person_id: bob, amount: 4_000 }] });
  const bad = await owner.call('POST', '/api/transactions', { type: 'expense', date: '2026-03-12', description: 'Bad', currency: 'SGD', amount: 12_000, payer_id: me, splits: [{ person_id: me, amount: 1 }] });
  assert.equal(bad.status, 422);
  assert.ok(bad.json.details!.some((d) => /add up/.test(d)));
  await owner.ok('POST', '/api/transactions', { type: 'repayment', date: '2026-03-13', currency: 'SGD', amount: 4_000, payer_id: bob, payee_id: me, to_account_id: cash, trip_id: trip, method: 'cash' });
  const refund = await owner.ok('POST', '/api/transactions', { type: 'refund', date: '2026-03-14', description: 'Dinner overcharge', currency: 'SGD', amount: 3_000, payer_id: me, to_account_id: cash, trip_id: trip, linked_tx_id: dinner.id, splits: [{ person_id: me, amount: 1_000 }, { person_id: alice, amount: 1_000 }, { person_id: bob, amount: 1_000 }] });
  await owner.ok('POST', '/api/transactions', { type: 'income', date: '2026-03-01', description: 'Salary', currency: 'INR', amount: 5_000_000, payer_id: me, to_account_id: bank });
  assert.equal((await owner.call('POST', '/api/transactions', { type: 'transfer', date: '2026-03-01', currency: 'INR', amount: 100, payer_id: me, from_account_id: bank, to_account_id: bank })).status, 422);
  assert.equal((await owner.call('POST', '/api/transactions', { type: 'expense', date: '2026-03-12', description: 'Nope', currency: 'SGD', amount: 100, payer_id: me, trip_id: 9999, splits: [{ person_id: me, amount: 100 }] })).status, 422, 'unknown trip');

  const s1 = await owner.state();
  assert.equal(s1.transactions.length, 5);
  const b = computeBalances(s1.transactions, s1.accounts);
  assert.equal(b.accounts.get(bank), 10_000_000 - 3_100_000 - 20_000 + 5_000_000);
  assert.equal(b.accounts.get(cash), 50_000 - 12_000 + 4_000 + 3_000);
  assert.deepEqual(pairwiseDebts(b), [{ from: me, to: bob, currency: 'SGD', amount: 1_000 }, { from: alice, to: me, currency: 'SGD', amount: 3_000 }]);

  assert.equal((await owner.call('DELETE', `/api/transactions/${dinner.id}`)).status, 409, 'expense with a refund cannot be deleted');
  assert.equal((await owner.call('DELETE', `/api/accounts/${cash}`)).status, 409, 'referenced account cannot be deleted');
  assert.equal((await owner.call('DELETE', `/api/trips/${trip}`)).status, 409, 'trip with transactions cannot be deleted');
  assert.equal((await owner.call('DELETE', `/api/people/${alice}`)).status, 409, 'person in splits cannot be deleted');
  assert.equal((await owner.call('DELETE', `/api/people/${me}`)).status, 400);
  assert.equal((await owner.call('POST', '/api/seed')).status, 409);
  assert.equal((await owner.call('GET', '/api/transactions/424242')).status, 404);

  const edited = await owner.ok('PUT', `/api/transactions/${refund.id}`, { ...refund, amount: 6_000, splits: [{ person_id: me, amount: 2_000 }, { person_id: alice, amount: 2_000 }, { person_id: bob, amount: 2_000 }] });
  assert.equal(edited.amount, 6_000);
  assert.equal((await owner.call('PUT', `/api/transactions/${refund.id}`, { ...refund, amount: 20_000, splits: [{ person_id: me, amount: 20_000 }] })).status, 422);
  await owner.ok('DELETE', `/api/transactions/${refund.id}`);
  await owner.ok('DELETE', `/api/transactions/${dinner.id}`);
  const s2 = await owner.state();
  assert.equal(s2.transactions.length, 3);
  assert.ok(s2.activity.some((a) => a.action === 'delete' && a.entity_id === dinner.id && JSON.parse(a.payload!).description === 'Dinner'));
  // a person without transactions can be deleted; archived people stay
  const temp = (await owner.ok('POST', '/api/people', { name: 'Temp' })).id as number;
  await owner.ok('PUT', `/api/people/${temp}`, { name: 'Temp', archived: 1 });
  await owner.ok('DELETE', `/api/people/${temp}`);
  const recon = await owner.ok('POST', '/api/reconciliations', { account_id: cash, date: '2026-03-16', counted_amount: 40_000, expected_amount: 45_000, note: 'short' });
  await owner.ok('DELETE', `/api/reconciliations/${recon.id}`);
  await owner.ok('PUT', '/api/settings', { home_currency: 'sgd' });
  assert.equal((await owner.state()).settings.home_currency, 'SGD');
  // exchange rates: global and per trip
  await owner.ok('PUT', '/api/settings', { rates: { inr: '0.0133', MYR: 0.31 } });
  assert.deepEqual((await owner.state()).settings.rates, { INR: 0.0133, MYR: 0.31 });
  assert.equal((await owner.call('PUT', '/api/settings', { rates: { SGD: -1 } })).status, 400);
  assert.equal((await owner.call('PUT', '/api/settings', { rates: { Rupee: 1 } })).status, 400);
  const tripRow = (await owner.state()).trips[0]!;
  await owner.ok('PUT', `/api/trips/${tripRow.id}`, { ...tripRow, rates: { INR: 0.0125 } });
  assert.deepEqual((await owner.state()).trips[0]!.rates, { INR: 0.0125 });
  await owner.ok('PUT', `/api/trips/${tripRow.id}`, { ...tripRow, rates: {} });
  assert.equal((await owner.state()).trips[0]!.rates, null);
});

test('invites: owner invites a person, invitee signs up as that person, access can be removed', async () => {
  const s = await owner.state();
  const alice = s.people.find((p) => p.name === 'Alice')!.id;
  const member = jar();
  assert.equal((await member.call('POST', '/api/invites', { person_id: alice })).status, 401);
  const inv = await owner.ok('POST', '/api/invites', { person_id: alice });
  assert.ok(typeof inv.token === 'string' && (inv.token as string).length > 20);
  assert.equal((await anon.call('GET', '/api/invites/not-a-real-token')).status, 410);
  const info = await anon.ok('GET', `/api/invites/${inv.token}`);
  assert.equal(info.person_name, 'Alice');
  assert.equal(info.owner_name, 'Aakash');
  assert.equal((await member.call('POST', `/api/invites/${inv.token}/accept`, { email: 'alice@example.com', password: 'tiny' })).status, 400);
  assert.equal((await member.call('POST', `/api/invites/${inv.token}/accept`, { email: 'me@example.com', password: 'alice is here' })).status, 409, 'email already used');
  const accepted = await member.ok('POST', `/api/invites/${inv.token}/accept`, { email: 'alice@example.com', name: 'Alice K', password: 'alice is here' });
  assert.equal((accepted.user as { role: string }).role, 'member');
  assert.equal((await anon.call('GET', `/api/invites/${inv.token}`)).status, 410, 'single use');
  const ms = await member.state();
  assert.equal(ms.user?.person_id, alice, 'member is linked to Alice');
  assert.equal(ms.users, undefined, 'members do not see the user list');
  assert.equal((await member.call('POST', '/api/invites', { person_id: alice })).status, 403);
  assert.equal((await member.call('GET', '/api/backup')).status, 403);
  assert.equal((await member.call('POST', '/api/seed')).status, 403);
  // members can still record transactions
  await member.ok('POST', '/api/transactions', { type: 'expense', date: '2026-03-15', description: 'Alice coffee', currency: 'SGD', amount: 500, payer_id: alice, splits: [{ person_id: alice, amount: 500 }] });
  assert.equal((await owner.call('POST', '/api/invites', { person_id: alice })).status, 409, 'already has a login');
  const os = await owner.state();
  assert.equal(os.users!.length, 2);
  assert.equal((await owner.call('DELETE', `/api/people/${alice}`)).status, 409, 'person with a login cannot be deleted');
  const aliceUser = os.users!.find((u) => u.email === 'alice@example.com')!;
  assert.equal((await owner.call('DELETE', `/api/users/${os.user!.id}`)).status, 400, 'owner cannot remove themselves');
  await owner.ok('DELETE', `/api/users/${aliceUser.id}`);
  assert.equal((await member.call('GET', '/api/state')).status, 401, 'removed user is signed out everywhere');
  // pending invites can be cancelled
  const inv2 = await owner.ok('POST', '/api/invites', { person_id: alice });
  assert.equal((await owner.state()).invites!.length, 1);
  await owner.ok('DELETE', `/api/invites/${inv2.id}`);
  assert.equal((await owner.state()).invites!.length, 0);
  assert.equal((await anon.call('GET', `/api/invites/${inv2.token}`)).status, 410);
});

test('share links: anyone with the link sees one trip, read-only, without account details', async () => {
  const s = await owner.state();
  const trip = s.trips[0]!;
  assert.equal((await owner.call('POST', '/api/shares', { trip_id: 9999 })).status, 404);
  const share = await owner.ok('POST', '/api/shares', { trip_id: trip.id, label: 'For the group' });
  assert.equal((await anon.call('GET', '/api/shared/nope')).status, 404);
  const view = (await anon.ok('GET', `/api/shared/${share.token}`)) as unknown as LedgerState;
  assert.equal(view.user, null);
  assert.deepEqual(view.trips.map((t) => t.id), [trip.id]);
  assert.deepEqual(view.accounts, []);
  assert.ok(view.transactions.length > 0);
  for (const tx of view.transactions) {
    assert.equal(tx.trip_id, trip.id);
    assert.ok(['expense', 'refund', 'repayment'].includes(tx.type), 'withdrawals and income are private');
    assert.equal(tx.from_account_id, null);
    assert.equal(tx.to_account_id, null);
  }
  assert.ok(!view.transactions.some((t) => t.description === 'ATM'));
  assert.equal((await anon.call('POST', '/api/transactions', {})).status, 401, 'a link never grants write access');
  assert.ok((await owner.state()).shares.some((x) => x.id === share.id));
  await owner.ok('DELETE', `/api/shares/${share.id}`);
  assert.equal((await anon.call('GET', `/api/shared/${share.token}`)).status, 404, 'revoked');
  assert.ok(!(await owner.state()).shares.some((x) => x.id === share.id));
});

test('health, unknown routes, bad JSON', async () => {
  assert.equal((await anon.ok('GET', '/api/health')).ok, true);
  assert.equal((await anon.call('GET', '/api/nope')).status, 404);
  const res = await fetch(app.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  assert.equal(res.status, 400);
});

test('backup and restore into a fresh deployment keeps data and logins', async () => {
  const backup = await owner.ok('GET', '/api/backup');
  const other = await boot();
  try {
    const o = jar(other.base);
    await o.ok('POST', '/api/auth/setup', { email: 'temp@example.com', name: 'Temp', password: 'temporary pass' });
    await o.ok('POST', '/api/restore', backup);
    // the backup carried the original users, so the original owner can sign in on the new deployment
    const back = jar(other.base);
    await back.ok('POST', '/api/auth/login', { email: 'me@example.com', password: 'correct horse battery' });
    const s3 = await back.state();
    const s2 = await owner.state();
    assert.deepEqual(s3.transactions, s2.transactions);
    assert.deepEqual(s3.accounts, s2.accounts);
    assert.equal(s3.settings.home_currency, 'SGD');
    assert.equal((await o.call('GET', '/api/state')).status, 401, 'the pre-restore owner session is gone with its user row');
    assert.equal((await back.call('POST', '/api/restore', { nope: 1 })).status, 400);
  } finally {
    other.server.close();
    other.db.close();
  }
});

test('sample data is internally consistent', async () => {
  const fresh = await createApp({ url: ':memory:', staticDir: null, secret: SECRET });
  try {
    await seed(fresh.db);
    const s = await fresh.db.loadState(null);
    assert.ok(s.transactions.length >= 15);
    const b = computeBalances(s.transactions, s.accounts);
    for (const tx of s.transactions as Tx[]) {
      if (tx.type === 'expense' || tx.type === 'refund') assert.equal(tx.splits.reduce((a, x) => a + x.amount, 0), tx.amount, tx.description);
    }
    const totals = new Map<string, number>();
    for (const m of b.net.values()) for (const [cur, v] of m) totals.set(cur, (totals.get(cur) ?? 0) + v);
    for (const [cur, v] of totals) assert.equal(v, 0, cur);
    assert.equal(s.reconciliations.length, 1);
    assert.ok(s.transactions.every((t) => t.date <= new Date().toISOString().slice(0, 10)), 'sample dates are in the past');
  } finally {
    fresh.db.close();
  }
});

test('owner can be provisioned from configuration and can change their password', async () => {
  const pre = await createApp({ url: ':memory:', staticDir: null, secret: SECRET, owner: { email: 'Aakash@Example.com', name: 'Aakash', password: 'kitty-pass' } });
  await new Promise<void>((r) => pre.server.listen(0, r));
  const base = `http://localhost:${(pre.server.address() as { port: number }).port}`;
  try {
    const j = jar(base);
    assert.deepEqual(await j.ok('GET', '/api/auth/status'), { needsSetup: false, user: null });
    assert.equal((await j.call('POST', '/api/auth/setup', { email: 'x@example.com', name: 'X', password: 'longenough' })).status, 409);
    await j.ok('POST', '/api/auth/login', { email: 'aakash@example.com', password: 'kitty-pass' });
    const s = await j.state();
    assert.equal(s.user?.role, 'owner');
    assert.equal(s.people.find((p) => p.is_me)?.name, 'Aakash');
    assert.equal((await j.call('POST', '/api/auth/password', { current: 'wrong', next: 'brand-new-pass' })).status, 400);
    assert.equal((await j.call('POST', '/api/auth/password', { current: 'kitty-pass', next: 'short' })).status, 400);
    const other = jar(base);
    await other.ok('POST', '/api/auth/login', { email: 'aakash@example.com', password: 'kitty-pass' });
    await j.ok('POST', '/api/auth/password', { current: 'kitty-pass', next: 'brand-new-pass' });
    assert.equal((await j.call('GET', '/api/state')).status, 200, 'the device that changed the password stays signed in');
    assert.equal((await other.call('GET', '/api/state')).status, 401, 'every other session is signed out by a password change');
    await j.ok('POST', '/api/auth/logout');
    assert.equal((await j.call('POST', '/api/auth/login', { email: 'aakash@example.com', password: 'kitty-pass' })).status, 401);
    await j.ok('POST', '/api/auth/login', { email: 'aakash@example.com', password: 'brand-new-pass' });
    // a second boot against the same database must not create a second owner
    assert.equal((await pre.db.userCount()), 1);
  } finally {
    pre.server.close();
    pre.db.close();
  }
});

test('login lockout after repeated failures (runs last: it locks this IP)', async () => {
  const j = jar();
  for (let i = 0; i < 10; i++) assert.equal((await j.call('POST', '/api/auth/login', { email: 'me@example.com', password: 'nope' })).status, 401);
  assert.equal((await j.call('POST', '/api/auth/login', { email: 'me@example.com', password: 'correct horse battery' })).status, 429);
});
