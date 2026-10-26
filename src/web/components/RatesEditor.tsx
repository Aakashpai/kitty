import { useState } from 'react';
import { Plus, X } from 'lucide-react';
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
export function RatesEditor({ value, onChange, home, testId }: { value: Record<string, number> | null; onChange: (v: Record<string, number> | null) => void; home: string; testId?: string }) {
  const [rows, setRows] = useState<Row[]>(() => Object.entries(value ?? {}).map(([cur, rate]) => ({ cur, rate: String(rate) })));
  const update = (next: Row[]) => {
    setRows(next);
    onChange(toMap(next));
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
      <div><button type="button" className="small" onClick={() => update([...rows, { cur: '', rate: '' }])}><Plus />Add currency</button></div>
    </div>
  );
}
