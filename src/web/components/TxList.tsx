import { shareOf, type Tx } from '../../engine/index.ts';
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
export function myImpact(tx: Tx, l: Ledger, as: number = l.me.id): { amount: number; currency: string; label: string } | null {
  const me = as;
  const you = as === l.me.id;
  const n = you ? 'you' : l.who(as);
  const own = you ? 'your' : `${n}'s`;
  switch (tx.type) {
    case 'expense':
    case 'refund': {
      const s = shareOf(tx, me);
      return s ? { amount: -s, currency: tx.currency, label: `${own} share` } : null;
    }
    case 'repayment':
      if (tx.payer_id === me) return { amount: -tx.amount, currency: tx.currency, label: `${n} paid` };
      if (tx.payee_id === me) return { amount: tx.amount, currency: tx.currency, label: `${n} received` };
      return null;
    case 'income':
      return tx.payer_id === me ? { amount: tx.amount, currency: tx.currency, label: 'income' } : null;
    default:
      return tx.fee_amount ? { amount: -tx.fee_amount, currency: tx.currency, label: 'fee' } : null;
  }
}

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
  return (
    <div className="txlist" data-testid="tx-list">
      {txs.map((tx) => {
        const mine = l.readOnly && l.state.shared_person_id == null ? null : myImpact(tx, l, as);
        const trip = tx.trip_id != null ? l.trips.get(tx.trip_id) : null;
        const by = !l.readOnly && tx.added_by != null && tx.added_by !== l.me.id ? `by ${l.who(tx.added_by)}` : null;
        const meta = [fmtShort(tx.date), txWho(tx, l), tx.category, showTrip && trip?.name, by].filter(Boolean).join(' · ');
        return (
          <button type="button" key={tx.id} className="txrow" onClick={() => onSelect(tx)} data-testid={`tx-row-${tx.id}`}>
            <TypeIcon type={tx.type} category={tx.category} />
            <span className="body">
              <span className="title">{tx.description || TYPE_LABEL[tx.type]}</span>
              <span className="meta">{withReceipt.has(tx.id) && <Paperclip className="clip" aria-label="Has a receipt photo" />}{talk.has(tx.id) && <span className="talk" aria-label={`${talk.get(tx.id)} comments`}><MessageCircle className="clip" />{talk.get(tx.id)} </span>}{meta}</span>
            </span>
            <span className="amt">
              <span className="amount"><Money amount={tx.amount} currency={tx.currency} /></span>
              {mine ? <span className="sub"><Money amount={mine.amount} currency={mine.currency} sign /> <span className="sub-label">{mine.label}</span></span> : <span className="sub faint">{tx.type === 'transfer' || tx.type === 'withdrawal' ? 'not spending' : ''}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
