import type { Account, Id, Tx } from './types.ts';
import { conversionOf, effectsOf, type Debt, type RateCtx } from './effects.ts';
import { allocate, negligible } from './money.ts';

export interface Balances {
  /** account_id -> balance in the account's currency (opening balance + every delta) */
  accounts: Map<Id, number>;
  /** "a|b|CUR" (a < b) -> amount a owes b; negative means b owes a */
  pair: Map<string, number>;
  /** person -> currency -> net position (positive: is owed, negative: owes) */
  net: Map<Id, Map<string, number>>;
}

const addTo = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

/** Fold every transaction's effects. Pass a filtered transaction list for trip-scoped balances. */
export function computeBalances(txs: Tx[], accounts: Account[] = []): Balances {
  const b: Balances = {
    accounts: new Map(accounts.map((a) => [a.id, a.opening_balance])),
    pair: new Map(),
    net: new Map(),
  };
  const addNet = (p: Id, cur: string, v: number) => {
    let m = b.net.get(p);
    if (!m) b.net.set(p, (m = new Map()));
    addTo(m, cur, v);
  };
  for (const tx of txs) {
    const e = effectsOf(tx);
    for (const d of e.accounts) b.accounts.set(d.account_id, (b.accounts.get(d.account_id) ?? 0) + d.amount);
    for (const d of e.debts) {
      const [a, c, sign] = d.from < d.to ? [d.from, d.to, 1] : [d.to, d.from, -1];
      addTo(b.pair, `${a}|${c}|${d.currency}`, sign * d.amount);
      addNet(d.to, d.currency, d.amount);
      addNet(d.from, d.currency, -d.amount);
    }
  }
  return b;
}

export interface HomeBalances extends Balances {
  home: string;
  actual: number; // converted at real charges (minor units of home)
  estimated: number; // converted at table rates
  unconverted: Map<string, number>; // debt amounts with no known rate, per currency
}

/**
 * Who owes whom in the home currency. Shares of an expense with a real home-currency charge
 * are allocated from that charge (so they sum to it exactly); everything else uses the rate
 * table; debts with no rate are reported separately instead of guessed.
 */
export function computeHomeBalances(txs: Tx[], c: RateCtx): HomeBalances {
  const b: HomeBalances = { accounts: new Map(), pair: new Map(), net: new Map(), home: c.home, actual: 0, estimated: 0, unconverted: new Map() };
  const addNet = (p: Id, v: number) => {
    let m = b.net.get(p);
    if (!m) b.net.set(p, (m = new Map()));
    addTo(m, c.home, v);
  };
  for (const tx of txs) {
    const debts = effectsOf(tx).debts;
    if (!debts.length) continue;
    const conv = conversionOf(tx, c);
    if (!conv) {
      for (const d of debts) addTo(b.unconverted, d.currency, d.amount);
      continue;
    }
    let converted: number[];
    const leg = tx.from_amount ?? tx.to_amount;
    if (conv.kind === 'actual' && (tx.type === 'expense' || tx.type === 'refund') && leg != null && tx.splits.length) {
      const parts = allocate(leg, tx.splits.map((s) => s.amount));
      const byPerson = new Map(tx.splits.map((s, i) => [s.person_id, parts[i] ?? 0]));
      converted = debts.map((d) => byPerson.get(tx.type === 'expense' ? d.from : d.to) ?? 0);
    } else if (tx.type === 'repayment' && conv.kind === 'same') {
      converted = [tx.amount]; // worth what was paid, also when it settles a little less (a leftover called square)
    } else {
      converted = debts.map((d) => Math.round(d.amount * conv.rate));
    }
    debts.forEach((d, i) => {
      const v = converted[i] ?? 0;
      if (conv.kind === 'rate') b.estimated += v;
      else if (conv.kind === 'actual') b.actual += v;
      const [p, q, sign] = d.from < d.to ? [d.from, d.to, 1] : [d.to, d.from, -1];
      addTo(b.pair, `${p}|${q}|${c.home}`, sign * v);
      addNet(d.to, v);
      addNet(d.from, -v);
    });
  }
  return b;
}

export interface Square { trip_id: Id | null; from: Id; to: Id; amount: number; settles: number }

/**
 * Calling a pair square: one home-currency repayment per trip the leftover comes from. A pure exchange-rate leftover
 * settles nothing in any currency (per-currency balances stay as they are); a small home-currency debt is written off. Null when any part
 * is a real debt: a foreign-currency balance, or a leftover that is not negligible.
 */
export function squareUp(txs: Tx[], c: RateCtx, a: Id, b: Id): Square[] | null {
  const out: Square[] = [];
  for (const trip_id of new Set(txs.map((t) => t.trip_id))) {
    const group = txs.filter((t) => t.trip_id === trip_id);
    const k = a < b ? `${a}|${b}` : `${b}|${a}`, sign = a < b ? 1 : -1; // pair keys hold what the lower id owes
    let x = 0;
    for (const [key, v] of computeBalances(group).pair) {
      if (!key.startsWith(`${k}|`) || v === 0) continue;
      if (!key.endsWith(`|${c.home}`)) return null;
      x = sign * v;
    }
    const h = sign * (computeHomeBalances(group, c).pair.get(`${k}|${c.home}`) ?? 0);
    if (h === 0 && x === 0) continue;
    const [from, to, amount, settles] = h >= 0 ? [a, b, h, x] : [b, a, -h, -x];
    if (amount === 0 || !negligible(amount, c.home) || (settles !== 0 && settles !== amount)) return null; // a part-real, part-rate leftover: settle the real part first
    out.push({ trip_id, from, to, amount, settles });
  }
  return out.length ? out : null;
}

const byDebt = (x: Debt, y: Debt) => x.currency.localeCompare(y.currency) || x.from - y.from || x.to - y.to;

/** Exact pairwise positions, as positive "from owes to" entries. */
export function pairwiseDebts(b: Balances): Debt[] {
  const out: Debt[] = [];
  for (const [k, v] of b.pair) {
    if (v === 0) continue;
    const [a, c, currency] = k.split('|') as [string, string, string];
    const p = Number(a), q = Number(c);
    out.push(v > 0 ? { from: p, to: q, currency, amount: v } : { from: q, to: p, currency, amount: -v });
  }
  return out.sort(byDebt);
}

/**
 * Fewer payments without inventing relationships: whenever X owes Y and Y owes Z, X pays Z instead and Y's two
 * debts shrink by the same amount (a two-person loop just cancels). Every resulting payment follows a chain of real
 * debts, so nobody is told to pay someone they never dealt with. Everyone's net position is unchanged. Per currency;
 * deterministic (people visited in id order, largest debts first).
 */
export function forwardDebts(debts: Debt[]): Debt[] {
  const out: Debt[] = [];
  for (const currency of [...new Set(debts.map((d) => d.currency))].sort()) {
    const d = new Map<string, number>();
    for (const x of debts) if (x.currency === currency && x.amount > 0) d.set(`${x.from}|${x.to}`, (d.get(`${x.from}|${x.to}`) ?? 0) + x.amount);
    const edges = () => [...d].map(([k, v]) => { const [a, b] = k.split('|'); return { from: Number(a), to: Number(b), v }; }).sort((p, q) => q.v - p.v || p.from - q.from || p.to - q.to);
    for (let guard = 0; guard < 10000; guard++) {
      const e = edges();
      const mid = [...new Set(e.map((x) => x.to))].sort((a, b) => a - b).find((y) => e.some((x) => x.from === y));
      if (mid == null) break;
      const inn = e.find((x) => x.to === mid)!, outn = e.find((x) => x.from === mid)!;
      const m = Math.min(inn.v, outn.v);
      const dec = (k: string) => { const v = (d.get(k) ?? 0) - m; if (v > 0) d.set(k, v); else d.delete(k); };
      dec(`${inn.from}|${mid}`); dec(`${mid}|${outn.to}`);
      if (inn.from !== outn.to) d.set(`${inn.from}|${outn.to}`, (d.get(`${inn.from}|${outn.to}`) ?? 0) + m);
    }
    for (const x of edges()) out.push({ from: x.from, to: x.to, currency, amount: x.v });
  }
  return out.sort(byDebt);
}

/**
 * Minimal set of payments that settles everyone's net position, one currency at a time.
 * Greedy largest-debtor-pays-largest-creditor; deterministic (ties broken by person id).
 */
export function settlementPlan(net: Balances['net']): Debt[] {
  const byCur = new Map<string, { id: Id; amt: number }[]>();
  for (const [id, m] of net) {
    for (const [cur, amt] of m) {
      if (amt === 0) continue;
      let list = byCur.get(cur);
      if (!list) byCur.set(cur, (list = []));
      list.push({ id, amt });
    }
  }
  const plan: Debt[] = [];
  for (const [currency, list] of [...byCur].sort(([a], [b]) => a.localeCompare(b))) {
    const order = (x: { id: Id; amt: number }, y: { id: Id; amt: number }) => Math.abs(y.amt) - Math.abs(x.amt) || x.id - y.id;
    const creditors = list.filter((x) => x.amt > 0).sort(order).map((x) => ({ id: x.id, left: x.amt }));
    const debtors = list.filter((x) => x.amt < 0).sort(order).map((x) => ({ id: x.id, left: -x.amt }));
    let i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      const d = debtors[i]!, c = creditors[j]!;
      const pay = Math.min(d.left, c.left);
      if (pay > 0) plan.push({ from: d.id, to: c.id, currency, amount: pay });
      d.left -= pay;
      c.left -= pay;
      if (d.left === 0) i++;
      if (c.left === 0) j++;
    }
  }
  return plan;
}

/** Ledger lines for one account in date order, with running balance. */
export function accountEntries(txs: Tx[], account: Account): { tx: Tx; delta: number; balance: number }[] {
  const rows: { tx: Tx; delta: number; balance: number }[] = [];
  let balance = account.opening_balance;
  const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  for (const tx of sorted) {
    const delta = effectsOf(tx).accounts.filter((d) => d.account_id === account.id).reduce((s, d) => s + d.amount, 0);
    if (delta === 0) continue;
    balance += delta;
    rows.push({ tx, delta, balance });
  }
  return rows;
}

/** Group signed spending (expenses minus refunds) by an arbitrary key, per currency. */
export function spendingBy(txs: Tx[], key: (tx: Tx) => string): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const tx of txs) {
    const e = effectsOf(tx);
    if (e.spending === 0) continue;
    const k = key(tx);
    let m = out.get(k);
    if (!m) out.set(k, (m = new Map()));
    addTo(m, tx.currency, e.spending);
  }
  return out;
}

/**
 * Spending per key in the home currency (expenses minus refunds), or only `person`'s share of it.
 * A real home-currency charge is used as charged, anything else converts at the rate table, and a
 * share is allocated from that converted total so everyone's shares add up to it exactly. Amounts
 * with no known rate stay in their own currency, so each value is currency -> amount.
 */
export function homeSpendingBy(txs: Tx[], c: RateCtx, key: (tx: Tx) => string, person?: Id): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const tx of txs) {
    if (tx.type !== 'expense' && tx.type !== 'refund') continue;
    const i = person == null ? -1 : tx.splits.findIndex((s) => s.person_id === person);
    if (person != null && !tx.splits[i]?.amount) continue;
    const conv = conversionOf(tx, c);
    const leg = tx.from_amount ?? tx.to_amount;
    const total = !conv ? tx.amount : conv.kind === 'actual' && leg != null ? leg : Math.round(tx.amount * conv.rate);
    const v = person == null ? total : (allocate(total, tx.splits.map((s) => s.amount))[i] ?? 0);
    const k = key(tx);
    let m = out.get(k);
    if (!m) out.set(k, (m = new Map()));
    addTo(m, conv ? c.home : tx.currency, tx.type === 'expense' ? v : -v);
  }
  return out;
}

/** Total already refunded against an expense (excluding `exceptId`, used while editing). */
export const refundedTotal = (txs: Tx[], expenseId: Id, exceptId?: Id): number =>
  txs.filter((t) => t.type === 'refund' && t.linked_tx_id === expenseId && t.id !== exceptId).reduce((s, t) => s + t.amount, 0);
