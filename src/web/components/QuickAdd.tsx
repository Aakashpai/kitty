import { useEffect, useState } from 'react';
import { Banknote, CreditCard, MapPin, X } from 'lucide-react';
import { allocate, currencySymbol, emptyTx, formatAmount, parseAmount, type Id, type Trip, type TxInput } from '../../engine/index.ts';
import { ApiError, api, enqueue, errorText } from '../api.ts';
import { CATEGORIES, guessCategory, useLedger } from '../store.tsx';
import { CategoryGlyph, ErrorBox, Modal } from './ui.tsx';

/** The phone's own date (not UTC), so a late dinner in Singapore lands on the right day. */
export const localToday = () => new Date().toLocaleDateString('en-CA');

/** The trip you are on today: open, you are a member, and its dates cover today. */
export const liveTrip = (trips: Trip[], me: number, day = localToday()) =>
  trips.find((t) => !t.closed && !t.archived && t.start_date && t.end_date && t.start_date <= day && day <= t.end_date && t.members.includes(me));

type Place = { name: string; kind: string };

/** Where you are, as a shop or area name from OpenStreetMap; null when location is off, slow or unknown. */
async function placeHere(): Promise<Place | null> {
  const pos = await new Promise<GeolocationPosition | null>((done) => {
    if (!navigator.geolocation) return done(null);
    navigator.geolocation.getCurrentPosition(done, () => done(null), { enableHighAccuracy: true, timeout: 10_000, maximumAge: 120_000 });
  });
  if (!pos) return null;
  try {
    const { latitude, longitude } = pos.coords;
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=en&lat=${latitude}&lon=${longitude}`);
    const d = res.ok ? ((await res.json()) as { name?: string; category?: string; type?: string; address?: Record<string, string> }) : null;
    // A shop, restaurant or sight by name; a road or boundary only says which area you are in.
    const poi = d?.name && !['highway', 'place', 'boundary'].includes(d.category ?? '') ? d.name : null;
    const a = d?.address ?? {};
    const name = poi ?? a.suburb ?? a.neighbourhood ?? a.quarter ?? a.city_district ?? a.city ?? a.town ?? a.village;
    return name ? { name: name.slice(0, 80), kind: poi ? (d?.type ?? '').replace(/_/g, ' ') : '' } : null;
  } catch {
    return null;
  }
}

/**
 * One-screen add for the trip you are on: the amount and a few taps (category, who it was for, cash or card). Everything
 * else is filled in: today, you paid, the trip's currency, split equally, the place from your location as the name.
 */
export function QuickAdd({ trip, onClose, onMore }: { trip: Trip; onClose: () => void; onMore: (initial: Partial<TxInput>) => void }) {
  const { state, me, who, reload } = useLedger();
  const cash = state.accounts.find((a) => a.person_id === me.id && a.type === 'cash' && !a.archived && a.currency === trip.currency);
  const [amount, setAmount] = useState('');
  const [what, setWhat] = useState('');
  const [picked, setPicked] = useState<string | null>(null); // null: follow the guess from "what for" or the place
  const [people, setPeople] = useState<Id[]>(trip.members);
  const [byCash, setByCash] = useState(!!cash);
  const [place, setPlace] = useState<Place | null | undefined>(undefined); // undefined: still looking
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    void placeHere().then((p) => live && setPlace(p));
    return () => { live = false; };
  }, []);
  const minor = parseAmount(amount, trip.currency) ?? 0;
  const category = picked ?? guessCategory(what) ?? (place ? guessCategory(`${place.name} ${place.kind}`) : null);
  const recent = [...new Set(state.transactions.filter((t) => t.type === 'expense' && t.trip_id === trip.id).map((t) => t.description))].slice(0, 20);
  const toggle = (id: Id) => setPeople((p) => (p.includes(id) ? (p.length > 1 ? p.filter((x) => x !== id) : p) : trip.members.filter((m) => m === id || p.includes(m))));

  const build = (): TxInput => {
    const shares = allocate(minor, people.map(() => 1));
    const typed = what.trim();
    return {
      ...emptyTx('expense', localToday(), trip.currency), description: typed || place?.name || (category && category !== 'Expenses' ? category : 'Expense'),
      notes: typed && place ? `At ${place.name}` : null, category: category === 'Expenses' ? null : category, trip_id: trip.id,
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
      <form className="stack quick-add" onSubmit={(e) => { e.preventDefault(); if (minor > 0) void save(); }} data-testid="quick-add">
        <label className="quick-amount">
          <span>{currencySymbol(trip.currency)}</span>
          <input inputMode="decimal" autoFocus placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount" data-testid="quick-amount" />
        </label>
        {place !== null && (
          <div className="row quick-place" data-testid="quick-place">
            <MapPin />
            {place ? <><span>{place.name}</span><button type="button" className="ghost icon small" aria-label="Don't use this place" onClick={() => setPlace(null)}><X /></button><span className="hint">© OpenStreetMap</span></> : <span className="hint">Finding where you are…</span>}
          </div>
        )}
        <div className="chips" role="radiogroup" aria-label="Category">
          {CATEGORIES.map((c) => (
            <button type="button" key={c} role="radio" aria-checked={(category ?? 'Expenses') === c} className={`chip ${(category ?? 'Expenses') === c ? 'on' : ''}`} onClick={() => setPicked(c)}><CategoryGlyph category={c} />{c}</button>
          ))}
        </div>
        <input value={what} placeholder="What for? (optional)" list="quick-recent" maxLength={200} onChange={(e) => setWhat(e.target.value)} aria-label="What for" data-testid="quick-what" />
        <datalist id="quick-recent">{recent.map((d) => <option key={d} value={d} />)}</datalist>
        <div className="stack tight">
          <div className="row between">
            <span className="hint">For</span>
            <span className="row">
              <button type="button" className="link small" onClick={() => setPeople(trip.members)} data-testid="quick-everyone">Everyone</button>
              <button type="button" className="link small" onClick={() => setPeople([me.id])} data-testid="quick-mine">Just me</button>
            </span>
          </div>
          <div className="chips" aria-label="Shared with">
            {trip.members.map((m) => (
              <button type="button" key={m} aria-pressed={people.includes(m)} className={`chip ${people.includes(m) ? 'on' : ''}`} onClick={() => toggle(m)} data-testid={`quick-for-${m}`}>{who(m).split(' ')[0]}</button>
            ))}
          </div>
        </div>
        {cash && (
          <div className="seg" role="radiogroup" aria-label="Paid with">
            <button type="button" className={byCash ? 'on' : ''} onClick={() => setByCash(true)} data-testid="quick-cash"><Banknote />{cash.name}</button>
            <button type="button" className={byCash ? '' : 'on'} onClick={() => setByCash(false)} data-testid="quick-card"><CreditCard />Card / UPI</button>
          </div>
        )}
        <ErrorBox error={err} />
        <div className="row between">
          <button type="button" className="link small" onClick={() => onMore(build())} data-testid="quick-more">More options</button>
          <button type="submit" className="primary" disabled={saving || minor <= 0} data-testid="quick-save">{saving ? 'Saving…' : `Save${minor > 0 ? ` ${formatAmount(minor, trip.currency)}` : ''}`}</button>
        </div>
      </form>
    </Modal>
  );
}
