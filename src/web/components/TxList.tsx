import { formatAmount, shareOf, type Tx } from '../../engine/index.ts';
import { useLedger, type Ledger } from '../store.tsx';
import { Download, MessageCircle, Paperclip } from 'lucide-react';
import { exportEntries } from './exportCsv.ts';
import { Empty, Money, TYPE_LABEL, TypeIcon, fmtShort } from './ui.tsx';

export function txWho(tx: Tx, l: Ledger): string {
  switch (tx.type) {
    case 'expense': {
      const others = tx.splits.filter((s) => s.person_id !== tx.payer_id);
      const tail = tx.splits.length > 1 ? ` · split ${tx.splits.length} ways` : others.length === 1 ? ` for ${l.who(others[0]!.person_id)}` : ' · personal';
      return `Paid by ${l.who(tx.payer_id)}${tail}`;
    }
    case 'refund':
      return `To ${l.who(tx.payer_id)}${tx.splits.length > 1 ? ` · ${tx.splits.length} people` : ''}`;
    case 'transfer':
    case 'withdrawal':
      return `${l.accountName(tx.from_account_id)} → ${l.accountName(tx.to_account_id)}`;
    case 'repayment':
      return `${l.who(tx.payer_id)} → ${l.who(tx.payee_id)}${tx.method ? ` · ${tx.method}` : ''}`;
    case 'income':
      return `${l.who(tx.payer_id)}${tx.to_account_id != null ? ` → ${l.accountName(tx.to_account_id)}` : ''}`;
  }
}

/** What this transaction means for "me": cost (negative) or money in (positive). */
/**
 * What one entry did to `as`'s balance, in words a friend can read on their own page: who paid, whose share it was,
 * what was paid back. Positive = money owed to them or received; negative = their cost or what they paid out.
 */
export function myImpact(tx: Tx, l: Ledger, as: number = l.me.id): { amount: number; currency: string; label: string } | null {
  const me = as;
  const you = as === l.me.id;
  const name = you ? 'you' : l.who(as);
  const own = you ? 'your' : `${l.who(as)}’s`;
  const cap = (t: string) => t[0]!.toUpperCase() + t.slice(1);
  switch (tx.type) {
    case 'expense': {
      const share = shareOf(tx, me);
      if (tx.payer_id === me) {
        const owed = tx.amount - share;
        if (owed <= 0) return { amount: -share, currency: tx.currency, label: `${cap(name)} paid, own cost` };
        const others = tx.splits.filter((x) => x.person_id !== me).map((x) => l.who(x.person_id));
        return { amount: owed, currency: tx.currency, label: `owed to ${name} by ${others.length > 2 ? `${others.length} people` : others.join(' & ')}` };
      }
      return share ? { amount: -share, currency: tx.currency, label: `${own} share · ${l.who(tx.payer_id)} paid` } : null;
    }
    case 'refund': {
      const share = shareOf(tx, me); // negative: money back
      if (tx.payer_id === me) {
        const passOn = tx.amount + share;
        return passOn > 0 ? { amount: -passOn, currency: tx.currency, label: `${name} received it, ${formatAmount(passOn, tx.currency)} is others’` } : { amount: -share, currency: tx.currency, label: `refunded to ${name}` };
      }
      return share ? { amount: -share, currency: tx.currency, label: `${own} part · ${l.who(tx.payer_id)} received it` } : null;
    }
    case 'repayment':
      if (tx.payer_id === me) return { amount: -tx.amount, currency: tx.currency, label: `${name} paid ${l.who(tx.payee_id)}` };
      if (tx.payee_id === me) return { amount: tx.amount, currency: tx.currency, label: `${l.who(tx.payer_id)} paid ${name}` };
      return null;
    case 'income':
      return tx.payer_id === me ? { amount: tx.amount, currency: tx.currency, label: 'income' } : null;
    default:
      return tx.fee_amount ? { amount: -tx.fee_amount, currency: tx.currency, label: 'fee' } : null;
  }
}

/**
 * One real payment that settles several trips (or a trip and a personal debt) is stored as one part per trip, so every
 * trip's balance stays exact; the parts share a `group:` reference and lists show them as a single row.
 */
export const paymentGroup = (tx: Tx) => (tx.type === 'repayment' && tx.reference?.startsWith('group:') ? `${tx.reference}|${tx.currency}` : null);

/** Downloads exactly these entries as a spreadsheet Excel opens (one column per person's share). */
export function ExportButton({ txs, title }: { txs: Tx[]; title: string }) {
  const l = useLedger();
  return <button className="ghost small" disabled={!txs.length} onClick={() => exportEntries(txs, l, title)} title="Download these entries for Excel" data-testid="export-excel"><Download />Excel</button>;
}

export function TxList({ txs, onSelect, showTrip = true, as }: { txs: Tx[]; onSelect: (tx: Tx) => void; showTrip?: boolean; as?: number }) {
  const l = useLedger();
  if (!txs.length) return <Empty title="Nothing here yet">Transactions you record will show up in this list.</Empty>;
  const withReceipt = new Set(l.state.receipts?.map((r) => r.tx_id));
  const talk = new Map<number, number>();
  for (const c of l.state.comments ?? []) talk.set(c.tx_id, (talk.get(c.tx_id) ?? 0) + 1);
  // Parts of one payment collapse into the row of the first part shown; a trip page lists only its own part.
  const seen = new Set<string>();
  const rows = txs.flatMap((tx) => {
    const g = paymentGroup(tx);
    if (!g) return [{ tx, parts: [tx] }];
    if (seen.has(g)) return [];
    seen.add(g);
    return [{ tx, parts: txs.filter((t) => paymentGroup(t) === g) }];
  });
  return (
    <div className="txlist" data-testid="tx-list">
      {rows.map(({ tx, parts }) => {
        const one = l.readOnly && l.state.shared_person_id == null ? null : myImpact(tx, l, as);
        const mine = one && { ...one, amount: parts.reduce((sum, p) => sum + (myImpact(p, l, as)?.amount ?? 0), 0) };
        const amount = parts.reduce((sum, p) => sum + p.amount, 0);
        const where = parts.length > 1 ? [...new Set(parts.map((p) => (p.trip_id != null ? l.trips.get(p.trip_id)?.name : 'personal')))].join(' + ') : tx.trip_id != null ? l.trips.get(tx.trip_id)?.name : null;
        const by = !l.readOnly && tx.added_by != null && tx.added_by !== l.me.id ? `by ${l.who(tx.added_by)}` : null;
        const meta = [fmtShort(tx.date), txWho(tx, l), tx.category, (showTrip || parts.length > 1) && where, by].filter(Boolean).join(' · ');
        return (
          <button type="button" key={tx.id} className="txrow" onClick={() => onSelect(tx)} data-testid={`tx-row-${tx.id}`}>
            <TypeIcon type={tx.type} category={tx.category} />
            <span className="body">
              <span className="title">{tx.description || TYPE_LABEL[tx.type]}</span>
              <span className="meta">{withReceipt.has(tx.id) && <Paperclip className="clip" aria-label="Has a receipt photo" />}{talk.has(tx.id) && <span className="talk" aria-label={`${talk.get(tx.id)} comments`}><MessageCircle className="clip" />{talk.get(tx.id)} </span>}{meta}</span>
              {mine && <span className={`impact ${mine.amount > 0 ? 'pos' : mine.amount < 0 ? 'neg' : ''}`}><Money amount={mine.amount} currency={mine.currency} sign /> · {mine.label}</span>}
            </span>
            <span className="amt">
              <span className="amount"><Money amount={amount} currency={tx.currency} /></span>
              {!mine && (tx.type === 'transfer' || tx.type === 'withdrawal') && <span className="sub faint">not spending</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
