import { Pencil, Trash2, Undo2 } from 'lucide-react';
import { formatAmount, refundedTotal, toMajor, type Tx, type TxInput } from '../../engine/index.ts';
import { api } from '../api.ts';
import { useLedger } from '../store.tsx';
import { useTxForm } from './txFormContext.ts';
import { Avatar, Modal, Money, TypeBadge, TypeIcon, fmtDate, fmtWhen } from './ui.tsx';
import { EffectsView } from './effectsView.tsx';
import { txWho } from './TxList.tsx';

/** Prefill for a refund against an expense: same trip/currency/recipient, shares pro-rata. */
export function refundPrefill(tx: Tx, all: Tx[]): Partial<TxInput> {
  const remaining = Math.max(tx.amount - refundedTotal(all, tx.id), 0);
  return {
    type: 'refund',
    linked_tx_id: tx.id,
    currency: tx.currency,
    trip_id: tx.trip_id,
    payer_id: tx.payer_id,
    category: tx.category,
    description: `Refund: ${tx.description}`,
    amount: remaining,
    split_method: 'weight',
    splits: tx.splits.map((s) => ({ person_id: s.person_id, amount: s.amount, input: Number(toMajor(s.amount, tx.currency)) })),
  };
}

export function TxDetail({ tx, onClose }: { tx: Tx; onClose: () => void }) {
  const l = useLedger();
  const openForm = useTxForm();
  const { state, who, accounts, trips, people, readOnly } = l;
  const trip = tx.trip_id != null ? trips.get(tx.trip_id) : null;
  const from = tx.from_account_id != null ? accounts.get(tx.from_account_id) : null;
  const to = tx.to_account_id != null ? accounts.get(tx.to_account_id) : null;
  const refunds = state.transactions.filter((t) => t.linked_tx_id === tx.id);
  const original = tx.linked_tx_id != null ? state.transactions.find((t) => t.id === tx.linked_tx_id) : null;
  const history = state.activity.filter((a) => a.entity === 'transaction' && a.entity_id === tx.id);
  const rows: [string, string][] = [
    ['Date', fmtDate(tx.date)],
    ['Who', txWho(tx, l)],
  ];
  if (tx.category) rows.push(['Category', tx.category]);
  rows.push(['Trip', trip ? trip.name : 'None (personal)']);
  if (from) rows.push([tx.type === 'repayment' ? `${who(tx.payer_id)} paid from` : 'From account', `${from.name} · ${formatAmount(tx.from_amount ?? tx.amount, from.currency)}`]);
  if (to) rows.push([tx.type === 'repayment' ? `${who(tx.payee_id)} received into` : tx.type === 'withdrawal' ? 'Cash holding' : 'To account', `${to.name} · ${formatAmount(tx.to_amount ?? tx.amount, to.currency)}`]);
  if (tx.fee_amount) rows.push(['Fee', formatAmount(tx.fee_amount, tx.currency)]);
  if (tx.settled_currency && tx.settled_currency !== tx.currency) rows.push(['Settles', formatAmount(tx.settled_amount ?? 0, tx.settled_currency)]);
  if (tx.type === 'repayment') rows.push(['Intent', tx.full_settlement ? 'Settles the remaining balance' : 'Partial repayment']);
  if (tx.method) rows.push(['Method', tx.method]);
  if (tx.reference) rows.push(['Reference', tx.reference]);
  if (tx.notes) rows.push(['Notes', tx.notes]);
  if (original) rows.push(['Refund of', `${original.description} (${formatAmount(original.amount, original.currency)}, ${fmtDate(original.date)})`]);

  return (
    <Modal title={tx.description || 'Transaction'} onClose={onClose}>
      <div className="stack" data-testid="tx-detail">
        <div className="row between">
          <span className="row"><TypeIcon type={tx.type} /><span><TypeBadge type={tx.type} /><div className="faint small mono">#{tx.id}</div></span></span>
          <span className="mono" style={{ fontSize: 22, fontWeight: 500 }}>{formatAmount(tx.amount, tx.currency)}</span>
        </div>
        <dl className="kv">
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {tx.splits.length > 0 && (
          <div className="panel">
            <div className="table-wrap">
              <table>
                <thead><tr><th>Participant</th><th className="num">Share</th></tr></thead>
                <tbody>
                  {tx.splits.map((s) => (
                    <tr key={s.person_id}>
                      <td><span className="who"><Avatar id={s.person_id} name={people.get(s.person_id)?.name ?? '?'} small />{who(s.person_id)}{s.person_id === tx.payer_id && <span className="faint small">· {tx.type === 'expense' ? 'paid' : 'receives'}</span>}</span></td>
                      <td className="num"><Money amount={s.amount} currency={tx.currency} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <EffectsView tx={tx} />
        {tx.type === 'expense' && refunds.length > 0 && (
          <div className="info-box">
            <strong>Refunds</strong>
            <ul>
              {refunds.map((r) => <li key={r.id}>{fmtDate(r.date)} · {r.description} · {formatAmount(r.amount, r.currency)}</li>)}
            </ul>
            <div className="muted small">Net after refunds: {formatAmount(tx.amount - refundedTotal(state.transactions, tx.id), tx.currency)}</div>
          </div>
        )}
        {!readOnly && history.length > 0 && (
          <details>
            <summary>History ({history.length})</summary>
            <ul className="activity">
              {history.map((a) => <li key={a.id}><time>{fmtWhen(a.at)}</time><span>{a.summary}</span></li>)}
            </ul>
          </details>
        )}
        {!readOnly && <div className="row between">
          <div className="row">
            <button onClick={() => openForm({ existing: tx, onSaved: onClose })} data-testid="edit-tx"><Pencil />Edit</button>
            {tx.type === 'expense' && tx.amount > refundedTotal(state.transactions, tx.id) && (
              <button onClick={() => openForm({ initial: refundPrefill(tx, state.transactions), onSaved: onClose })} data-testid="refund-tx"><Undo2 />Record refund</button>
            )}
          </div>
          <button
            className="danger"
            onClick={async () => {
              if (!window.confirm(`Delete this ${tx.type}? Balances will be recalculated without it. A snapshot stays in the activity history.`)) return;
              await api('DELETE', `/api/transactions/${tx.id}`);
              await l.reload();
              onClose();
            }}
            data-testid="delete-tx"
          >
            <Trash2 />Delete
          </button>
        </div>}
      </div>
    </Modal>
  );
}
