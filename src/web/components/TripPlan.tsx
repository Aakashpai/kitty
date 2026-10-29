import { useState, type FormEvent } from 'react';
import { ExternalLink, Link2, ListChecks, Plus, Star, ThumbsUp, Trash2 } from 'lucide-react';
import { formatAmount, homeSpendingBy, type Id, type PlanItem, type PlanKind, type Trip } from '../../engine/index.ts';
import { api, errorText } from '../api.ts';
import { useLedger } from '../store.tsx';
import { Avatar, BudgetBar, DangerButton, Empty, ErrorBox, Spinner, Stat, useBusy } from './ui.tsx';

const PACK: Record<'domestic' | 'international', string[]> = {
  domestic: ['ID card', 'Phone charger & power bank', 'Toiletries', 'Medicines', 'Sunscreen', 'Swimwear', 'Sunglasses', 'Cash', 'Speaker', 'Snacks & drinks'],
  international: ['Passport', 'Visa or e-visa printout', 'Travel insurance', 'Forex card & some cash', 'Universal adapter', 'Phone charger & power bank', 'Copies of tickets & hotel booking', 'Medicines', 'Toiletries', 'Sunscreen'],
};
const TODO = ['Book the stay', 'Book travel', 'Confirm who is coming', 'Collect the advance', 'Plan the route or cab', 'Groceries & drinks list'];

const dayList = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = new Date(from + 'T00:00:00Z'); out.length < 60; d.setUTCDate(d.getUTCDate() + 1)) { // UTC throughout, so no day slips in any timezone
    const s = d.toISOString().slice(0, 10);
    if (s > to) break;
    out.push(s);
  }
  return out;
};
const fmtDay = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

function InlineAdd({ placeholder, onAdd, disabled }: { placeholder: string; onAdd: (title: string) => Promise<unknown>; disabled?: boolean }) {
  const [v, setV] = useState('');
  const submit = (e: FormEvent) => { e.preventDefault(); const t = v.trim(); if (!t) return; setV(''); void onAdd(t); };
  return (
    <form className="plan-add" onSubmit={submit}>
      <input value={v} placeholder={placeholder} disabled={disabled} onChange={(e) => setV(e.target.value)} />
      <button className="small" type="submit" disabled={disabled || !v.trim()}><Plus />Add</button>
    </form>
  );
}

/** The trip board: budget vs reality, where to stay (with votes), itinerary, to-do and packing lists, links. Members edit; a trip link can vote and tick. */
export function TripPlan({ trip, shareToken, onRefresh }: { trip: Trip; shareToken?: string; onRefresh?: () => Promise<void> }) {
  const { state, me, who, people, readOnly, reload, rateCtx, user } = useLedger();
  const home = rateCtx.home;
  const items = (state.plan ?? []).filter((p) => p.trip_id === trip.id);
  const votes = state.votes ?? [];
  const txs = state.transactions.filter((t) => t.trip_id === trip.id);
  const [err, setErr] = useState<string | null>(null);
  const [busy, run] = useBusy();
  const [form, setForm] = useState<'stay' | 'link' | null>(null);
  // Who is acting: the signed-in person, or on a trip link a name the viewer picks once per device.
  const [linkMe, setLinkMeState] = useState<Id | null>(() => { try { const v = localStorage.getItem(`plan-me-${trip.id}`); return v ? Number(v) : null; } catch { return null; } });
  const setLinkMe = (id: Id | null) => { setLinkMeState(id); try { if (id == null) localStorage.removeItem(`plan-me-${trip.id}`); else localStorage.setItem(`plan-me-${trip.id}`, String(id)); } catch { /* ignore */ } };
  const actor = readOnly ? linkMe : (user?.person_id ?? me.id);
  const canEdit = !readOnly;
  const needName = readOnly && actor == null;
  const refresh = async () => { if (onRefresh) await onRefresh(); else await reload(); };
  const act = (fn: () => Promise<unknown>) => run(async () => { try { await fn(); await refresh(); setErr(null); } catch (e) { setErr(errorText(e)); } });
  const add = (kind: PlanKind, fields: Record<string, unknown>) => act(() => api('POST', `/api/trips/${trip.id}/plan`, { kind, ...fields }));
  const patch = (it: PlanItem, p: Record<string, unknown>) => act(() => api('PUT', `/api/plan/${it.id}`, p));
  const vote = (it: PlanItem) => act(() => (readOnly ? api('POST', `/api/shared/${shareToken}/plan/${it.id}/vote`, { person_id: actor }) : api('POST', `/api/plan/${it.id}/vote`)));
  const tick = (it: PlanItem) => act(() => (readOnly ? api('PUT', `/api/shared/${shareToken}/plan/${it.id}/done`, { done: it.done ? 0 : 1, person_id: actor }) : api('PUT', `/api/plan/${it.id}`, { done: it.done ? 0 : 1 })));
  const of = (kind: PlanKind) => items.filter((i) => i.kind === kind).sort((a, b) => a.sort - b.sort || a.id - b.id);
  const stays = of('stay'), days = of('day'), tasks = of('task'), packs = of('pack'), links = of('link'), notes = of('note');
  const members = trip.members.length || 1;
  const spentHome = homeSpendingBy(txs, rateCtx, () => '').get('')?.get(home) ?? 0;
  const total = trip.budget?.total ?? null;
  const dates = trip.start_date && trip.end_date ? dayList(trip.start_date, trip.end_date) : [...new Set(days.map((d) => d.day).filter((d): d is string => !!d))].sort();
  const intl = trip.currency !== home;
  const Del = ({ it }: { it: PlanItem }) => <DangerButton confirm={`Remove "${it.title}"?`} onConfirm={async () => { await api('DELETE', `/api/plan/${it.id}`); await refresh(); }}><Trash2 /></DangerButton>;
  const Person = ({ id }: { id: Id }) => <Avatar id={id} name={people.get(id)?.name ?? '?'} small />;

  const Checklist = ({ kind, title, list, template, hint }: { kind: 'task' | 'pack'; title: string; list: PlanItem[]; template: string[]; hint: string }) => {
    const done = list.filter((i) => i.done).length;
    const missing = template.filter((t) => !list.some((i) => i.title.toLowerCase() === t.toLowerCase()));
    return (
      <section>
        <div className="plan-head"><h3><ListChecks /> {title}{list.length ? <span className="faint small"> · {done} of {list.length} done</span> : null}</h3>{canEdit && missing.length > 0 && <button className="small ghost" disabled={busy} onClick={() => act(async () => { for (const t of missing) await api('POST', `/api/trips/${trip.id}/plan`, { kind, title: t }); })}><Plus />Add the usual</button>}</div>
        <div className="panel">
          {list.length === 0 && <div className="plan-row muted">{hint}</div>}
          {list.map((it) => (
            <div className="plan-row" key={it.id}>
              <label className="check"><input type="checkbox" checked={!!it.done} disabled={busy || needName} onChange={() => tick(it)} /><span className={it.done ? 'done' : ''}>{it.title}</span></label>
              <span className="grow" />
              {canEdit ? (
                <select value={it.assignee_id ?? ''} disabled={busy} onChange={(e) => patch(it, { assignee_id: e.target.value ? Number(e.target.value) : null })} aria-label="Who">
                  <option value="">Anyone</option>
                  {trip.members.map((m) => <option key={m} value={m}>{who(m)}</option>)}
                </select>
              ) : it.assignee_id != null ? <span className="who small"><Person id={it.assignee_id} />{who(it.assignee_id)}</span> : null}
              {canEdit && <Del it={it} />}
            </div>
          ))}
          {canEdit && <InlineAdd placeholder={kind === 'pack' ? 'Something to pack' : 'Something to do'} disabled={busy} onAdd={(t) => add(kind, { title: t })} />}
        </div>
      </section>
    );
  };

  return (
    <div className="stack plan">
      {readOnly && (
        <div className="row between info-box">
          <span>{actor != null ? <>Voting and ticking as <strong>{who(actor)}</strong></> : 'Pick your name to vote and tick things off'}</span>
          <select value={actor ?? ''} onChange={(e) => setLinkMe(e.target.value ? Number(e.target.value) : null)} aria-label="Your name" data-testid="plan-me">
            <option value="">Who are you?</option>
            {trip.members.map((m) => <option key={m} value={m}>{people.get(m)?.name ?? m}</option>)}
          </select>
        </div>
      )}
      <ErrorBox error={err} />

      <section className="panel pad stack tight">
        <div className="plan-head"><h3>Budget vs reality</h3>{canEdit && <span className="faint small">Set the budget under Edit trip</span>}</div>
        {total != null ? (
          <div className="grid-3">
            <Stat label="Planned per head">{formatAmount(Math.round(total / members), home)}</Stat>
            <Stat label="Actual per head so far" foot={`${members} ${members === 1 ? 'person' : 'people'}`}>{formatAmount(Math.round(spentHome / members), home)}</Stat>
            <Stat label="Everyone so far" foot={<BudgetBar spent={spentHome} limit={total} currency={home} />}>{formatAmount(spentHome, home)}</Stat>
          </div>
        ) : <p className="muted small" style={{ margin: 0 }}>No budget yet{canEdit ? ': add a total under Edit trip to see planned versus actual per head.' : '.'}</p>}
      </section>

      <section>
        <div className="plan-head"><h3><Star /> Where to stay</h3>{canEdit && <button className="small" disabled={busy} onClick={() => setForm(form === 'stay' ? null : 'stay')}><Plus />Add option</button>}</div>
        {form === 'stay' && <StayForm busy={busy} home={home} onCancel={() => setForm(null)} onAdd={async (f) => { await add('stay', f); setForm(null); }} />}
        {stays.length === 0 && form !== 'stay' && <Empty title="No options yet">{canEdit ? 'Add the villas or hotels you are weighing up. Everyone votes, then pick one.' : 'Nothing to vote on yet.'}</Empty>}
        <div className="stay-grid">
          {stays.map((s) => {
            const vs = votes.filter((v) => v.item_id === s.id);
            const mine = actor != null && vs.some((v) => v.person_id === actor);
            return (
              <div key={s.id} className={`panel pad stay stack tight${s.meta?.chosen ? ' chosen' : ''}`} data-testid={`stay-${s.id}`}>
                <div className="row between"><strong>{s.title}</strong>{s.meta?.chosen ? <span className="badge pos">Picked</span> : null}</div>
                {(s.meta?.price != null || s.meta?.distance) && <div className="muted small">{[s.meta?.price != null ? `${formatAmount(s.meta.price, home)} a night` : null, s.meta?.distance].filter(Boolean).join(' · ')}</div>}
                {s.body && <a className="small" href={s.body} target="_blank" rel="noreferrer"><ExternalLink className="inline-icon" /> Open listing</a>}
                <div className="row between">
                  <span className="voters">{vs.map((v) => <Person key={v.person_id} id={v.person_id} />)}<span className="faint small">{vs.length} vote{vs.length === 1 ? '' : 's'}</span></span>
                  <span className="row">
                    <button className={`small${mine ? ' primary' : ''}`} disabled={busy || needName} onClick={() => vote(s)} data-testid={`vote-${s.id}`}><ThumbsUp />{mine ? 'Voted' : 'Vote'}</button>
                    {canEdit && !s.meta?.chosen && <button className="small ghost" disabled={busy} onClick={() => act(() => api('POST', `/api/plan/${s.id}/choose`))}><Star />Pick</button>}
                    {canEdit && <Del it={s} />}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <div className="plan-head"><h3>Itinerary</h3></div>
        {dates.length === 0 && <p className="muted small">{canEdit ? 'Set the trip dates under Edit trip to plan day by day.' : 'No dates set yet.'}</p>}
        <div className="stack tight">
          {dates.map((d) => (
            <div className="panel" key={d}>
              <div className="panel-head"><h3>{fmtDay(d)}</h3></div>
              {days.filter((i) => i.day === d).map((i) => <div className="plan-row" key={i.id}><span className="title">{i.title}</span>{canEdit && <Del it={i} />}</div>)}
              {canEdit && <InlineAdd placeholder="What happens this day" disabled={busy} onAdd={(t) => add('day', { title: t, day: d })} />}
            </div>
          ))}
        </div>
      </section>

      <Checklist kind="task" title="To-do" list={tasks} template={TODO} hint="Bookings, the advance, who arranges the cab." />
      <Checklist kind="pack" title="Packing" list={packs} template={PACK[intl ? 'international' : 'domestic']} hint="Tick things off as they go in the bag." />

      <section>
        <div className="plan-head"><h3><Link2 /> Links & notes</h3>{canEdit && <button className="small" disabled={busy} onClick={() => setForm(form === 'link' ? null : 'link')}><Plus />Add link</button>}</div>
        {form === 'link' && <LinkForm busy={busy} onCancel={() => setForm(null)} onAdd={async (f) => { await add('link', f); setForm(null); }} />}
        <div className="panel">
          {links.length === 0 && notes.length === 0 && form !== 'link' && <div className="plan-row muted">Research goes here: places to eat, the trek route, the booking confirmation.</div>}
          {links.map((l) => <div className="plan-row" key={l.id}><a className="title" href={l.body ?? '#'} target="_blank" rel="noreferrer"><ExternalLink className="inline-icon" /> {l.title}</a>{canEdit && <Del it={l} />}</div>)}
          {notes.map((n) => <div className="plan-row" key={n.id}><span className="title">{n.title}</span>{canEdit && <Del it={n} />}</div>)}
          {canEdit && <InlineAdd placeholder="A note for everyone" disabled={busy} onAdd={(t) => add('note', { title: t })} />}
        </div>
      </section>
      {busy && <div className="faint small"><Spinner /> Saving…</div>}
    </div>
  );
}

function StayForm({ busy, home, onAdd, onCancel }: { busy: boolean; home: string; onAdd: (f: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const [f, setF] = useState({ title: '', body: '', price: '', distance: '' });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const price = f.price.trim() ? Math.round(Number(f.price.replace(/[^\d.]/g, '')) * 100) : null;
    void onAdd({ title: f.title.trim(), body: f.body.trim() || null, meta: { price: Number.isFinite(price) ? price : null, distance: f.distance.trim() || null } });
  };
  return (
    <form className="panel pad stack tight" onSubmit={submit} data-testid="stay-form">
      <div className="grid-2">
        <input value={f.title} autoFocus placeholder="Name, e.g. Villa Serene, Lonavala" onChange={(e) => setF({ ...f, title: e.target.value })} data-testid="stay-title" />
        <input value={f.body} placeholder="Listing link (optional)" inputMode="url" onChange={(e) => setF({ ...f, body: e.target.value })} />
        <input value={f.price} placeholder={`Price a night in ${home} (optional)`} inputMode="decimal" onChange={(e) => setF({ ...f, price: e.target.value })} />
        <input value={f.distance} placeholder="Distance or notes, e.g. 2h from Mumbai, pool" onChange={(e) => setF({ ...f, distance: e.target.value })} />
      </div>
      <div className="row"><button className="primary small" type="submit" disabled={busy || !f.title.trim()}>Add option</button><button className="ghost small" type="button" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

function LinkForm({ busy, onAdd, onCancel }: { busy: boolean; onAdd: (f: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const [f, setF] = useState({ title: '', body: '' });
  return (
    <form className="panel pad stack tight" onSubmit={(e) => { e.preventDefault(); void onAdd({ title: f.title.trim(), body: f.body.trim() }); }}>
      <div className="grid-2">
        <input value={f.title} autoFocus placeholder="What is it, e.g. Trek route" onChange={(e) => setF({ ...f, title: e.target.value })} />
        <input value={f.body} placeholder="https://…" inputMode="url" onChange={(e) => setF({ ...f, body: e.target.value })} />
      </div>
      <div className="row"><button className="primary small" type="submit" disabled={busy || !f.title.trim() || !/^https?:\/\//.test(f.body.trim())}>Add link</button><button className="ghost small" type="button" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}
