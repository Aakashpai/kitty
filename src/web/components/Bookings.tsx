import { useState, type FormEvent } from 'react';
import { BedDouble, Bookmark, CarTaxiFront, Clock, Copy, ImagePlus, Map, MapPin, Pencil, Phone, Plane, Plus, Siren, Ticket, Trash2, X, type LucideIcon } from 'lucide-react';
import { BOOKING_TYPES, type BookingType, type PlanItem, type Trip } from '../../engine/index.ts';
import { api, errorText } from '../api.ts';
import { copyText, useLedger } from '../store.tsx';
import { DangerButton, Empty, ErrorBox, Spinner, useBusy } from './ui.tsx';
import { shrink } from './TxDetail.tsx';

const TYPES: Record<BookingType, { label: string; icon: LucideIcon; name: string; ref: string; place: string; notes: string }> = {
  flight: { label: 'Flight', icon: Plane, name: 'IndiGo 6E 1043 · Mumbai → Kuala Lumpur', ref: 'PNR', place: 'Airport and terminal', notes: 'Seat, baggage, gate closes at…' },
  stay: { label: 'Hotel', icon: BedDouble, name: 'Hotel name', ref: 'Booking number', place: 'Address', notes: 'Check-in 2 pm, breakfast included…' },
  ticket: { label: 'Ticket', icon: Ticket, name: 'Universal Studios', ref: 'Booking number', place: 'Address', notes: 'Entry from 10 am, bring ID…' },
  ride: { label: 'Transfer', icon: CarTaxiFront, name: 'Airport pickup', ref: 'Booking number', place: 'Pickup point', notes: 'Driver waits at gate 3…' },
  emergency: { label: 'Emergency', icon: Siren, name: 'Emergency numbers', ref: 'Insurance policy number', place: 'Embassy address', notes: 'Police 999 · Ambulance 995 · Embassy +65…' },
  other: { label: 'Other', icon: Bookmark, name: 'Name', ref: 'Reference', place: 'Address', notes: 'Anything worth knowing' },
};

const nowLocal = () => { const d = new Date(); return `${d.toLocaleDateString('en-CA')}T${d.toTimeString().slice(0, 5)}`; };
const fmtDay = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
/** "in 3h 20m", "tomorrow", "in 4 days": how far off a booking is. */
const fromNow = (it: PlanItem) => {
  const days = Math.round((new Date(it.day + 'T00:00:00').getTime() - new Date(new Date().toLocaleDateString('en-CA') + 'T00:00:00').getTime()) / 864e5);
  if (!it.meta?.time || days > 0) return days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  const mins = Math.max(0, Math.round((new Date(`${it.day}T${it.meta.time}`).getTime() - Date.now()) / 60000));
  return mins < 60 ? `in ${mins} min` : `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
};

/**
 * A trip's bookings on one screen: flights, hotels, tickets, transfers and an emergency card, by day, with the next
 * one called out. Members add and edit; share links (family links too) only look. Works offline once seen: the ledger
 * copy on the phone carries the cards, and the service worker keeps the photos and share-link pages.
 */
export function Bookings({ trip, shareToken, onRefresh }: { trip: Trip; shareToken?: string; onRefresh?: () => Promise<void> }) {
  const { state, readOnly, reload } = useLedger();
  const items = (state.plan ?? []).filter((p) => p.trip_id === trip.id && p.kind === 'booking');
  const canEdit = !readOnly;
  const [editing, setEditing] = useState<PlanItem | 'new' | null>(null);
  const [full, setFull] = useState<{ img?: string; text?: string; sub?: string | null } | null>(null);
  const refresh = async () => { if (onRefresh) await onRefresh(); else await reload(); };
  const src = (it: PlanItem) => (it.image_id ? (shareToken ? `/api/shared/${shareToken}/plan-images/${it.image_id}` : `/api/plan-images/${it.image_id}`) : null);
  const emergency = items.filter((i) => i.meta?.type === 'emergency');
  const timeline = items.filter((i) => i.meta?.type !== 'emergency').sort((a, b) => (a.day ?? '9999').localeCompare(b.day ?? '9999') || (a.meta?.time ?? '').localeCompare(b.meta?.time ?? '') || a.id - b.id);
  const now = nowLocal();
  const next = timeline.find((i) => i.day && `${i.day}T${i.meta?.time ?? '23:59'}` >= now);
  const days = [...new Set(timeline.map((i) => i.day ?? ''))];
  const iPhone = /iPhone|iPad/.test(navigator.userAgent) && !(matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone);

  const Card = ({ it }: { it: PlanItem }) => {
    const m = it.meta ?? {};
    const T = TYPES[m.type ?? 'other'] ?? TYPES.other;
    const img = src(it);
    return (
      <div className={`panel pad booking stack tight${next?.id === it.id ? ' next' : ''}`} id={`booking-${it.id}`} data-testid={`booking-${it.id}`}>
        <div className="booking-top">
          <span className="ticon"><T.icon /></span>
          <strong className="grow">{it.title}</strong>
          {m.time && <span className="booking-time"><Clock />{m.time}</span>}
        </div>
        {m.ref && (
          <div className="booking-line">
            <span className="faint small">{T.ref}</span>
            <span className="booking-ref">{m.ref}</span>
            <button className="small ghost" onClick={() => void copyText(m.ref!)} aria-label={`Copy ${T.ref}`}><Copy /></button>
          </div>
        )}
        {m.place && (
          <div className="stack tight">
            <span className="small"><MapPin className="inline-icon" /> {m.place}</span>
            {m.local && <span className="small muted">{m.local}</span>}
            <span className="row">
              <button className="small" onClick={() => setFull({ text: m.local || m.place!, sub: m.local ? m.place : null })} data-testid={`driver-${it.id}`}>Show driver</button>
              <a className="btn small" href={`https://maps.google.com/?q=${encodeURIComponent(m.place)}`} target="_blank" rel="noreferrer"><Map />Map</a>
            </span>
          </div>
        )}
        {m.phone && <a className="small" href={`tel:${m.phone.replace(/[^\d+]/g, '')}`}><Phone className="inline-icon" /> {m.phone}</a>}
        {it.body && <p className="small muted booking-notes">{it.body}</p>}
        {img && <button className="booking-img" onClick={() => setFull({ img })} aria-label="Show the ticket full screen"><img src={img} alt={`${it.title}: ticket`} /></button>}
        {canEdit && (
          <div className="row end">
            <button className="small ghost" onClick={() => setEditing(it)} data-testid={`edit-booking-${it.id}`}><Pencil />Edit</button>
            <DangerButton confirm={`Remove "${it.title}"?`} onConfirm={async () => { await api('DELETE', `/api/plan/${it.id}`); await refresh(); }}><Trash2 /></DangerButton>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="stack" data-testid="bookings">
      {next && (
        <a className="info-box booking-next" href={`#booking-${next.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(`booking-${next.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }}>
          <strong>Next up · {fromNow(next)}</strong><span className="small">{next.title}{next.meta?.time ? ` · ${next.meta.time}` : ''}</span>
        </a>
      )}
      {canEdit && editing === 'new' && <BookingForm trip={trip} onDone={async () => { await refresh(); setEditing(null); }} onCancel={() => setEditing(null)} />}
      {canEdit && editing !== 'new' && <div className="row end"><button className="primary" onClick={() => setEditing('new')} data-testid="add-booking"><Plus />Add booking</button></div>}
      {items.length === 0 && editing !== 'new' && <Empty title="No bookings yet">{canEdit ? 'Add flights, hotels, tickets and transfers. Everyone on the trip sees them, even with no internet.' : 'Nothing booked here yet.'}</Empty>}
      {days.map((d) => (
        <section key={d} className="stack tight">
          <h3 className="booking-day">{d ? fmtDay(d) : 'Any day'}</h3>
          {timeline.filter((i) => (i.day ?? '') === d).map((it) => (editing !== 'new' && editing?.id === it.id ? <BookingForm key={it.id} trip={trip} it={it} onDone={async () => { await refresh(); setEditing(null); }} onCancel={() => setEditing(null)} /> : <Card key={it.id} it={it} />))}
        </section>
      ))}
      {emergency.length > 0 && (
        <section className="stack tight">
          <h3 className="booking-day">In an emergency</h3>
          {emergency.map((it) => (editing !== 'new' && editing?.id === it.id ? <BookingForm key={it.id} trip={trip} it={it} onDone={async () => { await refresh(); setEditing(null); }} onCancel={() => setEditing(null)} /> : <Card key={it.id} it={it} />))}
        </section>
      )}
      {items.length > 0 && (
        <p className="faint small" style={{ margin: 0 }}>
          {state.as_of ? `Saved on this phone ${new Date(state.as_of).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. ` : ''}
          Opens without internet once you have seen it here.{iPhone ? ' On iPhone, add this page to the Home Screen (Share → Add to Home Screen) so it stays saved.' : ''}
        </p>
      )}
      {full && (
        <div className={`fullscreen${full.img ? ' scan' : ''}`} role="dialog" aria-modal="true" aria-label={full.img ? 'Ticket' : 'Address for the driver'} onClick={() => setFull(null)} data-testid="fullscreen">
          {full.img ? <img src={full.img} alt="Ticket" /> : <div className="driver"><p className="big">{full.text}</p>{full.sub && <p>{full.sub}</p>}</div>}
          <button className="ghost icon close" aria-label="Close"><X /></button>
        </div>
      )}
    </div>
  );
}

function BookingForm({ trip, it, onDone, onCancel }: { trip: Trip; it?: PlanItem; onDone: () => Promise<void>; onCancel: () => void }) {
  const m = it?.meta ?? {};
  const [f, setF] = useState({ type: m.type ?? 'flight', title: it?.title ?? '', day: it?.day ?? trip.start_date ?? '', time: m.time ?? '', ref: m.ref ?? '', place: m.place ?? '', local: m.local ?? '', phone: m.phone ?? '', notes: it?.body ?? '' });
  const [file, setFile] = useState<File | null>(null);
  const [dropImg, setDropImg] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, run] = useBusy();
  const T = TYPES[f.type];
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      try {
        const trim = (s: string) => s.trim() || null;
        const body = { title: f.title.trim(), day: f.type === 'emergency' ? null : f.day || null, body: trim(f.notes), meta: { type: f.type, time: f.type === 'emergency' ? null : f.time || null, ref: trim(f.ref), place: trim(f.place), local: trim(f.local), phone: trim(f.phone) } };
        const id = it ? (await api('PUT', `/api/plan/${it.id}`, body), it.id) : (await api<PlanItem>('POST', `/api/trips/${trip.id}/plan`, { kind: 'booking', ...body })).id;
        if (file) await api('POST', `/api/plan/${id}/image`, { data: await shrink(file) });
        else if (dropImg && it?.image_id) await api('DELETE', `/api/plan/${id}/image`);
        await onDone();
      } catch (x) {
        setErr(errorText(x));
      }
    });
  };
  return (
    <form className="panel pad stack tight" onSubmit={save} data-testid="booking-form">
      <div className="seg" role="radiogroup" aria-label="What kind">
        {BOOKING_TYPES.map((t) => { const I = TYPES[t].icon; return <button type="button" key={t} role="radio" aria-checked={f.type === t} className={f.type === t ? 'on' : ''} onClick={() => setF({ ...f, type: t })}><I />{TYPES[t].label}</button>; })}
      </div>
      <input value={f.title} placeholder={T.name} onChange={set('title')} aria-label="Name" data-testid="booking-title" />
      {f.type !== 'emergency' && (
        <div className="form-grid">
          <input type="date" value={f.day} onChange={set('day')} aria-label="Date" />
          <input type="time" value={f.time} onChange={set('time')} aria-label="Time" />
        </div>
      )}
      <div className="form-grid">
        <input value={f.ref} placeholder={`${T.ref} (optional)`} onChange={set('ref')} aria-label={T.ref} />
        <input value={f.phone} placeholder="Phone (optional)" inputMode="tel" onChange={set('phone')} aria-label="Phone" />
      </div>
      <input value={f.place} placeholder={`${T.place} (optional)`} onChange={set('place')} aria-label={T.place} />
      {f.type !== 'flight' && <input value={f.local} placeholder="Address in the local language, for the driver (optional)" onChange={set('local')} aria-label="Address in the local language" />}
      <textarea value={f.notes} rows={2} placeholder={T.notes} onChange={set('notes')} aria-label="Notes" />
      <div className="row">
        <label className="btn small"><ImagePlus />{file ? file.name.slice(0, 24) : it?.image_id && !dropImg ? 'Replace ticket photo' : 'Ticket, QR or boarding pass photo'}<input type="file" accept="image/*" hidden onChange={(e) => { setFile(e.target.files?.[0] ?? null); setDropImg(false); }} /></label>
        {it?.image_id && !file && <label className="row small"><input type="checkbox" checked={dropImg} onChange={(e) => setDropImg(e.target.checked)} />Remove the photo</label>}
      </div>
      <ErrorBox error={err} />
      <div className="row"><button className="primary small" type="submit" disabled={busy || !f.title.trim()} data-testid="booking-save">{busy ? <Spinner /> : null}{it ? 'Save' : 'Add booking'}</button><button className="ghost small" type="button" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}
