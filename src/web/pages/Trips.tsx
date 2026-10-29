import { useState } from 'react';
import { Banknote, ChevronLeft, Copy, Link2, Lock, LockOpen, Pencil, Plus, Smartphone, Trash2 } from 'lucide-react';
import { computeBalances, formatAmount, homeSpendingBy, parseAmount, shareOf, spendingBy, toMajor, type Id, type Person, type Share, type Trip, type TripBudget, type Tx } from '../../engine/index.ts';
import { api, errorText } from '../api.ts';
import { CATEGORIES, COMMON_CURRENCIES, copyText, featureOn, useLedger } from '../store.tsx';
import { navigate } from '../router.tsx';
import { useTxForm } from '../components/txFormContext.ts';
import { ExportButton, TxList } from '../components/TxList.tsx';
import { TxDetail } from '../components/TxDetail.tsx';
import { BalancesView } from '../components/BalancesView.tsx';
import { CategorySpend, type CategoryPick } from '../components/CategorySpend.tsx';
import { Avatar, BudgetBar, CategoryGlyph, DangerButton, TripMark, Empty, ErrorBox, Field, Modal, MoneyList, Spinner, Stat, fmtDate, hueStyle, useBusy } from '../components/ui.tsx';
import { RatesEditor } from '../components/RatesEditor.tsx';
import { TripPlan } from '../components/TripPlan.tsx';
import { ShortcutSetup } from '../components/ShortcutSetup.tsx';
import { computeHomeBalances } from '../../engine/index.ts';

const addTo = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

function TripForm({ existing, onClose }: { existing?: Trip; onClose: () => void }) {
  const { state, me, reload } = useLedger();
  const [t, setT] = useState<Omit<Trip, 'id'>>(existing ?? { name: '', start_date: null, end_date: null, currency: state.settings.home_currency, notes: null, archived: 0, members: [me.id], rates: null });
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const toggle = (id: Id) => setT((x) => ({ ...x, members: x.members.includes(id) ? x.members.filter((m) => m !== id) : [...x.members, id] }));
  const home = state.settings.home_currency;
  // Budget inputs by key: '' is the whole trip, otherwise a category. Amounts are in the home currency.
  const [budgetText, setBudgetText] = useState<Record<string, string>>(() => {
    const b = existing?.budget;
    const out: Record<string, string> = b?.total != null ? { '': toMajor(b.total, home) } : {};
    for (const [k, v] of Object.entries(b?.categories ?? {})) out[k] = toMajor(v, home);
    return out;
  });
  const save = async () => {
    const budget: TripBudget = { total: null, categories: {} };
    for (const [k, text] of Object.entries(budgetText)) {
      if (!text.trim()) continue;
      const v = parseAmount(text, home);
      if (v == null || v <= 0) return setErr(`${k || 'Whole trip'} budget: enter an amount in ${home}`);
      if (k) budget.categories[k] = v;
      else budget.total = v;
    }
    const body = { ...t, budget: budget.total != null || Object.keys(budget.categories).length ? budget : null };
    setSaving(true);
    try {
      const saved = existing ? (await api('PUT', `/api/trips/${existing.id}`, body), existing) : await api<Trip>('POST', '/api/trips', body);
      await reload();
      onClose();
      if (!existing) navigate(`/trips/${saved.id}`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title={existing ? 'Edit trip' : 'New trip or group'} onClose={onClose}>
      <div className="stack">
        <div className="form-grid">
          <Field label="Name" className="span-2"><input value={t.name} autoFocus placeholder="Singapore 2026" onChange={(e) => setT({ ...t, name: e.target.value })} data-testid="trip-name" /></Field>
          <Field label="Start"><input type="date" value={t.start_date ?? ''} onChange={(e) => setT({ ...t, start_date: e.target.value || null })} /></Field>
          <Field label="End" hint="The dates also tell the Apple Pay shortcut when to ask"><input type="date" value={t.end_date ?? ''} onChange={(e) => setT({ ...t, end_date: e.target.value || null })} /></Field>
          <Field label="Main currency" hint="Default for new expenses on this trip">
            <input list="currencies" value={t.currency} maxLength={3} onChange={(e) => setT({ ...t, currency: e.target.value.toUpperCase() })} data-testid="trip-currency" />
            <datalist id="currencies">{COMMON_CURRENCIES.map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <Field label="Notes"><input value={t.notes ?? ''} onChange={(e) => setT({ ...t, notes: e.target.value || null })} /></Field>
        </div>
        <div className="field">
          <span className="field-label">Members</span>
          <div className="chips">
            {state.people.filter((p) => !p.archived || t.members.includes(p.id)).map((p) => (
              <button type="button" key={p.id} className={`chip ${t.members.includes(p.id) ? 'on' : ''}`} onClick={() => toggle(p.id)} data-testid={`member-${p.id}`}>{p.is_me ? 'You' : p.name}</button>
            ))}
          </div>
          <span className="hint">Add more friends under People; members can change any time.</span>
        </div>
        <details open={!!t.rates}>
          <summary>Exchange rates for this trip (optional)</summary>
          <div className="stack tight" style={{ marginTop: 8 }}>
            <span className="hint">Overrides the default rates from Accounts & Cash for this trip only. Card charges recorded in {state.settings.home_currency} are always used as-is.</span>
            <RatesEditor value={t.rates} onChange={(r) => setT({ ...t, rates: r })} home={state.settings.home_currency} suggest={[t.currency, ...state.transactions.filter((x) => existing && x.trip_id === existing.id).map((x) => x.currency)]} testId="trip-rates" />
          </div>
        </details>
        <details open={!!existing?.budget}>
          <summary>Budget (optional)</summary>
          <div className="stack tight" style={{ marginTop: 8 }}>
            <span className="hint">What the whole group plans to spend, in {home}: for the trip, per category, or both. Card charges count at their real {home} amount, cash at the trip’s rates.</span>
            <div className="form-grid">
              {['', ...CATEGORIES].map((k) => (
                <label key={k} className={`field ${k ? '' : 'span-2'}`}>
                  <span className="field-label">{k ? <span className="who"><CategoryGlyph category={k} />{k}</span> : `Whole trip (${home})`}</span>
                  <input inputMode="decimal" value={budgetText[k] ?? ''} placeholder="No budget" onChange={(e) => setBudgetText({ ...budgetText, [k]: e.target.value })} data-testid={`budget-${k || 'total'}`} />
                </label>
              ))}
            </div>
          </div>
        </details>
        {existing && <label className="check"><input type="checkbox" checked={!!t.archived} onChange={(e) => setT({ ...t, archived: e.target.checked ? 1 : 0 })} /><span>Archived (hidden from pickers)</span></label>}
        <ErrorBox error={err} />
        <div className="row end">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={saving || !t.name.trim()} onClick={() => void save()} data-testid="save-trip">{existing ? 'Save' : 'Create trip'}</button>
        </div>
      </div>
    </Modal>
  );
}

function TripCard({ trip }: { trip: Trip }) {
  const { state, me, people } = useLedger();
  const txs = state.transactions.filter((t) => t.trip_id === trip.id);
  const spend = spendingBy(txs, () => 'all').get('all') ?? new Map();
  const net = computeBalances(txs).net.get(me.id) ?? new Map();
  return (
    <a className="panel trip-card" href={`#/trips/${trip.id}`} style={hueStyle(trip.id)} data-testid={`trip-card-${trip.id}`}>
      <div className="row between">
        <span className="name"><TripMark name={trip.name} id={trip.id} />{trip.name}{trip.closed ? <Lock className="lock" aria-label="Closed" /> : null}</span>
        <span className="badge">{trip.currency}</span>
      </div>
      <div className="row between">
        <span className="muted small">{trip.start_date ? `${fmtDate(trip.start_date)} – ${fmtDate(trip.end_date)}` : 'No dates'}</span>
        <span className="row" style={{ gap: 2 }}>{trip.members.map((m) => <Avatar key={m} id={m} name={people.get(m)?.name ?? '?'} small />)}</span>
      </div>
      <div className="line"><span>Spent</span><MoneyList map={spend} empty="nothing yet" /></div>
      <div className="line"><span>Your position</span><MoneyList map={net} sign empty="settled" /></div>
    </a>
  );
}

/** Share links for one trip: create, copy, revoke. */
export function ShareModal({ trip, person, onClose }: { trip?: Trip; person?: Person; onClose: () => void }) {
  const { state, reload } = useLedger();
  const [label, setLabel] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [simple, setSimple] = useState(false);
  const [busy, run] = useBusy();
  const links = state.shares.filter((x) => (person ? x.person_id === person.id : x.trip_id === trip?.id && x.person_id == null));
  const urlOf = (x: Share) => `${window.location.origin}${window.location.pathname}#/s/${x.token}${simple || person ? '/simple' : ''}`;
  const create = () => run(async () => {
    try {
      await api('POST', '/api/shares', { trip_id: trip?.id ?? null, person_id: person?.id ?? null, label: label || null });
      setLabel('');
      await reload();
      setErr(null);
    } catch (e) {
      setErr(errorText(e));
    }
  });
  const revoke = (id: number) => run(async () => {
    try {
      await api('DELETE', `/api/shares/${id}`);
      await reload();
    } catch (e) {
      setErr(errorText(e));
    }
  });
  const copy = async (x: Share) => {
    await copyText(urlOf(x));
    setCopied(x.id);
    window.setTimeout(() => setCopied(null), 1500);
  };
  return (
    <Modal title={`Share ${trip?.name ?? person?.name ?? ''}`} onClose={onClose}>
      <div className="stack">
        <p className="muted small">{person ? `Anyone with the link sees only the entries ${person.name} is part of, their share of each one, and what they owe or are owed, valued exactly as you see them. Nothing can be edited and your account balances stay private.` : 'Anyone with a link sees this trip’s expenses, balances and settlement plan. They cannot edit anything, and your account balances stay private. Turn a link off any time.'}</p>
        {!person && <label className="row small simple-check"><input type="checkbox" checked={simple} onChange={(e) => setSimple(e.target.checked)} data-testid="share-simple" />Copy links as the simple view (easier to read on a phone; viewers can switch)</label>}
        {links.length > 0 && (
          <div className="panel">
            <div className="table-wrap">
              <table data-testid="share-links">
                <tbody>
                  {links.map((x) => (
                    <tr key={x.id}>
                      <td>
                        <div>{x.label || 'View-only link'}</div>
                        <div className="faint small">Created {fmtDate(x.created_at.slice(0, 10))}</div>
                      </td>
                      <td className="actions">
                        <button className="small" onClick={() => void copy(x)} data-testid={`copy-share-${x.id}`}><Copy />{copied === x.id ? 'Copied' : 'Copy link'}</button>
                        <button className="small danger" disabled={busy} onClick={() => void revoke(x.id)} data-testid={`revoke-share-${x.id}`}><Trash2 />Turn off</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input value={label} placeholder="Label (optional), e.g. For the group chat" onChange={(e) => setLabel(e.target.value)} data-testid="share-label" />
          <button className="primary" disabled={busy} onClick={() => void create()} data-testid="create-share">{busy ? <Spinner /> : <Link2 />}New link</button>
        </div>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

const nextDay = (d: string) => new Date(Date.parse(d) + 86_400_000).toISOString().slice(0, 10);

/** The group's spending per day in the home currency, against the budget's daily pace when the trip has one. Tap a day for its entries. */
function TripDays({ trip, txs, onOpen }: { trip: Trip; txs: Tx[]; onOpen: (tx: Tx) => void }) {
  const { rateCtx } = useLedger();
  const [day, setDay] = useState<string | null>(null);
  const home = rateCtx.home;
  const perDay = homeSpendingBy(txs, rateCtx, (t) => t.date);
  const days = new Set(perDay.keys());
  let span = 0;
  if (trip.start_date && trip.end_date) for (let d = trip.start_date; d <= trip.end_date && span < 366; d = nextDay(d), span++) days.add(d);
  const list = [...days].sort().map((d) => ({ d, v: perDay.get(d)?.get(home) ?? 0 }));
  const pace = trip.budget?.total != null && span ? Math.round(trip.budget.total / span) : null;
  const max = Math.max(...list.map((x) => x.v), pace ?? 0, 1);
  const spent = list.reduce((s, x) => s + x.v, 0);
  const unconverted = [...perDay.values()].some((m) => [...m.keys()].some((c) => c !== home));
  const today = new Date().toISOString().slice(0, 10);
  const during = !!(trip.start_date && trip.end_date && trip.start_date <= today && today <= trip.end_date);
  const dayN = during ? Math.round((Date.parse(today) - Date.parse(trip.start_date!)) / 86_400_000) + 1 : 0;
  const soFar = list.filter((x) => x.d <= today).reduce((s, x) => s + x.v, 0);
  const summary = during && pace != null
    ? `Day ${dayN} of ${span}: ${formatAmount(soFar, home)} spent, ${formatAmount(pace * dayN, home)} planned by now (${soFar > pace * dayN ? `${formatAmount(soFar - pace * dayN, home)} ahead of plan` : `${formatAmount(pace * dayN - soFar, home)} under`}).`
    : `${formatAmount(spent, home)} over ${span || list.length} day${(span || list.length) === 1 ? '' : 's'}, about ${formatAmount(Math.round(spent / Math.max(span || list.length, 1)), home)} a day${pace != null ? ` against a budget of ${formatAmount(pace, home)} a day` : ''}.`;
  const picked = day ? txs.filter((t) => t.date === day) : [];
  if (!list.length) return <Empty title="No spending yet">Each day of the trip shows up here once something is spent.</Empty>;
  return (
    <div className="stack">
      <div className="panel pad stack" data-testid="trip-days">
        <div className="bars days">
          {pace != null && <span className="pace" style={{ bottom: `${(pace / max) * 100}%` }} title={`Budget pace: ${formatAmount(pace, home)} a day`} />}
          {list.map((x) => (
            <button type="button" key={x.d} className={`col ${x.d === day ? 'cur' : ''} ${pace != null && x.v > pace ? 'over' : ''}`} title={`${fmtDate(x.d)}: ${formatAmount(x.v, home)}`} aria-pressed={x.d === day} onClick={() => setDay(x.d === day ? null : x.d)} data-testid={`day-${x.d}`}>
              <div className="bar" style={{ height: `${Math.max((x.v / max) * 100, 1.5)}%` }} />
            </button>
          ))}
        </div>
        <div className="bars-labels days">{list.map((x) => <span key={x.d}>{Number(x.d.slice(8))}</span>)}</div>
        <span className="small muted">{day ? `${fmtDate(day)}: ${formatAmount(perDay.get(day)?.get(home) ?? 0, home)}${pace != null ? ` (pace ${formatAmount(pace, home)})` : ''}` : summary}{unconverted ? ' Cash without a rate isn’t counted.' : ''}</span>
      </div>
      {day && <div className="panel"><TxList txs={picked} showTrip={false} onSelect={onOpen} /></div>}
    </div>
  );
}

/** Everything about one trip: members, totals, transactions, balances, per-person. Also used by shared read-only links. */
export function TripView({ trip, shareToken, onRefresh }: { trip: Trip; shareToken?: string; onRefresh?: () => Promise<void> }) {
  const { state, me, who, people, readOnly, rateCtx } = useLedger();
  // A trip that has no entries yet is being planned: open on the board.
  const [tab, setTab] = useState<'plan' | 'transactions' | 'categories' | 'days' | 'balances' | 'people'>(() => (state.transactions.some((t) => t.trip_id === trip.id) || !featureOn(state, 'plan') ? 'transactions' : 'plan'));
  const [selected, setSelected] = useState<number | null>(null);
  const [cat, setCat] = useState<CategoryPick | null>(null);
  const txs = state.transactions.filter((t) => t.trip_id === trip.id);
  const selectedTx = selected != null ? txs.find((t) => t.id === selected) : undefined;
  const spend = spendingBy(txs, () => 'all').get('all') ?? new Map();
  const myShare = new Map<string, number>();
  for (const tx of txs) addTo(myShare, tx.currency, shareOf(tx, me.id));
  const myShareHome = homeSpendingBy(txs, rateCtx, () => '', me.id).get('') ?? new Map<string, number>();
  const spentHome = homeSpendingBy(txs, rateCtx, () => '').get('')?.get(rateCtx.home) ?? 0;
  const fees = new Map<string, number>();
  for (const tx of txs) if (tx.fee_amount) addTo(fees, tx.currency, tx.fee_amount);
  const b = computeBalances(txs);
  const hb = computeHomeBalances(txs, rateCtx);
  const myHome = hb.net.get(me.id)?.get(rateCtx.home) ?? 0;
  const foreign = txs.some((t) => t.currency !== rateCtx.home);
  const members = [...new Set([...trip.members, ...txs.flatMap((t) => [t.payer_id, t.payee_id, ...t.splits.map((s) => s.person_id)]).filter((x): x is Id => x != null)])];
  const perPerson = members.map((p) => {
    const paid = new Map<string, number>(), share = new Map<string, number>();
    for (const tx of txs) {
      if (tx.type === 'expense' && tx.payer_id === p) addTo(paid, tx.currency, tx.amount);
      if (tx.type === 'refund' && tx.payer_id === p) addTo(paid, tx.currency, -tx.amount);
      addTo(share, tx.currency, shareOf(tx, p));
    }
    return { p, paid, share, net: b.net.get(p) ?? new Map<string, number>() };
  });
  return (
    <div className="stack">
      <div className="chips">{trip.members.map((m) => <span key={m} className="chip static who"><Avatar id={m} name={people.get(m)?.name ?? '?'} small />{who(m)}</span>)}</div>
      <div className="grid-4">
        <Stat label="Total spent (everyone)"><MoneyList map={spend} empty="Nothing yet" /></Stat>
        {!readOnly && <Stat label="Your share" foot={foreign && myShareHome.size ? <>≈ <MoneyList map={myShareHome} /> spent by you</> : undefined}><MoneyList map={myShare} empty="Nothing yet" /></Stat>}
        {!readOnly && <Stat label="Your position" foot={foreign && myHome ? `≈ ${formatAmount(myHome, rateCtx.home)}${hb.unconverted.size ? ' + unconverted' : ''}` : undefined}><MoneyList map={b.net.get(me.id) ?? new Map()} sign empty="Settled" /></Stat>}
        {readOnly && <Stat label="Transactions">{txs.length}</Stat>}
        {trip.budget?.total != null && <Stat label="Budget" foot={<BudgetBar spent={spentHome} limit={trip.budget.total} currency={rateCtx.home} />}>{formatAmount(spentHome, rateCtx.home)}</Stat>}
        {fees.size > 0 && <Stat label="Fees on transfers" foot="Kept out of spending"><MoneyList map={fees} /></Stat>}
      </div>
      <div className="tabs">
        {(['plan', 'transactions', 'categories', 'days', 'balances', 'people'] as const).filter((t) => t !== 'plan' || featureOn(state, 'plan')).map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)} data-testid={`trip-tab-${t}`}>{t === 'plan' ? 'Plan' : t === 'people' ? 'Per person' : t === 'categories' ? 'By category' : t === 'days' ? 'By day' : t[0]!.toUpperCase() + t.slice(1)}</button>)}
      </div>
      {tab === 'plan' && featureOn(state, 'plan') && <TripPlan trip={trip} shareToken={shareToken} onRefresh={onRefresh} />}
      {tab === 'transactions' && (
        <div className="stack tight">
          <div className="row end"><ExportButton txs={txs} title={trip.name} /></div>
          <div className="panel"><TxList txs={txs} showTrip={false} onSelect={(tx: Tx) => setSelected(tx.id)} /></div>
        </div>
      )}
      {tab === 'categories' && (
        <div className="stack">
          <CategorySpend txs={txs} person={readOnly ? undefined : me.id} budget={trip.budget} selected={cat?.label ?? null} onSelect={setCat} />
          {cat && <div className="panel"><TxList txs={txs.filter(cat.match)} showTrip={false} onSelect={(tx: Tx) => setSelected(tx.id)} /></div>}
        </div>
      )}
      {tab === 'days' && <TripDays trip={trip} txs={txs} onOpen={(tx) => setSelected(tx.id)} />}
      {tab === 'balances' && <BalancesView txs={txs} tripId={trip.id} />}
      {tab === 'people' && (
        <div className="panel">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Person</th><th className="num">Paid</th><th className="num">Share of spending</th><th className="num">Net</th></tr></thead>
              <tbody>
                {perPerson.map((r) => (
                  <tr key={r.p}>
                    <td><span className="who"><Avatar id={r.p} name={people.get(r.p)?.name ?? '?'} small />{who(r.p)}</span></td>
                    <td className="num"><MoneyList map={r.paid} empty="—" /></td>
                    <td className="num"><MoneyList map={r.share} empty="—" /></td>
                    <td className="num"><MoneyList map={r.net} sign empty="settled" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel-foot">Net = paid − share ± repayments tagged to this trip.</div>
        </div>
      )}
      {selectedTx && <TxDetail tx={selectedTx} onClose={() => setSelected(null)} />}
    </div>
  );
}

function TripDetail({ trip }: { trip: Trip }) {
  const { state, reload, owner } = useLedger();
  const openForm = useTxForm();
  const [edit, setEdit] = useState(false);
  const [share, setShare] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [applePay, setApplePay] = useState(false);
  const [busy, run] = useBusy();
  const txs = state.transactions.filter((t) => t.trip_id === trip.id);
  // Closing locks a settled trip so nobody shifts old balances by accident; only the owner can reopen it.
  const setClosed = (closed: 0 | 1) => {
    if (closed && !window.confirm(`Close ${trip.name}? Nobody can add, change or delete its entries until you reopen it. Comments and receipt photos still work.`)) return;
    void run(async () => {
      try {
        await api('PUT', `/api/trips/${trip.id}`, { ...trip, closed });
        await reload();
        setErr(null);
      } catch (e) {
        setErr(errorText(e));
      }
    });
  };
  const linkCount = state.shares.filter((x) => x.trip_id === trip.id).length;
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <a href="#/trips" className="back"><ChevronLeft />All trips</a>
          <h1 className="row" style={{ gap: 10, flexWrap: 'nowrap', alignItems: 'baseline' }}><TripMark name={trip.name} id={trip.id} /><span>{trip.name}</span>{trip.archived ? <span className="badge">archived</span> : null}</h1>
          <div className="sub">{trip.start_date ? `${fmtDate(trip.start_date)} – ${fmtDate(trip.end_date)} · ` : ''}{trip.currency}{trip.notes ? ` · ${trip.notes}` : ''}</div>
        </div>
        <div className="row">
          <button onClick={() => setApplePay(true)} data-testid="apple-pay"><Smartphone />iPhone shortcuts</button>
          {featureOn(state, 'shares') && <button onClick={() => setShare(true)} data-testid="share-trip"><Link2 />{linkCount ? `Shared (${linkCount})` : 'Share'}</button>}
          {owner && <button onClick={() => setEdit(true)} data-testid="edit-trip"><Pencil />Edit</button>}
          {owner && !trip.closed && <button disabled={busy} onClick={() => setClosed(1)} data-testid="close-trip"><Lock />Close trip</button>}
          {!trip.closed && <button onClick={() => openForm({ initial: { type: 'withdrawal', trip_id: trip.id } })}><Banknote />Cash withdrawal</button>}
          {!trip.closed && <button className="primary" onClick={() => openForm({ initial: { type: 'expense', trip_id: trip.id, currency: trip.currency } })} data-testid="trip-add-expense"><Plus />Add expense</button>}
        </div>
      </div>
      {trip.closed ? (
        <div className="locked-note" data-testid="trip-closed">
          <Lock />
          <span>Closed · entries are locked{owner ? '' : ' until the owner reopens it'}</span>
          {owner && <button className="small" disabled={busy} onClick={() => setClosed(0)} data-testid="reopen-trip"><LockOpen />Reopen</button>}
        </div>
      ) : null}
      <ErrorBox error={err} />
      <TripView key={trip.id} trip={trip} />
      {owner && txs.length === 0 && (
        <div><DangerButton small={false} confirm={`Delete trip "${trip.name}"?`} onConfirm={async () => { await api('DELETE', `/api/trips/${trip.id}`); await reload(); navigate('/trips'); }}>Delete trip</DangerButton></div>
      )}
      {edit && <TripForm existing={trip} onClose={() => setEdit(false)} />}
      {share && <ShareModal trip={trip} onClose={() => setShare(false)} />}
      {applePay && <Modal title="iPhone shortcuts" onClose={() => setApplePay(false)}><ShortcutSetup trip={trip} /></Modal>}
    </div>
  );
}

export function Trips({ id, creating = false }: { id: number | null; creating?: boolean }) {
  const { state, trips, owner } = useLedger();
  const [open, setOpen] = useState(false);
  const trip = id != null && !Number.isNaN(id) ? trips.get(id) : undefined;
  if (id != null && !Number.isNaN(id) && !trip) return <Empty title="Trip not found"><a href="#/trips">Back to trips</a></Empty>;
  if (trip) return <TripDetail trip={trip} />;
  const active = state.trips.filter((t) => !t.archived), archived = state.trips.filter((t) => t.archived);
  const close = () => { setOpen(false); if (creating) navigate('/trips'); };
  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Trips & Groups</h1><div className="sub">Each trip keeps its own expenses, balances and settlement</div></div>
        {owner && <button className="primary" onClick={() => setOpen(true)} data-testid="new-trip"><Plus />New trip</button>}
      </div>
      {active.length === 0 && <Empty title="No trips yet">{owner ? "Create one to keep a trip's expenses separate from everything else." : 'Trips you are added to show up here.'}</Empty>}
      <div className="trip-grid">{active.map((t) => <TripCard key={t.id} trip={t} />)}</div>
      {archived.length > 0 && (
        <details>
          <summary>Archived ({archived.length})</summary>
          <div className="trip-grid" style={{ marginTop: 'var(--space-3)' }}>{archived.map((t) => <TripCard key={t.id} trip={t} />)}</div>
        </details>
      )}
      {owner && (open || creating) && <TripForm onClose={close} />}
    </div>
  );
}
