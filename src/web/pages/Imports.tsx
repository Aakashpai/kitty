import { useMemo, useState } from 'react';
import { accountEntries, formatAmount, parseAmount, type Account, type Tx, type TxInput } from '../../engine/index.ts';
import { api, errorText } from '../api.ts';
import { today, useLedger } from '../store.tsx';
import { useRoute } from '../router.tsx';
import { useTxForm } from '../components/txFormContext.ts';
import { DangerButton, Empty, ErrorBox, Field, Money, Spinner, TypeBadge, fmtDate, useBusy } from '../components/ui.tsx';
import { FileInput } from 'lucide-react';

/** Minimal RFC-4180 parser: quotes, escaped quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

type DateFmt = 'auto' | 'ymd' | 'dmy' | 'mdy';
export function parseDate(s: string, fmt: DateFmt): string | null {
  const t = s.trim();
  const pad = (n: string) => n.padStart(2, '0');
  const m = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/.exec(t);
  if (m) {
    const [, a, b, c] = m as unknown as [string, string, string, string];
    if (fmt === 'ymd' || (fmt === 'auto' && a.length === 4)) return `${a}-${pad(b)}-${pad(c)}`;
    const year = c.length === 2 ? `20${c}` : c;
    if (fmt === 'mdy') return `${year}-${pad(a)}-${pad(b)}`;
    return `${year}-${pad(b)}-${pad(a)}`; // dmy (default for auto)
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${pad(String(d.getMonth() + 1))}-${pad(String(d.getDate()))}`;
}

const dayDiff = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);

interface StmtRow { i: number; date: string | null; description: string; amount: number | null; raw: string[] }

function Reconcile({ account }: { account: Account }) {
  const { state, reload } = useLedger();
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, run] = useBusy();
  const entries = accountEntries(state.transactions, account);
  const expected = entries.length ? entries[entries.length - 1]!.balance : account.opening_balance;
  const sum = (f: (e: { tx: Tx; delta: number }) => boolean) => entries.filter(f).reduce((s, e) => s + e.delta, 0);
  const inflow = sum((e) => e.delta > 0);
  const spent = sum((e) => e.tx.type === 'expense');
  const outOther = sum((e) => e.delta < 0 && e.tx.type !== 'expense');
  const fees = entries.filter((e) => e.tx.from_account_id === account.id && e.tx.fee_amount).reduce((s, e) => s + (e.tx.fee_amount ?? 0), 0);
  const parsed = counted.trim() ? parseAmount(counted, account.currency) : null;
  const diff = parsed == null ? null : parsed - expected;
  const history = state.reconciliations.filter((r) => r.account_id === account.id);
  const save = () => {
    if (parsed == null) return setErr('Enter the amount you counted');
    void run(async () => {
      try {
        await api('POST', '/api/reconciliations', { account_id: account.id, date: today(), counted_amount: parsed, expected_amount: expected, note: note || null });
        await reload();
        setCounted('');
        setNote('');
        setErr(null);
      } catch (e) {
        setErr(errorText(e));
      }
    });
  };
  return (
    <div className="stack">
      <div className="grid-3">
        <div className="stat"><span className="label">Opening balance</span><span className="value"><Money amount={account.opening_balance} currency={account.currency} /></span></div>
        <div className="stat"><span className="label">Money in (withdrawals, repayments, refunds…)</span><span className="value"><Money amount={inflow} currency={account.currency} /></span></div>
        <div className="stat"><span className="label">Spent from here</span><span className="value"><Money amount={-spent} currency={account.currency} /></span></div>
        <div className="stat"><span className="label">Other money out (transfers, repayments{fees ? ', fees' : ''})</span><span className="value"><Money amount={-outOther} currency={account.currency} /></span></div>
        <div className="stat"><span className="label">Expected balance now</span><span className="value" data-testid="expected-balance"><Money amount={expected} currency={account.currency} /></span></div>
      </div>
      <div className="panel pad stack">
        <h3>Count what you actually have</h3>
        <div className="form-grid">
          <Field label={`Counted (${account.currency})`}><input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} data-testid="counted" /></Field>
          <Field label="Note" className="span-2"><input value={note} placeholder="Counted at the hotel, before checkout" onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
        {diff != null && (
          <div className={diff === 0 ? 'ok-box' : 'warn-box'} data-testid="discrepancy">
            {diff === 0 ? 'Matches the ledger exactly.' : diff < 0
              ? `${formatAmount(-diff, account.currency)} less than expected. Some cash spending is probably not recorded; add the expenses you remember rather than guessing a single catch-all.`
              : `${formatAmount(diff, account.currency)} more than expected. A withdrawal, repayment received or refund may be missing, or an expense was recorded against cash but paid another way.`}
          </div>
        )}
        <ErrorBox error={err} />
        <div><button className="primary" disabled={busy || parsed == null} onClick={save} data-testid="save-count">{busy ? <Spinner /> : <FileInput />}Save this count</button></div>
      </div>
      {history.length > 0 && (
        <div className="panel pad">
          <h3>Previous counts</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th className="num">Counted</th><th className="num">Expected then</th><th className="num">Difference</th><th>Note</th><th></th></tr></thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDate(r.date)}</td>
                    <td className="num"><Money amount={r.counted_amount} currency={account.currency} /></td>
                    <td className="num"><Money amount={r.expected_amount} currency={account.currency} /></td>
                    <td className="num"><Money amount={r.counted_amount - r.expected_amount} currency={account.currency} sign /></td>
                    <td>{r.note}</td>
                    <td className="right"><DangerButton confirm="Remove this count?" onConfirm={async () => { await api('DELETE', `/api/reconciliations/${r.id}`); await reload(); }}>Remove</DangerButton></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <details>
        <summary>Every movement on {account.name} ({entries.length})</summary>
        <div className="table-wrap" style={{ marginTop: 'var(--space-2)' }}>
          <table>
            <thead><tr><th>Date</th><th>Type</th><th>Description</th><th className="num">Change</th><th className="num">Balance</th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.tx.id}><td>{fmtDate(e.tx.date)}</td><td><TypeBadge type={e.tx.type} /></td><td>{e.tx.description}</td><td className="num"><Money amount={e.delta} currency={account.currency} sign /></td><td className="num"><Money amount={e.balance} currency={account.currency} /></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function ImportStatement({ account }: { account: Account }) {
  const { state, who } = useLedger();
  const openForm = useTxForm();
  const [text, setText] = useState('');
  const [hasHeader, setHasHeader] = useState(true);
  const [dateFmt, setDateFmt] = useState<DateFmt>('auto');
  const [cols, setCols] = useState({ date: 0, description: 1, amount: 2, debit: -1, credit: -1 });
  const [mode, setMode] = useState<'signed' | 'split'>('signed');
  const [window, setWindow] = useState(3);
  const [ignored, setIgnored] = useState<Set<number>>(new Set());

  const table = useMemo(() => parseCsv(text), [text]);
  const header = hasHeader ? table[0] ?? [] : [];
  const body = hasHeader ? table.slice(1) : table;
  const colNames = (table[0] ?? []).map((h, i) => (hasHeader ? h || `Column ${i + 1}` : `Column ${i + 1}`));
  const toMinor = (s: string | undefined): number | null => {
    if (!s) return null;
    const neg = /\(.*\)|-|\bDR\b/i.test(s);
    const v = parseAmount(s.replace(/[^\d.]/g, ''), account.currency);
    return v == null ? null : neg ? -v : v;
  };
  const rows: StmtRow[] = body.map((raw, i) => {
    let amount: number | null;
    if (mode === 'signed') amount = toMinor(raw[cols.amount]);
    else {
      const d = cols.debit >= 0 ? toMinor(raw[cols.debit]) : null, c = cols.credit >= 0 ? toMinor(raw[cols.credit]) : null;
      amount = d ? -Math.abs(d) : c ? Math.abs(c) : null;
    }
    return { i, date: parseDate(raw[cols.date] ?? '', dateFmt), description: raw[cols.description] ?? '', amount, raw };
  });

  const { matches, unmatchedEntries } = useMemo(() => {
    const entries = accountEntries(state.transactions, account);
    const used = new Set<number>();
    const matches = new Map<number, Tx>();
    for (const r of rows) {
      if (r.amount == null || !r.date) continue;
      const candidates = entries.filter((e) => !used.has(e.tx.id) && e.delta === r.amount && dayDiff(e.tx.date, r.date!) <= window).sort((a, b) => dayDiff(a.tx.date, r.date!) - dayDiff(b.tx.date, r.date!));
      const hit = candidates[0];
      if (hit) { used.add(hit.tx.id); matches.set(r.i, hit.tx); }
    }
    const dates = rows.map((r) => r.date).filter((d): d is string => !!d).sort();
    const lo = dates[0], hi = dates[dates.length - 1];
    const unmatchedEntries = lo && hi ? entries.filter((e) => !used.has(e.tx.id) && e.tx.date >= lo && e.tx.date <= hi) : [];
    return { matches, unmatchedEntries };
  }, [rows, state.transactions, account, window]);

  const prefill = (r: StmtRow, kind: 'expense' | 'income' | 'transfer-out' | 'transfer-in' | 'refund'): Partial<TxInput> => {
    const amount = Math.abs(r.amount ?? 0);
    const base = { date: r.date ?? today(), description: r.description.trim().slice(0, 200), currency: account.currency, amount, reference: `stmt:${r.i}` };
    switch (kind) {
      case 'expense': return { ...base, type: 'expense', payer_id: account.person_id, from_account_id: account.id, split_method: 'equal', splits: [{ person_id: account.person_id, amount, input: null }] };
      case 'income': return { ...base, type: 'income', payer_id: account.person_id, to_account_id: account.id };
      case 'refund': return { ...base, type: 'refund', payer_id: account.person_id, to_account_id: account.id, split_method: 'equal', splits: [{ person_id: account.person_id, amount, input: null }] };
      case 'transfer-out': return { ...base, type: 'transfer', payer_id: account.person_id, from_account_id: account.id };
      case 'transfer-in': return { ...base, type: 'transfer', payer_id: account.person_id, to_account_id: account.id, currency: '' , amount: 0, notes: `Received ${formatAmount(amount, account.currency)} into ${account.name}` };
    }
  };
  const pending = rows.filter((r) => !matches.has(r.i) && !ignored.has(r.i));
  const colSelect = (key: keyof typeof cols, label: string, optional = false) => (
    <Field label={label}>
      <select value={cols[key]} onChange={(e) => setCols({ ...cols, [key]: Number(e.target.value) })}>
        {optional && <option value={-1}>—</option>}
        {colNames.map((n, i) => <option key={i} value={i}>{n}</option>)}
      </select>
    </Field>
  );
  return (
    <div className="stack">
      <div className="panel pad stack">
        <p className="muted small">Paste a CSV export from your bank or card for <strong>{account.name}</strong> ({account.currency}). Rows are matched to ledger entries by amount and date; nothing is created until you choose to.</p>
        <div className="row">
          <input type="file" accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then(setText); }} data-testid="csv-file" />
          <label className="check"><input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} /> First row is a header</label>
        </div>
        <textarea rows={5} value={text} placeholder={'Date,Description,Amount\n2026-03-12,ATM CHANGI,-31250.00'} onChange={(e) => setText(e.target.value)} data-testid="csv-text" />
        {table.length > 0 && (
          <div className="form-grid">
            {colSelect('date', 'Date column')}
            {colSelect('description', 'Description column')}
            <Field label="Amount columns">
              <select value={mode} onChange={(e) => setMode(e.target.value as 'signed' | 'split')}>
                <option value="signed">One signed amount column</option>
                <option value="split">Separate debit / credit columns</option>
              </select>
            </Field>
            {mode === 'signed' ? colSelect('amount', 'Amount column') : <>{colSelect('debit', 'Debit column', true)}{colSelect('credit', 'Credit column', true)}</>}
            <Field label="Date format">
              <select value={dateFmt} onChange={(e) => setDateFmt(e.target.value as DateFmt)}>
                <option value="auto">Auto (ISO or day/month/year)</option>
                <option value="ymd">YYYY-MM-DD</option>
                <option value="dmy">DD/MM/YYYY</option>
                <option value="mdy">MM/DD/YYYY</option>
              </select>
            </Field>
            <Field label="Date tolerance (days)"><input type="number" min={0} max={14} value={window} onChange={(e) => setWindow(Number(e.target.value) || 0)} /></Field>
          </div>
        )}
      </div>
      {rows.length > 0 && (
        <>
          <div className="row">
            <span className="ok-box">{matches.size} matched</span>
            <span className={pending.length ? 'warn-box' : 'ok-box'}>{pending.length} to resolve</span>
            {ignored.size > 0 && <span className="muted small">{ignored.size} ignored</span>}
          </div>
          <div className="panel table-wrap">
            <table data-testid="import-rows">
              <thead><tr><th>Statement date</th><th>Description</th><th className="num">Amount</th><th>Ledger</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const m = matches.get(r.i);
                  const ign = ignored.has(r.i);
                  return (
                    <tr key={r.i} style={{ opacity: ign ? 0.5 : 1 }}>
                      <td className="nowrap">{r.date ?? <span className="error-box">bad date: {r.raw[cols.date]}</span>}</td>
                      <td>{r.description}</td>
                      <td className="num">{r.amount == null ? <span className="muted">?</span> : <Money amount={r.amount} currency={account.currency} sign />}</td>
                      <td>{m ? <span className="small"><TypeBadge type={m.type} /> {m.description} · {fmtDate(m.date)}</span> : ign ? <span className="muted">ignored</span> : <span className="muted">not in ledger</span>}</td>
                      <td className="right">
                        {!m && !ign && r.amount != null && r.amount < 0 && <><button className="small" onClick={() => openForm({ initial: prefill(r, 'expense') })}>Expense</button> <button className="small" onClick={() => openForm({ initial: prefill(r, 'transfer-out') })}>Transfer out</button> </>}
                        {!m && !ign && r.amount != null && r.amount > 0 && <><button className="small" onClick={() => openForm({ initial: prefill(r, 'income') })}>Income</button> <button className="small" onClick={() => openForm({ initial: prefill(r, 'refund') })}>Refund</button> </>}
                        {!m && <button className="small" onClick={() => setIgnored((s) => { const n = new Set(s); if (n.has(r.i)) n.delete(r.i); else n.add(r.i); return n; })}>{ign ? 'Unignore' : 'Ignore'}</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {unmatchedEntries.length > 0 && (
            <div className="panel pad">
              <h3>In the ledger but not on the statement</h3>
              <p className="muted small">Recorded against {account.name} in the statement’s date range without a matching row. Maybe paid another way, or still pending at the bank.</p>
              <div className="table-wrap">
                <table>
                  <tbody>
                    {unmatchedEntries.map((e) => (
                      <tr key={e.tx.id}><td>{fmtDate(e.tx.date)}</td><td><TypeBadge type={e.tx.type} /></td><td>{e.tx.description} <span className="muted small">{who(e.tx.payer_id)}</span></td><td className="num"><Money amount={e.delta} currency={account.currency} sign /></td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
      {header.length > 0 && rows.length === 0 && <Empty title="No data rows found" />}
    </div>
  );
}

export function Imports() {
  const { ownAccounts } = useLedger();
  const { id, path } = useRoute();
  const cashFirst = [...ownAccounts].filter((a) => !a.archived).sort((a, b) => (a.type === 'cash' ? -1 : 1) - (b.type === 'cash' ? -1 : 1));
  const [accountId, setAccountId] = useState<number | null>(id ?? cashFirst[0]?.id ?? null);
  const [tab, setTab] = useState<'reconcile' | 'import'>(path.endsWith('/import') ? 'import' : 'reconcile');
  const account = accountId != null ? ownAccounts.find((a) => a.id === accountId) : undefined;
  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Imports & Reconciliation</h1><div className="sub">Compare what the ledger expects with what you actually have</div></div>
        <Field label="Account">
          <select value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)} data-testid="recon-account">
            {ownAccounts.length === 0 && <option value="">No accounts yet</option>}
            {cashFirst.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currency}{a.type === 'cash' ? ', cash' : ''})</option>)}
          </select>
        </Field>
      </div>
      <div className="tabs">
        <button className={tab === 'reconcile' ? 'on' : ''} onClick={() => setTab('reconcile')} data-testid="tab-reconcile">Cash & account reconciliation</button>
        <button className={tab === 'import' ? 'on' : ''} onClick={() => setTab('import')} data-testid="tab-import">Statement import</button>
      </div>
      {!account ? <Empty title="No accounts yet">Add an account under Accounts & Cash first.</Empty> : tab === 'reconcile' ? <Reconcile account={account} /> : <ImportStatement account={account} />}
    </div>
  );
}
