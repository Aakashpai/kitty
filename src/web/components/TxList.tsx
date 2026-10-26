import { shareOf, type Tx } from '../../engine/index.ts';
import { useLedger, type Ledger } from '../store.tsx';
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
export function myImpact(tx: Tx, l: Ledger): { amount: number; currency: string; label: string } | null {
  const me = l.me.id;
  switch (tx.type) {
    case 'expense':
    case 'refund': {
      const s = shareOf(tx, me);
      return s ? { amount: -s, currency: tx.currency, label: 'your share' } : null;
    }
    case 'repayment':
      if (tx.payer_id === me) return { amount: -tx.amount, currency: tx.currency, label: 'you paid' };
      if (tx.payee_id === me) return { amount: tx.amount, currency: tx.currency, label: 'you received' };
      return null;
    case 'income':
      return tx.payer_id === me ? { amount: tx.amount, currency: tx.currency, label: 'income' } : null;
    default:
      return tx.fee_amount ? { amount: -tx.fee_amount, currency: tx.currency, label: 'fee' } : null;
  }
}

export function TxList({ txs, onSelect, showTrip = true }: { txs: Tx[]; onSelect: (tx: Tx) => void; showTrip?: boolean }) {
  const l = useLedger();
  if (!txs.length) return <Empty title="Nothing here yet">Transactions you record will show up in this list.</Empty>;
  return (
    <div className="txlist" data-testid="tx-list">
      {txs.map((tx) => {
        const mine = l.readOnly ? null : myImpact(tx, l);
        const trip = tx.trip_id != null ? l.trips.get(tx.trip_id) : null;
        const meta = [fmtShort(tx.date), txWho(tx, l), tx.category, showTrip && trip?.name].filter(Boolean).join(' · ');
        return (
          <button type="button" key={tx.id} className="txrow" onClick={() => onSelect(tx)} data-testid={`tx-row-${tx.id}`}>
            <TypeIcon type={tx.type} />
            <span className="body">
              <span className="title">{tx.description || TYPE_LABEL[tx.type]}</span>
              <span className="meta">{meta}</span>
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
