import { useState } from 'react';
import { Plus, RefreshCw, X } from 'lucide-react';
import { COMMON_CURRENCIES } from '../store.tsx';

interface Row { cur: string; rate: string }
const toMap = (rows: Row[]): Record<string, number> | null => {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const c = r.cur.trim().toUpperCase(), n = Number(r.rate);
    if (/^[A-Z]{3}$/.test(c) && Number.isFinite(n) && n > 0) out[c] = n;
  }
  return Object.keys(out).length ? out : null;
};

/** "1 SGD = ₹75" rows. Only complete, valid rows reach onChange. */
export function RatesEditor({ value, onChange, home, suggest = [], testId }: { value: Record<string, number> | null; onChange: (v: Record<string, number> | null) => void; home: string; suggest?: string[]; testId?: string }) {
  const [rows, setRows] = useState<Row[]>(() => Object.entries(value ?? {}).map(([cur, rate]) => ({ cur, rate: String(rate) })));
  const [note, setNote] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const update = (next: Row[]) => {
    setRows(next);
    onChange(toMap(next));
  };
  // Today's market rate for each listed currency (or the suggested ones when the list is empty). Free, no key, CORS-enabled.
  const fill = async () => {
    setFetching(true);
    try {
      const d = (await (await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(home)}`)).json()) as { result?: string; rates?: Record<string, number>; time_last_update_utc?: string };
      const rates = d.result === 'success' ? d.rates : undefined;
      if (!rates) throw new Error('Rates are unavailable right now. Try again later.');
      const listed = rows.map((r) => r.cur.trim().toUpperCase()).filter((c) => /^[A-Z]{3}$/.test(c));
      const codes = [...new Set(listed.length ? listed : suggest)].filter((c) => c !== home && rates[c]);
      if (!codes.length) throw new Error(`Add a currency first, then fill its rate against ${home}.`);
      const filled = codes.map((c) => ({ cur: c, rate: String(Number((1 / rates[c]!).toPrecision(5))) }));
      update([...filled, ...rows.filter((r) => !codes.includes(r.cur.trim().toUpperCase()))]);
      setNote(`Market rates from ExchangeRate-API, updated ${d.time_last_update_utc?.slice(5, 16) ?? 'today'}. Card charges recorded in ${home} still count as charged.`);
    } catch (e) {
      setNote(e instanceof Error && !/fetch/i.test(e.message) ? e.message : 'Could not reach the rates service. Check the connection and try again.');
    } finally {
      setFetching(false);
    }
  };
  return (
    <div className="stack tight" data-testid={testId}>
      {rows.map((r, i) => (
        <div key={i} className="rates-row">
          <span className="faint small">1</span>
          <input list="currencies" value={r.cur} maxLength={3} placeholder="SGD" aria-label="Currency" onChange={(e) => update(rows.map((x, j) => (j === i ? { ...x, cur: e.target.value.toUpperCase() } : x)))} />
          <span className="faint small">=</span>
          <input inputMode="decimal" value={r.rate} placeholder="75" aria-label={`${home} per unit`} onChange={(e) => update(rows.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))} />
          <span className="faint small">{home}</span>
          <button type="button" className="ghost icon small" aria-label="Remove rate" onClick={() => update(rows.filter((_, j) => j !== i))}><X /></button>
        </div>
      ))}
      <datalist id="currencies">{COMMON_CURRENCIES.map((c) => <option key={c} value={c} />)}</datalist>
      <div className="row">
        <button type="button" className="small" onClick={() => update([...rows, { cur: '', rate: '' }])}><Plus />Add currency</button>
        <button type="button" className="small" disabled={fetching} onClick={() => void fill()} data-testid="fill-rates"><RefreshCw />{fetching ? 'Fetching…' : 'Fill today’s rates'}</button>
      </div>
      {note && <span className="hint">{note}</span>}
    </div>
  );
}
