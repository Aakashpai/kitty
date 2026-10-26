import type { Account, Id, Trip, Tx } from './types.ts';

/**
 * What a single transaction does to the ledger. Everything else (account balances, who owes
 * whom, spending totals) is derived by folding these effects, so this table is the one place
 * that defines the semantics of each transaction type:
 *
 * | type       | spending total        | account balances                      | participant balances                    |
 * | expense    | +amount               | from-account -from_amount              | each participant owes payer their share |
 * | refund     | -amount               | to-account +to_amount                  | recipient owes each participant their share back |
 * | transfer   | none (fee reported)   | from -(from_amount+fee), to +to_amount | none                                    |
 * | withdrawal | none (fee reported)   | same as transfer                       | none                                    |
 * | repayment  | none                  | from -from_amount, to +to_amount       | recipient now owes payer settled_amount (nets against the existing debt) |
 * | income     | none (income total)   | to-account +to_amount                  | none                                    |
 *
 * Currency rules: nothing is ever converted implicitly. Debts are kept per currency. A
 * transfer records both legs explicitly (from_amount in the source currency, to_amount in the
 * destination currency). A repayment records what moved (amount/currency) and what debt it
 * clears (settled_amount/settled_currency). Account deltas are always in the account's currency.
 */
export interface AccountDelta {
  account_id: Id;
  amount: number;
}

/** `from` owes `to` `amount` of `currency`. */
export interface Debt {
  from: Id;
  to: Id;
  currency: string;
  amount: number;
}

export interface Effects {
  accounts: AccountDelta[];
  debts: Debt[];
  spending: number; // signed, in tx.currency
  fee: number; // in the from-account's currency
  income: number; // in tx.currency
}

export function effectsOf(tx: Tx): Effects {
  const e: Effects = { accounts: [], debts: [], spending: 0, fee: 0, income: 0 };
  const fee = tx.fee_amount ?? 0;
  const fromAmount = (tx.from_amount ?? tx.amount) + fee;
  if (tx.from_account_id != null) e.accounts.push({ account_id: tx.from_account_id, amount: -fromAmount });
  if (tx.to_account_id != null) e.accounts.push({ account_id: tx.to_account_id, amount: tx.to_amount ?? tx.amount });

  switch (tx.type) {
    case 'expense':
    case 'refund': {
      const sign = tx.type === 'expense' ? 1 : -1;
      e.spending = sign * tx.amount;
      if (tx.payer_id == null) break;
      for (const s of tx.splits) {
        if (s.person_id === tx.payer_id || s.amount === 0) continue;
        e.debts.push(
          sign > 0
            ? { from: s.person_id, to: tx.payer_id, currency: tx.currency, amount: s.amount }
            : { from: tx.payer_id, to: s.person_id, currency: tx.currency, amount: s.amount },
        );
      }
      break;
    }
    case 'transfer':
    case 'withdrawal':
      e.fee = fee;
      break;
    case 'repayment':
      if (tx.payer_id != null && tx.payee_id != null) {
        e.debts.push({
          from: tx.payee_id,
          to: tx.payer_id,
          currency: tx.settled_currency ?? tx.currency,
          amount: tx.settled_amount ?? tx.amount,
        });
      }
      break;
    case 'income':
      e.income = tx.amount;
      break;
  }
  return e;
}

/**
 * Conversion rules into the home currency, in priority order:
 *  1. same currency: 1:1
 *  2. the transaction carries an actual home-currency leg (a card charged in INR for an SGD
 *     expense, or ₹2,000 paid to settle an SGD debt): that real rate is used ("actual")
 *  3. the trip's rate table, then the global rate table ("rate", an estimate)
 *  4. otherwise null: the amount stays unconverted and the UI says so.
 */
export interface RateCtx {
  home: string;
  rates: Record<string, number>;
  trips: Trip[];
  accounts: Account[];
}
export interface Conversion {
  rate: number;
  kind: 'same' | 'actual' | 'rate';
}

/** Currency the transaction's balance effect is denominated in. */
export const debtCurrencyOf = (tx: Tx): string => (tx.type === 'repayment' ? (tx.settled_currency ?? tx.currency) : tx.currency);

export function conversionOf(tx: Tx, c: RateCtx): Conversion | null {
  const cur = debtCurrencyOf(tx);
  if (cur === c.home) return { rate: 1, kind: 'same' };
  if (tx.type === 'repayment' && tx.currency === c.home && tx.settled_amount) return { rate: tx.amount / tx.settled_amount, kind: 'actual' };
  const acct = (id: Id | null) => (id == null ? undefined : c.accounts.find((a) => a.id === id));
  for (const [a, amt] of [[acct(tx.from_account_id), tx.from_amount], [acct(tx.to_account_id), tx.to_amount]] as [Account | undefined, number | null][]) {
    if (a && a.currency === c.home && amt != null && amt > 0 && tx.amount > 0) return { rate: amt / tx.amount, kind: 'actual' };
  }
  const trip = tx.trip_id != null ? c.trips.find((t) => t.id === tx.trip_id) : undefined;
  const r = trip?.rates?.[cur] ?? c.rates[cur];
  return r != null && Number.isFinite(r) && r > 0 ? { rate: r, kind: 'rate' } : null;
}

/** The transaction amount in the home currency, or null when no conversion is known. */
export function homeValue(tx: Tx, c: RateCtx): { amount: number; kind: Conversion['kind'] } | null {
  const conv = conversionOf(tx, c);
  if (!conv) return null;
  const base = tx.type === 'repayment' ? (tx.settled_amount ?? tx.amount) : tx.amount;
  return { amount: Math.round(base * conv.rate), kind: conv.kind };
}

/** Signed share of `person` in an expense (+) or refund (-); 0 for other types. */
export function shareOf(tx: Tx, person: Id): number {
  if (tx.type !== 'expense' && tx.type !== 'refund') return 0;
  const s = tx.splits.find((x) => x.person_id === person);
  return s ? (tx.type === 'expense' ? s.amount : -s.amount) : 0;
}
