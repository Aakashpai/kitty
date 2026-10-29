import { toMajor, type Id, type Tx } from '../../engine/index.ts';
import { categoryOf, type Ledger } from '../store.tsx';
import { TYPE_LABEL } from './ui.tsx';

const cell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Saves text as a file. CSV gets a UTF-8 byte-order mark, without which Excel misreads ₹, emoji and accents. */
export const download = (name: string, content: string, type: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([type.startsWith('text/csv') ? `﻿${content}` : content], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
};

/**
 * Entries as a spreadsheet Excel opens directly: oldest first, one column per person's share so Excel can total them,
 * real names instead of "You", plus accounts, notes and who added each entry. Exports exactly the entries passed in.
 */
export function exportEntries(txs: Tx[], l: Ledger, title: string) {
  const name = (id: Id | null | undefined) => (id == null ? '' : (l.people.get(id)?.name ?? `#${id}`));
  const order = new Map(l.state.people.map((p, i) => [p.id, i]));
  const people = [...new Set(txs.flatMap((t) => t.splits.map((s) => s.person_id)))].sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
  const acct = (id: Id | null) => (id == null ? '' : (l.accounts.get(id)?.name ?? ''));
  const leg = (amount: number | null, id: Id | null, t: Tx) => (amount == null ? '' : toMajor(amount, (id != null ? l.accounts.get(id)?.currency : undefined) ?? t.currency));
  const head = ['Date', 'Type', 'Description', 'Category', 'Trip', 'Currency', 'Amount', 'Paid by', 'Paid to', ...people.map((p) => `${name(p)}'s share`),
    'From account', 'Charged to that account', 'To account', 'Credited to that account', 'Fee', 'Settles', 'Settles currency', 'Method', 'Reference', 'Notes', 'Added by', 'Entry #'];
  const rows = [...txs].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id).map((t) => [
    t.date, TYPE_LABEL[t.type], t.description, t.type === 'expense' || t.type === 'refund' ? categoryOf(t) : (t.category ?? ''),
    t.trip_id != null ? (l.trips.get(t.trip_id)?.name ?? '') : '', t.currency, toMajor(t.amount, t.currency), name(t.payer_id), name(t.payee_id),
    ...people.map((p) => { const s = t.splits.find((x) => x.person_id === p); return s ? toMajor(s.amount, t.currency) : ''; }),
    acct(t.from_account_id), leg(t.from_amount, t.from_account_id, t), acct(t.to_account_id), leg(t.to_amount, t.to_account_id, t),
    t.fee_amount != null ? toMajor(t.fee_amount, t.currency) : '', t.settled_amount != null ? toMajor(t.settled_amount, t.settled_currency ?? t.currency) : '', t.settled_currency ?? '',
    t.method ?? '', t.reference ?? '', t.notes ?? '', name(t.added_by), t.id,
  ].map(cell).join(','));
  const slug = title.trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'kitty';
  download(`${slug}-${new Date().toISOString().slice(0, 10)}.csv`, [head.map(cell).join(','), ...rows].join('\r\n'), 'text/csv;charset=utf-8');
}
