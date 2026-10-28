import { useRef, useState } from 'react';
import { Camera, CopyPlus, Lock, Pencil, Repeat, Send, Trash2, Undo2, X } from 'lucide-react';
import { formatAmount, refundedTotal, toMajor, type Tx, type TxInput } from '../../engine/index.ts';
import { api, errorText } from '../api.ts';
import { today, useLedger } from '../store.tsx';
import { useTxForm } from './txFormContext.ts';
import { Avatar, ErrorBox, Modal, Money, Spinner, TypeBadge, TypeIcon, fmtDate, fmtWhen, useBusy } from './ui.tsx';
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

/** Prefill for recording the same thing again today. Real account charges stay blank: they differ every time. */
export function againPrefill(tx: Tx): Partial<TxInput> {
  const { id: _id, created_at: _c, updated_at: _u, added_by: _a, edited_by: _e, recurring_id: _r, ...rest } = tx;
  return { ...rest, date: today(), from_amount: null, to_amount: null, settled_amount: null, full_settlement: 0 };
}

/** Phone photos are several MB; a 1600px JPEG keeps a receipt readable at a few hundred KB. */
async function shrink(file: File): Promise<string> {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close();
  return canvas.toDataURL('image/jpeg', 0.75);
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
  const receipts = (state.receipts ?? []).filter((r) => r.tx_id === tx.id);
  const comments = (state.comments ?? []).filter((c) => c.tx_id === tx.id);
  const [note, setNote] = useState('');
  const rule = tx.recurring_id != null ? state.recurring?.find((r) => r.id === tx.recurring_id) : undefined;
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, run] = useBusy();
  const [err, setErr] = useState<string | null>(null);
  const act = (fn: () => Promise<unknown>) => run(async () => {
    try {
      await fn();
      await l.reload();
      setErr(null);
    } catch (e) {
      setErr(errorText(e));
    }
  });
  const attach = (file: File) => act(async () => api('POST', `/api/transactions/${tx.id}/receipts`, { data: await shrink(file) }));
  const remove = () => {
    if (busy || !window.confirm(`Delete this ${tx.type}? Balances will be recalculated without it. A snapshot stays in the activity history.`)) return;
    void run(async () => {
      try {
        await api('DELETE', `/api/transactions/${tx.id}`);
        await l.reload();
        onClose();
      } catch (e) {
        setErr(errorText(e));
      }
    });
  };
  const rows: [string, string][] = [
    ['Date', fmtDate(tx.date)],
    ['Who', txWho(tx, l)],
  ];
  if (tx.category) rows.push(['Category', tx.category]);
  if (tx.added_by != null) rows.push(['Added', `${who(tx.added_by)} · ${fmtWhen(tx.created_at)}`]);
  if (tx.edited_by != null) rows.push(['Edited', `${who(tx.edited_by)} · ${fmtWhen(tx.updated_at)}`]);
  if (tx.recurring_id != null) rows.push(['Repeats', rule ? `${rule.every === 'weekly' ? 'Every week' : 'Every month'} · next ${fmtDate(rule.next_date)}` : 'Stopped']);
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
          <span className="row"><TypeIcon type={tx.type} category={tx.category} /><span><TypeBadge type={tx.type} /><div className="faint small mono">#{tx.id}</div></span></span>
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
        {tx.items?.length ? (
          <div className="info-box small" data-testid="tx-items">
            <strong>Items</strong>
            <ul>{tx.items.map((it, i) => <li key={i}>{it.name} · {formatAmount(it.amount, tx.currency)} · {it.people.map((p) => who(p)).join(', ')}</li>)}</ul>
            {tx.amount > tx.items.reduce((s, it) => s + it.amount, 0) && <div className="muted">Tax, service & tip {formatAmount(tx.amount - tx.items.reduce((s, it) => s + it.amount, 0), tx.currency)} shared by what each had</div>}
          </div>
        ) : null}
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
        {!readOnly && (
          <div className="stack tight" data-testid="receipts">
            <div className="row between">
              <strong className="small">Receipts</strong>
              <button className="small" disabled={busy} onClick={() => fileRef.current?.click()} data-testid="add-receipt">{busy ? <Spinner /> : <Camera />}Add photo</button>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void attach(f); }} data-testid="receipt-file" />
            </div>
            {receipts.length > 0 && (
              <div className="receipts">
                {receipts.map((r) => (
                  <span key={r.id} className="receipt">
                    <a href={`/api/receipts/${r.id}`} target="_blank" rel="noreferrer"><img src={`/api/receipts/${r.id}`} alt="Receipt" loading="lazy" /></a>
                    <button className="ghost icon small" aria-label="Remove photo" disabled={busy} onClick={() => { if (window.confirm('Remove this photo?')) void act(() => api('DELETE', `/api/receipts/${r.id}`)); }}><X /></button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        {!readOnly && (
          <div className="stack tight" data-testid="comments">
            <strong className="small">Comments</strong>
            {comments.map((c) => (
              <div key={c.id} className="comment">
                <Avatar id={c.person_id ?? 0} name={people.get(c.person_id ?? -1)?.name ?? '?'} small />
                <div className="body">
                  <div className="small"><strong>{who(c.person_id)}</strong> <span className="faint">{fmtWhen(c.created_at)}</span>
                    {(l.owner || c.person_id === l.me.id) && <button className="link small" disabled={busy} onClick={() => { if (window.confirm('Delete this comment?')) void act(() => api('DELETE', `/api/comments/${c.id}`)); }}>Delete</button>}
                  </div>
                  <div className="text">{c.body}</div>
                </div>
              </div>
            ))}
            <form className="row comment-form" onSubmit={(e) => { e.preventDefault(); const body = note.trim(); if (body) void act(async () => { await api('POST', `/api/transactions/${tx.id}/comments`, { body }); setNote(''); }); }}>
              <input value={note} maxLength={1000} placeholder={comments.length ? 'Reply…' : 'Ask or explain something about this entry'} onChange={(e) => setNote(e.target.value)} data-testid="comment-input" />
              <button type="submit" disabled={busy || !note.trim()} data-testid="comment-send"><Send />Send</button>
            </form>
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
        {!readOnly && trip?.closed ? <div className="faint small row" data-testid="tx-locked"><Lock />{trip.name} is closed, so this entry is locked.</div> : null}
        {!readOnly && !trip?.closed && <div className="row between">
          <div className="row">
            <button onClick={() => openForm({ existing: tx, onSaved: onClose })} data-testid="edit-tx"><Pencil />Edit</button>
            {tx.type !== 'refund' && <button onClick={() => openForm({ initial: againPrefill(tx) })} data-testid="again-tx"><CopyPlus />Add again</button>}
            {rule && <button disabled={busy} onClick={() => { if (window.confirm('Stop repeating? Entries already added stay.')) void act(() => api('DELETE', `/api/recurring/${rule.id}`)); }} data-testid="stop-repeat"><Repeat />Stop repeating</button>}
            {tx.type === 'expense' && tx.amount > refundedTotal(state.transactions, tx.id) && (
              <button onClick={() => openForm({ initial: refundPrefill(tx, state.transactions), onSaved: onClose })} data-testid="refund-tx"><Undo2 />Record refund</button>
            )}
          </div>
          <button className="danger" disabled={busy} onClick={remove} data-testid="delete-tx">
            {busy ? <Spinner /> : <Trash2 />}Delete
          </button>
        </div>}
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}
