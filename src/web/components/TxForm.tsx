import { useEffect, useMemo, useRef, useState } from 'react';
import {
  allocate, computeBalances, decimalsOf, emptyTx, formatAmount, pairwiseDebts, parseAmount, refundedTotal, splitByItems, toMajor, validateTx,
  TX_TYPES, type Account, type Id, type Split, type SplitMethod, type Tx, type TxInput, type TxType,
} from '../../engine/index.ts';
import { ApiError, api, enqueue, errorText } from '../api.ts';
import { CATEGORIES, COMMON_CURRENCIES, categoryOf, guessCategory, today, useLedger } from '../store.tsx';
import { Plus, X } from 'lucide-react';
import { CategoryGlyph, ErrorBox, Field, Money, TYPE_LABEL, TypeIcon } from './ui.tsx';
import { useTxForm } from './txFormContext.ts';
import { againPrefill } from './TxDetail.tsx';
import { EffectsView } from './effectsView.tsx';

const TYPE_HELP: Record<TxType, string> = {
  expense: 'Money spent, optionally shared',
  transfer: 'Between your own accounts',
  withdrawal: 'Bank or card to cash in hand',
  repayment: 'Someone pays someone back',
  income: 'Salary, gifts, other money in',
  refund: 'Money back for an expense',
};
const SPLIT_LABEL: Record<SplitMethod, string> = { equal: 'Equally', amount: 'Exact amounts', percent: 'Percentages', weight: 'Weights' };
const METHODS = ['Cash', 'UPI', 'Bank transfer', 'PayNow', 'Card', 'Other'];

interface Texts { amount: string; from_amount: string; to_amount: string; fee_amount: string; settled_amount: string }

interface Props {
  initial?: Partial<TxInput>;
  existing?: Tx;
  onClose: () => void;
  onSaved: (tx: Tx) => void;
}

export function TxForm({ initial, existing, onClose, onSaved }: Props) {
  const ledger = useLedger();
  const { state, me, people, accounts, trips, who, reload } = ledger;
  const openForm = useTxForm();
  const [repeatEvery, setRepeatEvery] = useState<'' | 'weekly' | 'monthly'>('');

  const [tx, setTx] = useState<TxInput>(() => {
    if (existing) return { ...existing };
    const tripCur = initial?.trip_id != null ? trips.get(initial.trip_id)?.currency : undefined;
    return { ...emptyTx(initial?.type ?? 'expense', today(), tripCur ?? state.settings.home_currency), payer_id: me.id, ...initial };
  });
  const [participants, setParticipants] = useState<Id[]>(() => {
    if (tx.splits.length) return tx.splits.map((s) => s.person_id);
    const trip = tx.trip_id != null ? trips.get(tx.trip_id) : null;
    return trip?.members.length ? trip.members : [me.id];
  });
  const [splitInputs, setSplitInputs] = useState<Record<Id, string>>(() => {
    const out: Record<Id, string> = {};
    for (const s of tx.splits) out[s.person_id] = tx.split_method === 'amount' ? toMajor(s.amount, tx.currency) : s.input == null ? '' : String(s.input);
    return out;
  });
  const [texts, setTexts] = useState<Texts>(() => {
    const cur = (id: Id | null) => (id == null ? tx.currency : (accounts.get(id)?.currency ?? tx.currency));
    return {
      amount: tx.amount ? toMajor(tx.amount, tx.currency) : '',
      from_amount: tx.from_amount != null ? toMajor(tx.from_amount, cur(tx.from_account_id)) : '',
      to_amount: tx.to_amount != null ? toMajor(tx.to_amount, cur(tx.to_account_id)) : '',
      fee_amount: tx.fee_amount != null ? toMajor(tx.fee_amount, cur(tx.from_account_id)) : '',
      settled_amount: tx.settled_amount != null ? toMajor(tx.settled_amount, tx.settled_currency ?? tx.currency) : '',
    };
  });
  const [crossSettle, setCrossSettle] = useState(!!tx.settled_currency && tx.settled_currency !== tx.currency);
  const [advanced, setAdvanced] = useState(!!(tx.notes || tx.reference));
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const patch = (p: Partial<TxInput>) => setTx((t) => ({ ...t, ...p }));
  // Escape closes, like every other dialog (a click outside already does).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // A new expense takes its category from the description until the category is picked by hand.
  const catPicked = useRef(!!existing || !!initial?.category);
  const [otherCat, setOtherCat] = useState(() => (tx.category && !CATEGORIES.includes(tx.category) ? tx.category : ''));
  const pickCategory = (category: string | null) => { catPicked.current = true; patch({ category }); };
  // Typed names snap to a preset's spelling ("food" is Food), so the same category never splits into two rows.
  const typeCategory = (text: string) => {
    setOtherCat(text);
    const v = text.trim();
    pickCategory(CATEGORIES.find((c) => c.toLowerCase() === v.toLowerCase()) ?? (v || null));
  };
  const setText = (k: keyof Texts, v: string) => setTexts((t) => ({ ...t, [k]: v }));
  // Itemised bill: what was ordered and who had it. Saved as exact shares plus the items, so it can be edited later.
  const [byItem, setByItem] = useState(() => !!tx.items?.length);
  const [itemRows, setItemRows] = useState<{ name: string; price: string; people: Id[] }[]>(() =>
    tx.items?.length ? tx.items.map((it) => ({ name: it.name, price: toMajor(it.amount, tx.currency), people: it.people })) : [{ name: '', price: '', people: [] }]);
  const setItem = (i: number, p: Partial<(typeof itemRows)[number]>) => setItemRows((rows) => rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const isSplit = tx.type === 'expense' || tx.type === 'refund';
  const isMove = tx.type === 'transfer' || tx.type === 'withdrawal';
  const activePeople = state.people.filter((p) => !p.archived || participants.includes(p.id));
  const accountsOf = (person: Id | null, cashOnly = false, current: Id | null = null) =>
    state.accounts.filter((a) => a.person_id === person && (!a.archived || a.id === current) && (!cashOnly || a.type === 'cash'));
  const fromAcct = tx.from_account_id != null ? accounts.get(tx.from_account_id) : undefined;
  const toAcct = tx.to_account_id != null ? accounts.get(tx.to_account_id) : undefined;

  const setType = (type: TxType) => {
    const base = emptyTx(type, tx.date, tx.currency);
    setTx({ ...base, description: tx.description, notes: tx.notes, trip_id: tx.trip_id, category: tx.category, payer_id: me.id, split_method: type === 'expense' || type === 'refund' ? 'equal' : null });
    setTexts((t) => ({ amount: t.amount, from_amount: '', to_amount: '', fee_amount: '', settled_amount: '' }));
    setCrossSettle(false);
  };
  const setTrip = (id: Id | null) => {
    const trip = id != null ? trips.get(id) : null;
    patch({ trip_id: id, currency: isMove ? tx.currency : (trip?.currency ?? state.settings.home_currency) });
    if (tx.type === 'expense') setParticipants(trip?.members.length ? trip.members : [me.id]);
  };
  const toggleParticipant = (id: Id) => setParticipants((ps) => (ps.includes(id) ? ps.filter((p) => p !== id) : [...ps, id]));

  // Refund: copy everything from the original expense, splits pro-rata by the original shares.
  const linkExpense = (id: Id | null) => {
    const orig = id != null ? state.transactions.find((t) => t.id === id) : undefined;
    if (!orig) return patch({ linked_tx_id: null });
    const remaining = orig.amount - refundedTotal(state.transactions, orig.id, existing?.id);
    patch({ linked_tx_id: orig.id, currency: orig.currency, trip_id: orig.trip_id, payer_id: orig.payer_id, category: orig.category, description: tx.description || `Refund: ${orig.description}`, split_method: 'weight', to_account_id: null });
    setParticipants(orig.splits.map((s) => s.person_id));
    setSplitInputs(Object.fromEntries(orig.splits.map((s) => [s.person_id, toMajor(s.amount, orig.currency)])));
    setTexts((t) => ({ ...t, amount: toMajor(Math.max(remaining, 0), orig.currency), to_amount: '' }));
  };

  // Outstanding between payer and recipient (scoped to the trip when one is chosen), used for "settle remaining".
  const outstanding = useMemo(() => {
    if (tx.type !== 'repayment' || tx.payer_id == null || tx.payee_id == null) return [];
    const scoped = state.transactions.filter((t) => t.id !== existing?.id && (tx.trip_id == null || t.trip_id === tx.trip_id));
    return pairwiseDebts(computeBalances(scoped)).filter((d) => (d.from === tx.payer_id && d.to === tx.payee_id) || (d.from === tx.payee_id && d.to === tx.payer_id));
  }, [state.transactions, tx.type, tx.payer_id, tx.payee_id, tx.trip_id, existing?.id]);

  const built = useMemo(() => {
    const errs: string[] = [];
    const num = (text: string, cur: string, label: string): number | null => {
      if (!text.trim()) return null;
      const v = parseAmount(text, cur);
      if (v == null) errs.push(`${label} is not a valid ${cur} amount`);
      return v;
    };
    const amount = num(texts.amount, tx.currency, 'Amount') ?? 0;
    const from_amount = fromAcct && fromAcct.currency !== tx.currency ? num(texts.from_amount, fromAcct.currency, `Amount in ${fromAcct.currency}`) : null;
    const to_amount = toAcct && toAcct.currency !== tx.currency ? num(texts.to_amount, toAcct.currency, `Amount in ${toAcct.currency}`) : null;
    const fee_amount = isMove ? num(texts.fee_amount, tx.currency, 'Fee') : null;
    const square = tx.type === 'repayment' && tx.settled_amount === 0 && tx.settled_currency === tx.currency; // a leftover called square settles nothing; editing keeps it so
    const settled_currency = square ? tx.currency : tx.type === 'repayment' && crossSettle ? (tx.settled_currency ?? '') : null;
    const settled_amount = square ? 0 : settled_currency && settled_currency !== tx.currency ? num(texts.settled_amount, settled_currency, `Settled ${settled_currency}`) : null;
    let splits: Split[] = [];
    let items: TxInput['items'] = null;
    if (isSplit && byItem) {
      items = itemRows.filter((r) => r.name.trim() || r.price.trim()).map((r, i) => {
        const name = r.name.trim() || `Item ${i + 1}`;
        return { name, amount: num(r.price, tx.currency, `${name} price`) ?? 0, people: r.people };
      });
      if (!items.length) errs.push('Add at least one item');
      else if (items.some((it) => it.amount <= 0 || !it.people.length)) errs.push('Each item needs a price and at least one person');
      else {
        const shares = splitByItems(amount, items);
        if (!shares) errs.push(`Items add up to ${formatAmount(items.reduce((s, it) => s + it.amount, 0), tx.currency)}, more than the total`);
        else splits = shares.map((s) => ({ ...s, input: null }));
      }
    } else if (isSplit && participants.length) {
      const method = tx.split_method ?? 'equal';
      if (method === 'equal') splits = allocate(amount, participants.map(() => 1)).map((a, i) => ({ person_id: participants[i]!, amount: a, input: null }));
      else if (method === 'amount') splits = participants.map((p) => ({ person_id: p, amount: num(splitInputs[p] ?? '', tx.currency, `${who(p)}'s share`) ?? 0, input: null }));
      else {
        const ws = participants.map((p) => Number((splitInputs[p] ?? '').trim() || (method === 'weight' ? '1' : '0')));
        if (ws.some((w) => !Number.isFinite(w) || w < 0)) errs.push(`${SPLIT_LABEL[method]} must be non-negative numbers`);
        else if (ws.every((w) => w === 0)) errs.push(`Enter at least one ${method === 'percent' ? 'percentage' : 'weight'}`);
        else {
          const total = ws.reduce((a, b) => a + b, 0);
          if (method === 'percent' && Math.abs(total - 100) > 0.005) errs.push(`Percentages add up to ${+total.toFixed(2)}%, expected 100%`);
          splits = allocate(amount, ws).map((a, i) => ({ person_id: participants[i]!, amount: a, input: ws[i]! }));
        }
      }
    }
    const out: TxInput = { ...tx, amount, from_amount, to_amount, fee_amount, settled_currency: settled_currency || null, settled_amount, splits, items, split_method: isSplit ? (byItem ? 'amount' : (tx.split_method ?? 'equal')) : null };
    return { tx: out, errs };
  }, [tx, texts, participants, splitInputs, crossSettle, fromAcct, toAcct, isMove, isSplit, who, byItem, itemRows]);
  const itemsSum = (built.tx.items ?? []).reduce((s, it) => s + it.amount, 0);

  const errors = [...built.errs, ...validateTx(built.tx, state)];
  const canPreview = built.errs.length === 0 && built.tx.amount > 0;
  const rate = (() => {
    const b = built.tx;
    const target = isMove ? toAcct : null;
    if (!target || target.currency === b.currency || !b.to_amount || !b.amount) return null;
    const from = b.amount / 10 ** decimalsOf(b.currency), to = b.to_amount / 10 ** decimalsOf(target.currency);
    return `1 ${b.currency} = ${(to / from).toPrecision(4)} ${target.currency} · 1 ${target.currency} = ${(from / to).toPrecision(4)} ${b.currency}`;
  })();

  const settleRemaining = (on: boolean) => {
    patch({ full_settlement: on ? 1 : 0 });
    if (!on) return;
    const cur = crossSettle && tx.settled_currency ? tx.settled_currency : tx.currency;
    const debt = outstanding.find((d) => d.from === tx.payer_id && d.currency === cur);
    if (debt) setText(crossSettle && tx.settled_currency ? 'settled_amount' : 'amount', toMajor(debt.amount, cur));
  };

  const save = async () => {
    setSaving(true);
    setServerError(null);
    const body = existing ? built.tx : { ...built.tx, repeat: repeatEvery || null };
    try {
      const saved = existing ? await api<Tx>('PUT', `/api/transactions/${existing.id}`, body) : await api<Tx>('POST', '/api/transactions', body);
      await reload();
      onSaved(saved);
    } catch (e) {
      // No connection: a new entry waits on this device and syncs later; edits still need the server.
      if (!existing && e instanceof ApiError && e.status === 0) {
        enqueue(body);
        onClose();
        return;
      }
      setServerError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const legAmount = (acct: Account | undefined, key: 'from_amount' | 'to_amount', label: string) =>
    acct && acct.currency !== tx.currency ? (
      <Field label={`${label} (${acct.currency})`} hint={`${acct.name} is in ${acct.currency}; enter what it was actually ${key === 'from_amount' ? 'charged' : 'credited'}`}>
        <input inputMode="decimal" value={texts[key]} onChange={(e) => setText(key, e.target.value)} data-testid={key} />
      </Field>
    ) : null;
  const accountSelect = (value: Id | null, onChange: (id: Id | null) => void, list: Account[], label: string, required = false, testId?: string) => (
    <Field label={label}>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} data-testid={testId}>
        {!required && <option value="">Not tracked</option>}
        {required && <option value="">Choose…</option>}
        {list.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} ({a.currency}{a.archived ? ', archived' : ''})
          </option>
        ))}
      </select>
    </Field>
  );
  const personSelect = (value: Id | null, onChange: (id: Id | null) => void, label: string, testId?: string) => (
    <Field label={label}>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} data-testid={testId}>
        <option value="">Choose…</option>
        {activePeople.map((p) => (
          <option key={p.id} value={p.id}>
            {p.is_me ? `${p.name} (you)` : p.name}
          </option>
        ))}
      </select>
    </Field>
  );
  // Same type, amount, currency and day as another entry: probably entered twice.
  const dupe = built.tx.amount > 0 ? state.transactions.find((t) => t.id !== existing?.id && t.type === built.tx.type && t.amount === built.tx.amount && t.currency === built.tx.currency && t.date === built.tx.date) : undefined;
  // One tap to log something you record often (a Grab ride, coffee) again: the latest few distinct ones of this type.
  const recent: Tx[] = [];
  if (!existing && !initial?.description && !tx.description && !texts.amount && tx.type !== 'refund') {
    const seen = new Set<string>();
    for (const t of state.transactions) {
      const key = t.description.trim().toLowerCase();
      if (t.type !== tx.type || !key || seen.has(key)) continue;
      seen.add(key);
      recent.push(t);
      if (recent.length === 4) break;
    }
  }
  const linkedOrig = tx.linked_tx_id != null ? state.transactions.find((t) => t.id === tx.linked_tx_id) : undefined;
  const refundable = state.transactions.filter((t) => t.type === 'expense' && (tx.trip_id == null || t.trip_id === tx.trip_id || t.id === tx.linked_tx_id));

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-label={existing ? 'Edit transaction' : 'Add transaction'}>
        <header className="modal-head">
          <h2>{existing ? `Edit ${TYPE_LABEL[tx.type].toLowerCase()}` : 'Add transaction'}</h2>
          <button className="ghost icon" onClick={onClose} aria-label="Close"><X /></button>
        </header>
        <div className="modal-body stack">
          {!existing && (
            <div className="type-picker" data-testid="type-picker">
              {TX_TYPES.map((t) => (
                <button key={t} type="button" className={t === tx.type ? 'on' : ''} onClick={() => setType(t)} data-testid={`type-${t}`}>
                  <TypeIcon type={t} small />
                  <span className="t">{TYPE_LABEL[t]}</span>
                  <span className="d">{TYPE_HELP[t]}</span>
                </button>
              ))}
            </div>
          )}
          {recent.length > 0 && (
            <div className="chips" data-testid="recent">
              <span className="faint small">Again:</span>
              {recent.map((t) => (
                <button type="button" key={t.id} className="chip" onClick={() => openForm({ initial: { ...againPrefill(t), ...(t.trip_id != null && trips.get(t.trip_id)?.closed ? { trip_id: null } : {}) } })} title={`${t.description} · ${formatAmount(t.amount, t.currency)}`} data-testid={`again-${t.id}`}>
                  <CategoryGlyph category={t.type === 'expense' ? t.category : 'Expenses'} />{t.description}
                </button>
              ))}
            </div>
          )}

          {tx.type === 'refund' && (
            <Field label="Original expense" hint="Link the refund so totals and shares are adjusted on the original">
              <select value={tx.linked_tx_id ?? ''} onChange={(e) => linkExpense(e.target.value ? Number(e.target.value) : null)} data-testid="linked-tx">
                <option value="">Not linked (standalone refund)</option>
                {refundable.map((t) => {
                  const left = t.amount - refundedTotal(state.transactions, t.id, existing?.id);
                  return (
                    <option key={t.id} value={t.id} disabled={left <= 0 && t.id !== tx.linked_tx_id}>
                      {t.date} · {t.description} · {formatAmount(t.amount, t.currency)}{left < t.amount ? ` (${formatAmount(left, t.currency)} left)` : ''}
                    </option>
                  );
                })}
              </select>
            </Field>
          )}

          <div className="form-grid">
            <Field label="Date">
              <input type="date" value={tx.date} onChange={(e) => patch({ date: e.target.value })} data-testid="date" />
            </Field>
            <Field label={isMove ? `Amount (${tx.currency || 'choose source'})` : 'Amount'}>
              <div className="inline-amount">
                <input inputMode="decimal" placeholder="0.00" value={texts.amount} onChange={(e) => setText('amount', e.target.value)} data-testid="amount" autoFocus />
                <input list="currencies" value={tx.currency} maxLength={3} disabled={isMove || !!linkedOrig} onChange={(e) => patch({ currency: e.target.value.toUpperCase() })} aria-label="Currency" data-testid="currency" />
              </div>
            </Field>
            <datalist id="currencies">{COMMON_CURRENCIES.map((c) => <option key={c} value={c} />)}</datalist>
            <Field label="Description" className={isMove ? '' : 'span-2'}>
              <input value={tx.description} placeholder={tx.type === 'expense' ? 'Dinner at Lau Pa Sat' : tx.type === 'withdrawal' ? 'ATM at Changi' : ''} onChange={(e) => patch({ description: e.target.value, ...(tx.type === 'expense' && !catPicked.current ? { category: guessCategory(e.target.value) } : {}) })} data-testid="description" />
            </Field>
            {tx.type !== 'income' && (
              <Field label="Trip" hint={tx.type === 'repayment' ? 'Tag it to count against that trip’s balance' : undefined}>
                <select value={tx.trip_id ?? ''} disabled={!!linkedOrig} onChange={(e) => setTrip(e.target.value ? Number(e.target.value) : null)} data-testid="trip">
                  <option value="">No trip (personal)</option>
                  {state.trips.filter((t) => (!t.archived && !t.closed) || t.id === tx.trip_id).map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </Field>
            )}
            {isSplit && (
              <Field label="Category" className="span-2">
                <div className="chips" role="radiogroup" aria-label="Category">
                  {CATEGORIES.map((c) => (
                    <button type="button" key={c} role="radio" aria-checked={categoryOf(tx) === c} className={`chip ${categoryOf(tx) === c ? 'on' : ''}`} onClick={() => { setOtherCat(''); pickCategory(c === 'Expenses' ? null : c); }} data-testid={`category-chip-${c}`}><CategoryGlyph category={c} />{c}</button>
                  ))}
                  <input className="chip-input" value={otherCat} placeholder="Other…" maxLength={40} onChange={(e) => typeCategory(e.target.value)} aria-label="Other category" data-testid="category" />
                </div>
              </Field>
            )}
            {tx.type === 'income' && (
              <Field label="Category">
                <input value={tx.category ?? ''} placeholder="Salary, gift…" onChange={(e) => patch({ category: e.target.value || null })} data-testid="category" />
              </Field>
            )}
          </div>

          {tx.type === 'expense' && (
            <div className="form-grid">
              {personSelect(tx.payer_id, (id) => patch({ payer_id: id, from_account_id: null }), 'Paid by', 'payer')}
              {accountSelect(tx.from_account_id, (id) => patch({ from_account_id: id }), accountsOf(tx.payer_id, false, tx.from_account_id), 'Paid from', false, 'from-account')}
              {legAmount(fromAcct, 'from_amount', 'Charged to account')}
            </div>
          )}
          {tx.type === 'refund' && (
            <div className="form-grid">
              {linkedOrig ? (
                <Field label="Refunded to"><input value={`${who(linkedOrig.payer_id)} (paid the original)`} disabled /></Field>
              ) : (
                personSelect(tx.payer_id, (id) => patch({ payer_id: id, to_account_id: null }), 'Refunded to', 'payer')
              )}
              {accountSelect(tx.to_account_id, (id) => patch({ to_account_id: id }), accountsOf(tx.payer_id, false, tx.to_account_id), 'Into account', false, 'to-account')}
              {legAmount(toAcct, 'to_amount', 'Credited to account')}
            </div>
          )}
          {isMove && (
            <div className="form-grid">
              {accountSelect(tx.from_account_id, (id) => patch({ from_account_id: id, currency: id != null ? (accounts.get(id)?.currency ?? tx.currency) : tx.currency }), accountsOf(me.id, false, tx.from_account_id), 'From account', true, 'from-account')}
              {accountSelect(tx.to_account_id, (id) => patch({ to_account_id: id }), accountsOf(me.id, tx.type === 'withdrawal', tx.to_account_id).filter((a) => a.id !== tx.from_account_id), tx.type === 'withdrawal' ? 'Cash holding' : 'To account', true, 'to-account')}
              {legAmount(toAcct, 'to_amount', tx.type === 'withdrawal' ? 'Cash received' : 'Amount received')}
              <Field label={`Fee (${tx.currency || '…'})`} hint="ATM or conversion fee charged to the source; kept separate from spending">
                <input inputMode="decimal" placeholder="0.00" value={texts.fee_amount} onChange={(e) => setText('fee_amount', e.target.value)} data-testid="fee" />
              </Field>
              <Field label="Reference">
                <input value={tx.reference ?? ''} placeholder="ATM / transfer reference" onChange={(e) => patch({ reference: e.target.value || null })} />
              </Field>
              {rate && <div className="hint span-2">Effective rate: {rate}</div>}
              {tx.type === 'withdrawal' && accountsOf(me.id, true).length === 0 && <div className="warn-box span-2">You have no cash holdings yet. Add one under Accounts & Cash (e.g. “SGD cash”).</div>}
            </div>
          )}
          {tx.type === 'repayment' && (
            <div className="stack">
              <div className="form-grid">
                {personSelect(tx.payer_id, (id) => patch({ payer_id: id, from_account_id: null, full_settlement: 0 }), 'Paid by', 'payer')}
                {personSelect(tx.payee_id, (id) => patch({ payee_id: id, to_account_id: null, full_settlement: 0 }), 'Paid to', 'payee')}
                {accountsOf(tx.payer_id).length > 0 && accountSelect(tx.from_account_id, (id) => patch({ from_account_id: id }), accountsOf(tx.payer_id, false, tx.from_account_id), `${who(tx.payer_id)} paid from`, false, 'from-account')}
                {legAmount(fromAcct, 'from_amount', 'Debited')}
                {accountsOf(tx.payee_id).length > 0 && accountSelect(tx.to_account_id, (id) => patch({ to_account_id: id }), accountsOf(tx.payee_id, false, tx.to_account_id), `${who(tx.payee_id)} received into`, false, 'to-account')}
                {legAmount(toAcct, 'to_amount', 'Credited')}
                <Field label="Payment method">
                  <input list="methods" value={tx.method ?? ''} onChange={(e) => patch({ method: e.target.value || null })} data-testid="method" />
                  <datalist id="methods">{METHODS.map((m) => <option key={m} value={m} />)}</datalist>
                </Field>
                <Field label="Reference">
                  <input value={tx.reference ?? ''} placeholder="UPI ref, note…" onChange={(e) => patch({ reference: e.target.value || null })} />
                </Field>
              </div>
              {tx.payer_id != null && tx.payee_id != null && (
                <div className="effects">
                  <strong>Outstanding {tx.trip_id != null ? `in ${trips.get(tx.trip_id)?.name}` : 'overall'}</strong>
                  <ul>
                    {outstanding.length === 0 && <li>Nothing outstanding between {who(tx.payer_id)} and {who(tx.payee_id)}</li>}
                    {outstanding.map((d) => (
                      <li key={d.currency}>{who(d.from)} {d.from === me.id ? 'owe' : 'owes'} {who(d.to)} <Money amount={d.amount} currency={d.currency} /></li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="row">
                <label className="check">
                  <input type="checkbox" checked={crossSettle} onChange={(e) => { setCrossSettle(e.target.checked); patch({ settled_currency: e.target.checked ? (outstanding[0]?.currency ?? '') : null, full_settlement: 0 }); }} data-testid="cross-settle" />
                  Settles a debt in a different currency
                </label>
                <label className="check">
                  <input type="checkbox" checked={tx.full_settlement === 1} onChange={(e) => settleRemaining(e.target.checked)} data-testid="full-settlement" />
                  Settles the remaining balance
                </label>
              </div>
              {crossSettle && (
                <div className="form-grid">
                  <Field label="Debt currency">
                    <input list="currencies" value={tx.settled_currency ?? ''} maxLength={3} onChange={(e) => patch({ settled_currency: e.target.value.toUpperCase() })} data-testid="settled-currency" />
                  </Field>
                  <Field label={`Debt settled (${tx.settled_currency || '…'})`} hint={`${formatAmount(built.tx.amount, tx.currency)} paid clears this much of the ${tx.settled_currency || ''} balance`}>
                    <input inputMode="decimal" value={texts.settled_amount} onChange={(e) => setText('settled_amount', e.target.value)} data-testid="settled-amount" />
                  </Field>
                </div>
              )}
            </div>
          )}
          {tx.type === 'income' && (
            <div className="form-grid">
              {personSelect(tx.payer_id, (id) => patch({ payer_id: id, to_account_id: null }), 'Received by', 'payer')}
              {accountSelect(tx.to_account_id, (id) => patch({ to_account_id: id }), accountsOf(tx.payer_id, false, tx.to_account_id), 'Into account', false, 'to-account')}
              {legAmount(toAcct, 'to_amount', 'Credited to account')}
            </div>
          )}

          {isSplit && (
            <div className="stack" data-testid="split-editor">
              <div className="row between">
                <strong>{tx.type === 'expense' ? 'Shared between' : 'Refund credited to'}</strong>
                <div className="row">
                  {(Object.keys(SPLIT_LABEL) as SplitMethod[]).map((m) => (
                    <label key={m} className="check small">
                      <input type="radio" name="split-method" checked={!byItem && (tx.split_method ?? 'equal') === m} onChange={() => { setByItem(false); patch({ split_method: m }); }} data-testid={`split-${m}`} />
                      {SPLIT_LABEL[m]}
                    </label>
                  ))}
                  {tx.type === 'expense' && (
                    <label className="check small">
                      <input type="radio" name="split-method" checked={byItem} onChange={() => { setByItem(true); setItemRows((rows) => (rows.length === 1 && !rows[0]!.name && !rows[0]!.price ? [{ name: '', price: '', people: participants }] : rows)); }} data-testid="split-items" />
                      By item
                    </label>
                  )}
                </div>
              </div>
              {byItem && (
                <div className="stack tight" data-testid="items-editor">
                  {itemRows.map((r, i) => (
                    <div key={i} className="item-row">
                      <div className="row">
                        <input className="item-name" value={r.name} placeholder={`Item ${i + 1}`} maxLength={60} onChange={(e) => setItem(i, { name: e.target.value })} aria-label="Item" data-testid={`item-name-${i}`} />
                        <input className="item-price" inputMode="decimal" value={r.price} placeholder="0.00" onChange={(e) => setItem(i, { price: e.target.value })} aria-label="Price" data-testid={`item-price-${i}`} />
                        <button type="button" className="ghost icon small" aria-label="Remove item" disabled={itemRows.length === 1} onClick={() => setItemRows((rows) => rows.filter((_, j) => j !== i))}><X /></button>
                      </div>
                      <div className="chips">
                        {activePeople.map((p) => (
                          <button type="button" key={p.id} className={`chip ${r.people.includes(p.id) ? 'on' : ''}`} onClick={() => setItem(i, { people: r.people.includes(p.id) ? r.people.filter((x) => x !== p.id) : [...r.people, p.id] })} data-testid={`item-${i}-person-${p.id}`}>{p.is_me ? 'You' : p.name}</button>
                        ))}
                      </div>
                    </div>
                  ))}
                  <div className="row between">
                    <button type="button" className="small" onClick={() => setItemRows((rows) => [...rows, { name: '', price: '', people: participants }])} data-testid="add-item"><Plus />Add item</button>
                    {built.tx.amount > 0 && itemsSum > 0 && itemsSum <= built.tx.amount && <span className="faint small">Items {formatAmount(itemsSum, tx.currency)} · tax, service & tip {formatAmount(built.tx.amount - itemsSum, tx.currency)} shared by what each had</span>}
                  </div>
                  {built.tx.splits.length > 0 && (
                    <div className="table-wrap panel">
                      <table>
                        <thead><tr><th>Person</th><th className="num">Share</th></tr></thead>
                        <tbody>{built.tx.splits.map((s) => <tr key={s.person_id}><td>{who(s.person_id)}</td><td className="num"><Money amount={s.amount} currency={tx.currency} /></td></tr>)}</tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
              {!byItem && <div className="chips">
                {activePeople.map((p) => (
                  <button type="button" key={p.id} className={`chip ${participants.includes(p.id) ? 'on' : ''}`} onClick={() => toggleParticipant(p.id)} data-testid={`participant-${p.id}`}>
                    {p.is_me ? 'You' : p.name}
                  </button>
                ))}
                {tx.trip_id != null && (
                  <button type="button" className="link small" onClick={() => setParticipants(trips.get(tx.trip_id!)?.members ?? participants)}>
                    everyone on the trip
                  </button>
                )}
              </div>}
              {!byItem && participants.length > 0 && (
                <div className="table-wrap panel">
                  <table>
                    <thead>
                      <tr>
                        <th>Person</th>
                        {tx.split_method && tx.split_method !== 'equal' && <th>{tx.split_method === 'amount' ? `Amount (${tx.currency})` : tx.split_method === 'percent' ? '%' : 'Weight'}</th>}
                        <th className="num">Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {participants.map((p) => (
                        <tr key={p}>
                          <td>{who(p)}{p === tx.payer_id ? <span className="muted small"> · {tx.type === 'expense' ? 'paid' : 'receives'}</span> : ''}</td>
                          {tx.split_method && tx.split_method !== 'equal' && (
                            <td>
                              <input inputMode="decimal" value={splitInputs[p] ?? ''} placeholder={tx.split_method === 'weight' ? '1' : ''} onChange={(e) => setSplitInputs((s) => ({ ...s, [p]: e.target.value }))} data-testid={`split-input-${p}`} />
                            </td>
                          )}
                          <td className="num"><Money amount={built.tx.splits.find((s) => s.person_id === p)?.amount ?? 0} currency={tx.currency} /></td>
                        </tr>
                      ))}
                    </tbody>
                    {tx.split_method === 'amount' && (
                      <tfoot>
                        <tr>
                          <td colSpan={2}>Remaining to allocate</td>
                          <td className="num"><Money amount={built.tx.amount - built.tx.splits.reduce((s, x) => s + x.amount, 0)} currency={tx.currency} /></td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}
            </div>
          )}

          <details open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
            <summary>Notes & more</summary>
            <div className="form-grid" style={{ marginTop: 'var(--space-2)' }}>
              <Field label="Notes" className="span-2">
                <textarea value={tx.notes ?? ''} onChange={(e) => patch({ notes: e.target.value || null })} />
              </Field>
              {!isMove && tx.type !== 'repayment' && (
                <Field label="Reference">
                  <input value={tx.reference ?? ''} onChange={(e) => patch({ reference: e.target.value || null })} />
                </Field>
              )}
              {!existing && tx.type !== 'refund' && (
                <Field label="Repeat" hint={repeatEvery ? 'A copy is added on each date automatically; stop it any time' : undefined}>
                  <select value={repeatEvery} onChange={(e) => setRepeatEvery(e.target.value as typeof repeatEvery)} data-testid="repeat">
                    <option value="">Doesn’t repeat</option>
                    <option value="weekly">Every week</option>
                    <option value="monthly">Every month, same day</option>
                  </select>
                </Field>
              )}
            </div>
          </details>

          {canPreview && errors.length === 0 && <EffectsView tx={built.tx} />}
          {dupe && (
            <div className="warn-box" data-testid="dupe-warning">Same amount on the same day as “{dupe.description || TYPE_LABEL[dupe.type]}”. Save only if it’s a separate charge.</div>
          )}
          {errors.length > 0 && texts.amount !== '' && (
            <div className="warn-box" data-testid="form-errors">
              <ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul>
            </div>
          )}
          <ErrorBox error={serverError} />
          <div className="row between">
            <span className="faint small mono">{existing ? `#${existing.id}` : ''}</span>
            <div className="row">
              <button type="button" onClick={onClose}>Cancel</button>
              <button type="button" className="primary" disabled={saving || errors.length > 0} onClick={() => void save()} data-testid="save-tx">
                {saving ? 'Saving…' : existing ? 'Save changes' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
