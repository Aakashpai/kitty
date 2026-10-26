import type { Account, Id, Tx } from './types.ts';
import { effectsOf, type Debt } from './effects.ts';

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

/** Total already refunded against an expense (excluding `exceptId`, used while editing). */
export const refundedTotal = (txs: Tx[], expenseId: Id, exceptId?: Id): number =>
  txs.filter((t) => t.type === 'refund' && t.linked_tx_id === expenseId && t.id !== exceptId).reduce((s, t) => s + t.amount, 0);
