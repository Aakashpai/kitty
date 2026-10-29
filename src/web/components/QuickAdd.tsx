import { useState } from 'react';
import { Banknote, CreditCard } from 'lucide-react';
import { allocate, currencySymbol, emptyTx, formatAmount, parseAmount, type Trip, type TxInput } from '../../engine/index.ts';
import { ApiError, api, enqueue, errorText } from '../api.ts';
import { CATEGORIES, guessCategory, useLedger } from '../store.tsx';
import { CategoryGlyph, ErrorBox, Modal } from './ui.tsx';

/** The phone's own date (not UTC), so a late dinner in Singapore lands on the right day. */
export const localToday = () => new Date().toLocaleDateString('en-CA');

/** The trip you are on today: open, you are a member, and its dates cover today. */
export const liveTrip = (trips: Trip[], me: number, day = localToday()) =>
  trips.find((t) => !t.closed && !t.archived && t.start_date && t.end_date && t.start_date <= day && day <= t.end_date && t.members.includes(me));

/**
 * One-screen add for the trip you are on: amount, what for, and two taps (who shares it, cash or card). Everything else
 * is filled in: today, you paid, the trip's currency, split equally, category guessed, your cash wallet when paid in cash.
 */
export function QuickAdd({ trip, onClose, onMore }: { trip: Trip; onClose: () => void; onMore: (initial: Partial<TxInput>) => void }) {
  const { state, me, reload } = useLedger();
  const cash = state.accounts.find((a) => a.person_id === me.id && a.type === 'cash' && !a.archived && a.currency === trip.currency);
  const [amount, setAmount] = useState('');
  const [what, setWhat] = useState('');
  const [picked, setPicked] = useState<string | null>(null); // null: follow the guess from "what for"
  const [everyone, setEveryone] = useState(true);
  const [byCash, setByCash] = useState(!!cash);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const minor = parseAmount(amount, trip.currency) ?? 0;
  const category = picked ?? guessCategory(what);
  const people = everyone ? trip.members : [me.id];
  const recent = [...new Set(state.transactions.filter((t) => t.type === 'expense' && t.trip_id === trip.id).map((t) => t.description))].slice(0, 20);

  const build = (): TxInput => {
    const shares = allocate(minor, people.map(() => 1));
    return {
      ...emptyTx('expense', localToday(), trip.currency), description: what.trim(), category: category === 'Expenses' ? null : category, trip_id: trip.id,
      amount: minor, payer_id: me.id, from_account_id: byCash && cash ? cash.id : null, split_method: 'equal',
      splits: people.map((p, i) => ({ person_id: p, amount: shares[i] ?? 0, input: null })),
    };
  };
  const save = async () => {
    const tx = build();
    setSaving(true);
    try {
      await api('POST', '/api/transactions', tx);
      await reload();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) { enqueue(tx); onClose(); return; } // offline: keep it on the phone
      setErr(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`Quick add · ${trip.name}`} onClose={onClose}>
      <form className="stack quick-add" onSubmit={(e) => { e.preventDefault(); if (minor > 0 && what.trim()) void save(); }} data-testid="quick-add">
        <label className="quick-amount">
          <span>{currencySymbol(trip.currency)}</span>
          <input inputMode="decimal" autoFocus placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount" data-testid="quick-amount" />
        </label>
        <input value={what} placeholder="What for? Lunch, Grab, tickets…" list="quick-recent" maxLength={200} onChange={(e) => setWhat(e.target.value)} aria-label="What for" data-testid="quick-what" />
        <datalist id="quick-recent">{recent.map((d) => <option key={d} value={d} />)}</datalist>
        <div className="chips" role="radiogroup" aria-label="Category">
          {CATEGORIES.map((c) => (
            <button type="button" key={c} role="radio" aria-checked={(category ?? 'Expenses') === c} className={`chip ${(category ?? 'Expenses') === c ? 'on' : ''}`} onClick={() => setPicked(c)}><CategoryGlyph category={c} />{c}</button>
          ))}
        </div>
        <div className="row between">
          <div className="seg" role="radiogroup" aria-label="Shared with">
            <button type="button" className={everyone ? 'on' : ''} onClick={() => setEveryone(true)} data-testid="quick-everyone">Everyone ({trip.members.length})</button>
            <button type="button" className={everyone ? '' : 'on'} onClick={() => setEveryone(false)} data-testid="quick-mine">Just me</button>
          </div>
          {cash && (
            <div className="seg" role="radiogroup" aria-label="Paid with">
              <button type="button" className={byCash ? 'on' : ''} onClick={() => setByCash(true)} data-testid="quick-cash"><Banknote />{cash.name}</button>
              <button type="button" className={byCash ? '' : 'on'} onClick={() => setByCash(false)} data-testid="quick-card"><CreditCard />Card / UPI</button>
            </div>
          )}
        </div>
        <ErrorBox error={err} />
        <div className="row between">
          <button type="button" className="link small" onClick={() => onMore(build())} data-testid="quick-more">More options</button>
          <button type="submit" className="primary" disabled={saving || minor <= 0 || !what.trim()} data-testid="quick-save">{saving ? 'Saving…' : `Save${minor > 0 ? ` ${formatAmount(minor, trip.currency)}` : ''}`}</button>
        </div>
      </form>
    </Modal>
  );
}
