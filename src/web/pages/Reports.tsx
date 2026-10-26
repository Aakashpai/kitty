import { useMemo, useRef, useState } from 'react';
import { Database, Download, Upload } from 'lucide-react';
import { effectsOf, formatAmount, homeValue, shareOf, spendingBy, toMajor, type Tx } from '../../engine/index.ts';
import { api, errorText } from '../api.ts';
import { useLedger } from '../store.tsx';
import { ErrorBox, Field, Money, MoneyList, Spinner, Stat, useBusy } from '../components/ui.tsx';
import { ScopeSeg, inScope } from './Transactions.tsx';

const addTo = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
const download = (name: string, content: string, type: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
};
const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per key; each currency gets its own meter scaled to that currency's largest row. */
function GroupTable({ title, groups, note }: { title: string; groups: Map<string, Map<string, number>>; note?: string }) {
  const rows = [...groups].sort(([a], [b]) => a.localeCompare(b));
  const max = new Map<string, number>();
  for (const [, m] of rows) for (const [cur, v] of m) max.set(cur, Math.max(max.get(cur) ?? 0, Math.abs(v)));
  return (
    <div className="panel">
      <div className="panel-head"><h3>{title}</h3></div>
      {rows.length === 0 ? <div className="panel-body faint small">Nothing in range.</div> : (
        <div className="table-wrap">
          <table>
            <tbody>
              {rows.map(([k, m]) => (
                <tr key={k}>
                  <td style={{ width: '38%' }}>{k}</td>
                  <td>
                    {[...m].filter(([, v]) => v !== 0).sort(([a], [b]) => a.localeCompare(b)).map(([cur, v]) => (
                      <div key={cur} className="row" style={{ flexWrap: 'nowrap', gap: 10 }}>
                        <span className="meter" style={{ flex: 1 }}><i style={{ width: `${(Math.abs(v) / (max.get(cur) || 1)) * 100}%` }} /></span>
                        <span className="num small" style={{ minWidth: 120 }}><Money amount={v} currency={cur} /></span>
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {note && <div className="panel-foot">{note}</div>}
    </div>
  );
}

export function Reports() {
  const { state, me, who, accountName, trips, reload, rateCtx } = useLedger();
  const [scope, setScope] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, run] = useBusy();

  const txs = useMemo(() => state.transactions.filter((t) => inScope(t, scope) && (!from || t.date >= from) && (!to || t.date <= to)), [state.transactions, scope, from, to]);

  const total = new Map<string, number>(), mine = new Map<string, number>(), fees = new Map<string, number>(), income = new Map<string, number>();
  const byPerson = new Map<string, Map<string, number>>();
  for (const tx of txs) {
    const e = effectsOf(tx);
    if (e.spending) addTo(total, tx.currency, e.spending);
    if (e.fee) addTo(fees, tx.currency, e.fee);
    if (e.income) addTo(income, tx.currency, e.income);
    addTo(mine, tx.currency, shareOf(tx, me.id));
    for (const s of tx.splits) {
      const k = who(s.person_id);
      if (!byPerson.has(k)) byPerson.set(k, new Map());
      addTo(byPerson.get(k)!, tx.currency, shareOf(tx, s.person_id));
    }
  }
  let homeActual = 0, homeEstimated = 0;
  const homeUnconverted = new Map<string, number>();
  for (const tx of txs) {
    if (tx.type !== 'expense' && tx.type !== 'refund') continue;
    const sign = tx.type === 'expense' ? 1 : -1;
    const v = homeValue(tx, rateCtx);
    if (!v) addTo(homeUnconverted, tx.currency, sign * tx.amount);
    else if (v.kind === 'rate') homeEstimated += sign * v.amount;
    else homeActual += sign * v.amount;
  }
  const byCategory = spendingBy(txs, (t) => t.category || 'Uncategorised');
  const byTrip = spendingBy(txs, (t) => (t.trip_id != null ? (trips.get(t.trip_id)?.name ?? '?') : 'Personal (no trip)'));
  const byMonth = spendingBy(txs, (t) => t.date.slice(0, 7));
  const byPayer = spendingBy(txs.filter((t) => t.type === 'expense' || t.type === 'refund'), (t) => who(t.payer_id));

  const exportCsv = () => {
    const head = ['id', 'date', 'type', 'description', 'category', 'trip', 'currency', 'amount', 'payer', 'payee', 'from_account', 'from_amount', 'to_account', 'to_amount', 'fee', 'settled_amount', 'settled_currency', 'linked_tx_id', 'method', 'reference', 'notes', 'splits'];
    const line = (t: Tx) => [
      t.id, t.date, t.type, t.description, t.category, t.trip_id != null ? trips.get(t.trip_id)?.name : '', t.currency, toMajor(t.amount, t.currency), who(t.payer_id), t.payee_id != null ? who(t.payee_id) : '',
      t.from_account_id != null ? accountName(t.from_account_id) : '', t.from_amount != null ? toMajor(t.from_amount, state.accounts.find((a) => a.id === t.from_account_id)?.currency ?? t.currency) : '',
      t.to_account_id != null ? accountName(t.to_account_id) : '', t.to_amount != null ? toMajor(t.to_amount, state.accounts.find((a) => a.id === t.to_account_id)?.currency ?? t.currency) : '',
      t.fee_amount != null ? toMajor(t.fee_amount, t.currency) : '', t.settled_amount != null ? toMajor(t.settled_amount, t.settled_currency ?? t.currency) : '', t.settled_currency, t.linked_tx_id, t.method, t.reference, t.notes,
      t.splits.map((s) => `${who(s.person_id)}=${toMajor(s.amount, t.currency)}`).join('; '),
    ].map(csvCell).join(',');
    download(`ledger-transactions-${new Date().toISOString().slice(0, 10)}.csv`, [head.join(','), ...txs.map(line)].join('\n'), 'text/csv');
  };
  const backup = () => run(async () => {
    try {
      const data = await api('GET', '/api/backup');
      download(`kitty-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify(data, null, 1), 'application/json');
    } catch (e) { setErr(errorText(e)); }
  });
  const restore = (file: File) => {
    if (!window.confirm('Restoring replaces EVERYTHING in this ledger with the backup. Continue?')) return;
    void run(async () => {
      try {
        await api('POST', '/api/restore', JSON.parse(await file.text()));
        await reload();
        setMsg('Backup restored.');
        setErr(null);
      } catch (e) { setErr(errorText(e)); }
      if (fileRef.current) fileRef.current.value = '';
    });
  };
  const snapshot = () => run(async () => {
    try {
      const r = await api<{ file: string }>('POST', '/api/snapshot');
      setMsg(`Database snapshot written to ${r.file}`);
      setErr(null);
    } catch (e) { setErr(errorText(e)); }
  });

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Reports & Exports</h1><div className="sub">{txs.length} transactions in range</div></div>
        <div className="row">
          <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
      </div>
      <ScopeSeg value={scope} onChange={setScope} testId="report-scope" />
      <div className="grid-4">
        <Stat label="Total spending" foot="All participants"><MoneyList map={total} empty="—" /></Stat>
        <Stat label="Your share"><MoneyList map={mine} empty="—" /></Stat>
        <Stat label="Transfer & ATM fees" foot="Kept out of spending"><MoneyList map={fees} empty="—" /></Stat>
        <Stat label="Income"><MoneyList map={income} empty="—" /></Stat>
        <Stat label={`Spending in ${rateCtx.home}`} foot={`${formatAmount(homeActual, rateCtx.home)} at real charges · ${formatAmount(homeEstimated, rateCtx.home)} at set rates${homeUnconverted.size ? ` · unconverted: ${[...homeUnconverted].map(([c, v]) => formatAmount(v, c)).join(', ')}` : ''}`} testId="home-spend">
          {formatAmount(homeActual + homeEstimated, rateCtx.home)}
        </Stat>
      </div>
      <div className="grid-2">
        <GroupTable title="By category" groups={byCategory} note="Expenses minus linked refunds." />
        <GroupTable title="By trip" groups={byTrip} />
        <GroupTable title="By month" groups={byMonth} />
        <GroupTable title="Each person's share" groups={byPerson} note="What each person consumed, regardless of who paid." />
        <GroupTable title="Paid by" groups={byPayer} note="Who fronted the money, refunds subtracted." />
      </div>
      <div className="panel">
        <div className="panel-head"><h3>Exports, backup & restore</h3></div>
        <div className="panel-body stack">
          <div className="row">
            <button onClick={exportCsv} data-testid="export-csv"><Download />CSV of this range</button>
            <button disabled={busy} onClick={() => void backup()} data-testid="download-backup">{busy ? <Spinner /> : <Download />}Full backup (JSON)</button>
            <button disabled={busy} onClick={() => void snapshot()}><Database />Snapshot database file</button>
            <label className="btn">
              <Upload />Restore from backup… <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }} disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) restore(f); }} data-testid="restore-file" />
            </label>
          </div>
          {msg && <div className="ok-box">{msg}</div>}
          <ErrorBox error={err} />
          <p className="faint small">The database is <code>data/ledger.db</code> in the project folder; copying that file is also a complete backup.</p>
        </div>
      </div>
    </div>
  );
}
