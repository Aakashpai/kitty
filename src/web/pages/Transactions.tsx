import { useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { TX_TYPES, type Tx, type TxType } from '../../engine/index.ts';
import { api, errorText } from '../api.ts';
import { useLedger } from '../store.tsx';
import { useTxForm } from '../components/txFormContext.ts';
import { ExportButton, TxList } from '../components/TxList.tsx';
import { TxDetail } from '../components/TxDetail.tsx';
import { DangerButton, ErrorBox, Field, Money, TYPE_LABEL, TripMark, TypeIcon, fmtDate, hueStyle } from '../components/ui.tsx';

type Sort = 'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc';

/** Scope switcher shared by Transactions, Balances and Reports: everything / personal / one trip. */
export function ScopeSeg({ value, onChange, testId }: { value: string; onChange: (v: string) => void; testId?: string }) {
  const { state } = useLedger();
  return (
    <div className="seg" data-testid={testId}>
      <button className={value === '' ? 'on' : ''} onClick={() => onChange('')}>All</button>
      <button className={value === 'none' ? 'on' : ''} onClick={() => onChange('none')}>Personal</button>
      {state.trips.filter((t) => !t.archived || String(t.id) === value).map((t) => (
        <button key={t.id} className={value === String(t.id) ? 'on' : ''} onClick={() => onChange(String(t.id))} style={hueStyle(t.id)}><TripMark name={t.name} id={t.id} />{t.name}</button>
      ))}
    </div>
  );
}

export const inScope = (t: Tx, scope: string) => (scope === '' ? true : scope === 'none' ? t.trip_id == null : t.trip_id === Number(scope));

export function Transactions() {
  const { state, reload } = useLedger();
  const [err, setErr] = useState<string | null>(null);
  const openForm = useTxForm();
  const [q, setQ] = useState('');
  const [type, setType] = useState<TxType | ''>('');
  const [scope, setScope] = useState('');
  const [person, setPerson] = useState('');
  const [account, setAccount] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<Sort>('date-desc');
  const [selected, setSelected] = useState<number | null>(null);

  const txs = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = state.transactions.filter((t) => {
      if (!inScope(t, scope)) return false;
      if (type && t.type !== type) return false;
      if (person && !(t.payer_id === Number(person) || t.payee_id === Number(person) || t.splits.some((s) => s.person_id === Number(person)))) return false;
      if (account && !(t.from_account_id === Number(account) || t.to_account_id === Number(account))) return false;
      if (from && t.date < from) return false;
      if (to && t.date > to) return false;
      if (needle && ![t.description, t.category, t.notes, t.reference, t.method, String(t.amount)].some((s) => s?.toLowerCase().includes(needle))) return false;
      return true;
    });
    const cmp: Record<Sort, (a: Tx, b: Tx) => number> = {
      'date-desc': (a, b) => b.date.localeCompare(a.date) || b.id - a.id,
      'date-asc': (a, b) => a.date.localeCompare(b.date) || a.id - b.id,
      'amount-desc': (a, b) => b.amount - a.amount,
      'amount-asc': (a, b) => a.amount - b.amount,
    };
    return list.sort(cmp[sort]);
  }, [state.transactions, q, type, scope, person, account, from, to, sort]);
  const selectedTx = selected != null ? state.transactions.find((t) => t.id === selected) : undefined;
  const scopedTrip = scope && scope !== 'none' ? state.trips.find((t) => t.id === Number(scope)) : undefined;

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Transactions</h1><div className="sub">{txs.length} of {state.transactions.length}{scopedTrip ? ` · ${scopedTrip.name}` : scope === 'none' ? ' · personal only' : ''}</div></div>
        <div className="row">
          <ExportButton txs={txs} title={scopedTrip ? scopedTrip.name : 'Transactions'} />
          <button className="primary" onClick={() => openForm(scopedTrip ? { initial: { trip_id: scopedTrip.id, currency: scopedTrip.currency } } : {})}><Plus />Add transaction</button>
        </div>
      </div>
      {(state.recurring ?? []).length > 0 && (
        <div className="panel" data-testid="recurring-panel">
          <div className="panel-head"><h3>Repeating</h3><span className="faint small">Added automatically on each date</span></div>
          <div className="table-wrap">
            <table>
              <tbody>
                {(state.recurring ?? []).map((r) => (
                  <tr key={r.id}>
                    <td><span className="who"><TypeIcon type={r.template.type} category={r.template.category} small />{r.template.description || TYPE_LABEL[r.template.type]}</span></td>
                    <td className="num"><Money amount={r.template.amount} currency={r.template.currency} /></td>
                    <td className="muted">{r.every === 'weekly' ? 'Every week' : 'Every month'} · next {fmtDate(r.next_date)}</td>
                    <td className="actions"><DangerButton confirm="Stop repeating? Entries already added stay." onConfirm={async () => { try { await api('DELETE', `/api/recurring/${r.id}`); await reload(); } catch (e) { setErr(errorText(e)); } }}>Stop</DangerButton></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ErrorBox error={err} />
        </div>
      )}
      <ScopeSeg value={scope} onChange={setScope} testId="tx-scope" />
      <div className="panel pad form-grid">
        <div className="field span-2">
          <span className="field-label">Search</span>
          <div className="search"><Search /><input value={q} placeholder="Description, category, reference…" onChange={(e) => setQ(e.target.value)} data-testid="search" /></div>
        </div>
        <Field label="Type">
          <select value={type} onChange={(e) => setType(e.target.value as TxType | '')} data-testid="filter-type">
            <option value="">All types</option>
            {TX_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
        </Field>
        <Field label="Person">
          <select value={person} onChange={(e) => setPerson(e.target.value)}>
            <option value="">Anyone</option>
            {state.people.map((p) => <option key={p.id} value={p.id}>{p.is_me ? 'You' : p.name}</option>)}
          </select>
        </Field>
        <Field label="Account">
          <select value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="">Any</option>
            {state.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Sort">
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="date-desc">Newest first</option>
            <option value="date-asc">Oldest first</option>
            <option value="amount-desc">Largest amount</option>
            <option value="amount-asc">Smallest amount</option>
          </select>
        </Field>
      </div>
      <div className="panel"><TxList txs={txs} onSelect={(tx) => setSelected(tx.id)} /></div>
      {selectedTx && <TxDetail tx={selectedTx} onClose={() => setSelected(null)} />}
    </div>
  );
}
