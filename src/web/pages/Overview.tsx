import { useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Banknote, CalendarDays, Plus } from 'lucide-react';
import { computeHomeBalances, formatAmount, pairwiseDebts, shareOf, computeBalances, spendingBy, type Tx } from '../../engine/index.ts';
import { api, errorText } from '../api.ts';
import { useLedger } from '../store.tsx';
import { useTxForm } from '../components/txFormContext.ts';
import { TxList } from '../components/TxList.tsx';
import { TxDetail } from '../components/TxDetail.tsx';
import { Empty, ErrorBox, MoneyList, Stat, TripMark, fmtWhen, hueStyle } from '../components/ui.tsx';

const addTo = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

/** Last six months of "my share" for one currency. Single series, so hover labels replace a legend. */
function Bars({ data, currency }: { data: { key: string; label: string; value: number }[]; currency: string }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  const now = new Date().toISOString().slice(0, 7);
  return (
    <div data-testid="spend-chart">
      <div className="bars">
        {data.map((d) => (
          <div key={d.key} className={`col ${d.key === now ? 'cur' : ''}`} title={`${d.label}: ${formatAmount(d.value, currency)}`}>
            <span className="val">{formatAmount(d.value, currency)}</span>
            <div className="bar" style={{ height: `${Math.max((d.value / max) * 100, 1.5)}%` }} />
          </div>
        ))}
      </div>
      <div className="bars-labels">{data.map((d) => <span key={d.key}>{d.label}</span>)}</div>
    </div>
  );
}

export function Overview() {
  const l = useLedger();
  const { state, me, user, balances, reload, who, rateCtx, owner, ownAccounts } = l;
  const openForm = useTxForm();
  const [selected, setSelected] = useState<number | null>(null);
  const [cur, setCur] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedTx = selected != null ? state.transactions.find((t) => t.id === selected) : undefined;

  const owed = new Map<string, number>(), owe = new Map<string, number>();
  for (const d of pairwiseDebts(balances)) {
    if (d.to === me.id) addTo(owed, d.currency, d.amount);
    if (d.from === me.id) addTo(owe, d.currency, d.amount);
  }
  const hb = computeHomeBalances(state.transactions, rateCtx);
  let owedHome = 0, oweHome = 0;
  for (const d of pairwiseDebts(hb)) {
    if (d.to === me.id) owedHome += d.amount;
    if (d.from === me.id) oweHome += d.amount;
  }
  const foreignDebts = pairwiseDebts(balances).some((d) => d.currency !== rateCtx.home);
  const homeFoot = (v: number) => (foreignDebts && v ? `≈ ${formatAmount(v, rateCtx.home)}${hb.unconverted.size ? ' + unconverted' : ''}` : undefined);
  const month = new Date().toISOString().slice(0, 7);
  const monthShare = new Map<string, number>();
  for (const tx of state.transactions) if (tx.date.startsWith(month)) addTo(monthShare, tx.currency, shareOf(tx, me.id));
  const cashByCur = new Map<string, number>();
  for (const a of ownAccounts) if (a.type === 'cash' && !a.archived) addTo(cashByCur, a.currency, balances.accounts.get(a.id) ?? 0);
  const activeTrips = state.trips.filter((t) => !t.archived);

  // chart: six months ending now, my share, per currency
  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - (5 - i));
    return { key: d.toISOString().slice(0, 7), label: d.toLocaleDateString('en', { month: 'short' }) };
  });
  const byCur = new Map<string, Map<string, number>>();
  for (const tx of state.transactions) {
    const k = tx.date.slice(0, 7);
    if (!months.some((m) => m.key === k)) continue;
    const s = shareOf(tx, me.id);
    if (!s) continue;
    if (!byCur.has(tx.currency)) byCur.set(tx.currency, new Map());
    addTo(byCur.get(tx.currency)!, k, s);
  }
  const currencies = [...byCur.keys()].sort();
  const chartCur = cur && byCur.has(cur) ? cur : currencies.includes(state.settings.home_currency) ? state.settings.home_currency : currencies[0];

  // Entries someone else added or changed since this user last pressed "Got it" (never pressed: the latest few).
  const seenAt = user?.seen_at ?? '';
  const fresh = user ? state.transactions.filter((t) => (t.added_by != null && t.added_by !== me.id && t.created_at > seenAt) || (t.edited_by != null && t.edited_by !== me.id && t.updated_at > seenAt)).slice(0, 8) : [];
  const markSeen = async () => {
    setBusy(true);
    try {
      await api('POST', '/api/seen');
      await reload();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const loadSample = async () => {
    setBusy(true);
    try {
      await api('POST', '/api/seed');
      await reload();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!state.transactions.length) {
    return (
      <div className="stack">
        <div className="page-head"><div><h1>Overview</h1><div className="sub">Nothing recorded yet</div></div></div>
        <Empty title="Start with your first expense">
          <span>Friends, trips and accounts can be added as you go. Nothing has to be set up first.</span>
          <div className="row">
            <button className="primary" onClick={() => openForm()} data-testid="first-expense"><Plus />Add an expense</button>
            {owner && <button onClick={() => void loadSample()} disabled={busy} data-testid="load-sample">{busy ? 'Loading…' : 'Load sample data'}</button>}
          </div>
          <ErrorBox error={err} />
        </Empty>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Overview</h1><div className="sub">{state.transactions.length} transactions · {activeTrips.length} active trip{activeTrips.length === 1 ? '' : 's'}</div></div>
        <button className="primary" onClick={() => openForm()}><Plus />Add transaction</button>
      </div>
      {fresh.length > 0 && (
        <div className="panel" data-testid="fresh-panel">
          <div className="panel-head"><h3>New from others</h3><button className="small" disabled={busy} onClick={() => void markSeen()} data-testid="mark-seen">Got it</button></div>
          <TxList txs={fresh} onSelect={(tx) => setSelected(tx.id)} />
        </div>
      )}
      <div className="grid-4">
        <Stat label="You are owed" icon={ArrowDownLeft} foot={homeFoot(owedHome)}><MoneyList map={owed} empty="Nothing" /></Stat>
        <Stat label="You owe" icon={ArrowUpRight} foot={homeFoot(oweHome)}><MoneyList map={owe} empty="Nothing" /></Stat>
        <Stat label="Your spending this month" icon={CalendarDays}><MoneyList map={monthShare} empty="Nothing yet" /></Stat>
        <Stat label="Cash on hand" icon={Banknote}><MoneyList map={cashByCur} empty="No cash holdings" /></Stat>
      </div>
      {chartCur && (
        <div className="panel">
          <div className="panel-head">
            <h3>Your spending, last six months</h3>
            {currencies.length > 1 && (
              <div className="seg">{currencies.map((c) => <button key={c} className={c === chartCur ? 'on' : ''} onClick={() => setCur(c)}>{c}</button>)}</div>
            )}
          </div>
          <div className="panel-body">
            <Bars currency={chartCur} data={months.map((m) => ({ ...m, value: Math.max(byCur.get(chartCur)?.get(m.key) ?? 0, 0) }))} />
          </div>
        </div>
      )}
      <div className="overview-bottom">
        <div className="panel">
          <div className="panel-head"><h3>Recent transactions</h3><a href="#/transactions" className="small">See all</a></div>
          <TxList txs={state.transactions.slice(0, 8)} onSelect={(tx: Tx) => setSelected(tx.id)} />
        </div>
        <div className="stack">
          <div className="panel">
            <div className="panel-head"><h3>Trips</h3><a href="#/trips" className="small">All trips</a></div>
            <div className="table-wrap">
              <table>
                <tbody>
                  {activeTrips.map((t) => {
                    const txs = state.transactions.filter((x) => x.trip_id === t.id);
                    const net = computeBalances(txs).net.get(me.id) ?? new Map<string, number>();
                    const spent = spendingBy(txs, () => 'all').get('all') ?? new Map<string, number>();
                    return (
                      <tr key={t.id} className="clickable" onClick={() => { window.location.hash = `/trips/${t.id}`; }}>
                        <td><span className="who" style={hueStyle(t.id)}><TripMark name={t.name}><i className="avatar sm" style={{ width: 8, height: 8 }} /></TripMark>{t.name}</span><div className="faint small">{t.members.map(who).join(', ')}</div></td>
                        <td className="num"><MoneyList map={spent} empty="—" /><div className="small"><MoneyList map={net} sign empty="settled" /></div></td>
                      </tr>
                    );
                  })}
                  {activeTrips.length === 0 && <tr><td className="faint">No active trips.{owner && <> <a href="#/trips/new">Create one</a></>}</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Activity</h3></div>
            <div className="panel-body">
              <ul className="activity">
                {state.activity.slice(0, 8).map((a) => <li key={a.id}><time>{fmtWhen(a.at)}</time><span>{a.summary}</span></li>)}
              </ul>
            </div>
          </div>
        </div>
      </div>
      {selectedTx && <TxDetail tx={selectedTx} onClose={() => setSelected(null)} />}
    </div>
  );
}
