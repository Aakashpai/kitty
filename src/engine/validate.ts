import type { Account, Id, LedgerCtx, Person, TxInput } from './types.ts';
import { TX_TYPES } from './types.ts';
import { decimalsOf, negligible } from './money.ts';
import { refundedTotal } from './balances.ts';

const isMinor = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
const optStr = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const optInt = (v: unknown): number | null => (v === '' || v == null ? null : isMinor(Number(v)) ? Number(v) : NaN);

/** Coerce a raw JSON body into a TxInput shape with trimmed strings and nulls for blanks. */
export function normalizeTx(raw: Record<string, unknown>): TxInput {
  const type = String(raw.type ?? 'expense') as TxInput['type'];
  const splitType = type === 'expense' || type === 'refund';
  const moneyType = type === 'transfer' || type === 'withdrawal';
  const splitsRaw = Array.isArray(raw.splits) && splitType ? raw.splits : [];
  return {
    ...(raw.id != null ? { id: Number(raw.id) } : {}),
    type,
    date: String(raw.date ?? '').trim(),
    description: String(raw.description ?? '').trim(),
    notes: optStr(raw.notes),
    category: splitType || type === 'income' ? optStr(raw.category) : null,
    trip_id: optInt(raw.trip_id),
    currency: String(raw.currency ?? '').trim().toUpperCase(),
    amount: Number(raw.amount),
    payer_id: optInt(raw.payer_id),
    payee_id: type === 'repayment' ? optInt(raw.payee_id) : null,
    from_account_id: type === 'refund' || type === 'income' ? null : optInt(raw.from_account_id),
    from_amount: type === 'refund' || type === 'income' ? null : optInt(raw.from_amount),
    to_account_id: type === 'expense' ? null : optInt(raw.to_account_id),
    to_amount: type === 'expense' ? null : optInt(raw.to_amount),
    fee_amount: moneyType ? optInt(raw.fee_amount) : null,
    settled_amount: type === 'repayment' ? optInt(raw.settled_amount) : null,
    settled_currency: type === 'repayment' ? (optStr(raw.settled_currency)?.toUpperCase() ?? null) : null,
    linked_tx_id: type === 'refund' ? optInt(raw.linked_tx_id) : null,
    method: optStr(raw.method),
    reference: optStr(raw.reference),
    split_method: splitType ? ((optStr(raw.split_method) ?? 'equal') as TxInput['split_method']) : null,
    items: splitType && Array.isArray(raw.items) && raw.items.length
      ? raw.items.slice(0, 100).map((x: Record<string, unknown>) => ({ name: String(x?.name ?? '').trim().slice(0, 60), amount: Number(x?.amount), people: Array.isArray(x?.people) ? x.people.map(Number) : [] }))
      : null,
    full_settlement: type === 'repayment' && (raw.full_settlement === 1 || raw.full_settlement === true) ? 1 : 0,
    splits: splitsRaw.map((s: Record<string, unknown>) => ({
      person_id: Number(s.person_id),
      amount: Number(s.amount),
      input: s.input == null || s.input === '' ? null : Number(s.input),
    })),
  };
}

/** Returns a list of human-readable problems; an empty list means the transaction is valid. */
export function validateTx(tx: TxInput, ctx: LedgerCtx): string[] {
  const errs: string[] = [];
  const people = new Map(ctx.people.map((p) => [p.id, p]));
  const accounts = new Map(ctx.accounts.map((a) => [a.id, a]));

  if (!TX_TYPES.includes(tx.type)) return ['Unknown transaction type'];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tx.date) || Number.isNaN(Date.parse(tx.date))) errs.push('Date must be a valid YYYY-MM-DD');
  if (!/^[A-Z]{3}$/.test(tx.currency)) errs.push('Currency must be a 3-letter code');
  if (!isMinor(tx.amount) || tx.amount <= 0) errs.push('Amount must be greater than zero');
  if (tx.trip_id != null && !ctx.trips.some((t) => t.id === tx.trip_id)) errs.push('Trip not found');
  if (tx.description.length > 200) errs.push('Description is too long');

  const person = (id: Id | null, label: string): Person | null => {
    if (id == null || Number.isNaN(id)) {
      errs.push(`${label} is required`);
      return null;
    }
    const p = people.get(id);
    if (!p) errs.push(`${label}: person not found`);
    return p ?? null;
  };
  const account = (id: Id | null, label: string, owner: Id | null, required: boolean): Account | null => {
    if (id == null || Number.isNaN(id)) {
      if (required) errs.push(`${label} is required`);
      return null;
    }
    const a = accounts.get(id);
    if (!a) errs.push(`${label}: account not found`);
    else if (owner != null && a.person_id !== owner) errs.push(`${label} must belong to ${people.get(owner)?.name ?? 'the same person'}`);
    return a ?? null;
  };
  // Leg amount in the account's own currency: must be given when currencies differ, must equal `amount` otherwise.
  const leg = (a: Account | null, legAmount: number | null, label: string) => {
    if (!a) {
      if (legAmount != null) errs.push(`${label}: amount given without an account`);
      return;
    }
    if (a.currency === tx.currency) {
      if (legAmount != null && legAmount !== tx.amount) errs.push(`${label}: amount must equal ${tx.amount} when the account is also in ${tx.currency}`);
    } else if (!isMinor(legAmount) || legAmount <= 0) {
      errs.push(`${label}: enter the amount in ${a.currency} for ${a.name}`);
    }
  };
  const none = (v: unknown, label: string) => {
    if (v != null && v !== 0 && !(Array.isArray(v) && v.length === 0)) errs.push(`${label} does not apply to a ${tx.type}`);
  };

  switch (tx.type) {
    case 'expense':
    case 'refund': {
      const isExpense = tx.type === 'expense';
      const payer = person(tx.payer_id, isExpense ? 'Payer' : 'Refund recipient');
      if (!tx.description) errs.push('Description is required');
      if (isExpense) {
        none(tx.to_account_id, 'Destination account');
        leg(account(tx.from_account_id, 'Payment source', payer?.id ?? null, false), tx.from_amount, 'Payment source');
      } else {
        none(tx.from_account_id, 'Source account');
        leg(account(tx.to_account_id, 'Refund destination', payer?.id ?? null, false), tx.to_amount, 'Refund destination');
      }
      none(tx.fee_amount, 'Fee');
      none(tx.payee_id, 'Recipient');
      if (!tx.splits.length) errs.push('Choose at least one participant');
      const seen = new Set<Id>();
      let total = 0;
      for (const s of tx.splits) {
        if (!people.has(s.person_id)) errs.push('Participant not found');
        if (seen.has(s.person_id)) errs.push('A participant is listed twice');
        seen.add(s.person_id);
        if (!isMinor(s.amount) || s.amount < 0) errs.push('Shares must be whole non-negative amounts');
        else total += s.amount;
      }
      if (isMinor(tx.amount) && total !== tx.amount) errs.push(`Shares add up to ${total}, expected ${tx.amount}`);
      if (tx.items?.length) {
        if (tx.items.some((it) => !isMinor(it.amount) || it.amount <= 0 || !it.people.length)) errs.push('Each item needs a price and at least one person');
        if (tx.items.some((it) => it.people.some((p) => !people.has(p)))) errs.push('Item shared with someone not found');
        if (isMinor(tx.amount) && tx.items.reduce((s, it) => s + (isMinor(it.amount) ? it.amount : 0), 0) > tx.amount) errs.push('Items add up to more than the total');
      }
      if (!isExpense && tx.linked_tx_id != null) {
        const orig = ctx.transactions.find((t) => t.id === tx.linked_tx_id);
        if (!orig || orig.type !== 'expense') errs.push('A refund can only be linked to an expense');
        else {
          if (orig.currency !== tx.currency) errs.push(`Refund must be in ${orig.currency}, the currency of the original expense`);
          if (orig.trip_id !== tx.trip_id) errs.push('Refund must stay in the same trip as the original expense');
          if (isMinor(tx.amount) && refundedTotal(ctx.transactions, orig.id, tx.id) + tx.amount > orig.amount) errs.push('Refunds would exceed the original expense');
          if (tx.payer_id != null && orig.payer_id !== tx.payer_id) errs.push('Refund recipient must be the original payer');
        }
      }
      break;
    }
    case 'transfer':
    case 'withdrawal': {
      const owner = person(tx.payer_id, 'Account owner');
      const from = account(tx.from_account_id, 'Source account', owner?.id ?? null, true);
      const to = account(tx.to_account_id, 'Destination account', owner?.id ?? null, true);
      if (from && to && from.id === to.id) errs.push('Source and destination must differ');
      if (from && from.currency !== tx.currency) errs.push(`Amount must be in ${from.currency}, the source account currency`);
      if (tx.from_amount != null && tx.from_amount !== tx.amount) errs.push('Source amount must equal the transaction amount');
      leg(to, tx.to_amount, 'Destination');
      if (tx.fee_amount != null && (!isMinor(tx.fee_amount) || tx.fee_amount < 0)) errs.push('Fee must be zero or more');
      if (tx.type === 'withdrawal' && to && to.type !== 'cash') errs.push('A cash withdrawal must land in a cash holding');
      none(tx.splits, 'Participants');
      none(tx.payee_id, 'Recipient');
      break;
    }
    case 'repayment': {
      const payer = person(tx.payer_id, 'Payer');
      const payee = person(tx.payee_id, 'Recipient');
      if (payer && payee && payer.id === payee.id) errs.push('Payer and recipient must differ');
      leg(account(tx.from_account_id, "Payer's account", payer?.id ?? null, false), tx.from_amount, "Payer's account");
      leg(account(tx.to_account_id, "Recipient's account", payee?.id ?? null, false), tx.to_amount, "Recipient's account");
      const sc = tx.settled_currency ?? tx.currency;
      if (!/^[A-Z]{3}$/.test(sc)) errs.push('Settled currency must be a 3-letter code');
      if (sc === tx.currency) {
        // Equal, except a negligible leftover called square, which settles nothing (see squareUp)
        if (tx.settled_amount != null && tx.settled_amount !== tx.amount && !(tx.settled_amount === 0 && negligible(tx.amount, tx.currency, ctx.settings?.square_under))) errs.push('Settled amount must equal the amount paid when the currency is the same');
      } else if (!isMinor(tx.settled_amount) || tx.settled_amount <= 0) {
        errs.push(`Enter how much ${sc} this payment settles`);
      }
      none(tx.splits, 'Participants');
      none(tx.fee_amount, 'Fee');
      break;
    }
    case 'income': {
      const who = person(tx.payer_id, 'Recipient');
      if (!tx.description) errs.push('Description is required');
      none(tx.from_account_id, 'Source account');
      leg(account(tx.to_account_id, 'Deposit account', who?.id ?? null, false), tx.to_amount, 'Deposit account');
      none(tx.splits, 'Participants');
      none(tx.fee_amount, 'Fee');
      break;
    }
  }
  return [...new Set(errs)];
}
