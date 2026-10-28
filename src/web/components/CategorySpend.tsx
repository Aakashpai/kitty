import { formatAmount, homeSpendingBy, type Id, type Tx } from '../../engine/index.ts';
import { CATEGORIES, categoryOf, useLedger } from '../store.tsx';
import { MoneyList } from './ui.tsx';

/** Spending entries (expenses and refunds) in one category. */
export const inCategory = (t: Tx, cat: string) => (t.type === 'expense' || t.type === 'refund') && categoryOf(t) === cat;

const rank = (c: string) => {
  const i = CATEGORIES.indexOf(c);
  return i < 0 ? CATEGORIES.length : i;
};
const sum = (groups: Map<string, Map<string, number>>) => {
  const t = new Map<string, number>();
  for (const m of groups.values()) for (const [cur, v] of m) t.set(cur, (t.get(cur) ?? 0) + v);
  return t;
};

/**
 * Spending per category in the home currency: everyone's total, one person's share, or both.
 * Selecting a row picks that category (again to clear), so the caller can list its entries.
 */
export function CategorySpend({ txs, person, label = 'You', everyone = true, selected, onSelect }: {
  txs: Tx[];
  person?: Id;
  label?: string;
  everyone?: boolean;
  selected: string | null;
  onSelect: (cat: string | null) => void;
}) {
  const { rateCtx } = useLedger();
  const all = homeSpendingBy(txs, rateCtx, categoryOf);
  const mine = person != null ? homeSpendingBy(txs, rateCtx, categoryOf, person) : null;
  const shown = everyone || !mine ? all : mine;
  const cats = [...shown].filter(([, m]) => [...m.values()].some((v) => v !== 0)).map(([c]) => c).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const pick = (c: string) => onSelect(selected === c ? null : c);
  // The table is in the home currency, so a plain home amount drops its code (keeps three columns on a phone); leftovers with no rate keep theirs.
  const cell = (m: Map<string, number> = new Map()) => {
    if ([...m].some(([cur, v]) => cur !== rateCtx.home && v !== 0)) return <MoneyList map={m} />;
    const v = m.get(rateCtx.home) ?? 0;
    return v ? <span className={`money ${v < 0 ? 'neg' : ''}`}>{formatAmount(v, rateCtx.home, false)}</span> : <span className="faint">—</span>;
  };
  if (!cats.length) return <div className="panel"><div className="panel-body faint small">Nothing spent yet.</div></div>;
  return (
    <div className="panel" data-testid="category-spend">
      <div className="table-wrap">
        <table>
          <thead><tr><th>Category · {rateCtx.home}</th>{everyone && <th className="num">Everyone</th>}{mine && <th className="num">{label}</th>}</tr></thead>
          <tbody>
            {cats.map((c) => (
              <tr key={c} className={`clickable ${selected === c ? 'on' : ''}`} tabIndex={0} role="button" aria-pressed={selected === c} onClick={() => pick(c)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(c); } }} data-testid={`category-${c}`}>
                <td>{c}</td>
                {everyone && <td className="num">{cell(all.get(c))}</td>}
                {mine && <td className="num">{cell(mine.get(c))}</td>}
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td>Total</td>{everyone && <td className="num">{cell(sum(all))}</td>}{mine && <td className="num" data-testid="category-mine-total">{cell(sum(mine))}</td>}</tr></tfoot>
        </table>
      </div>
      <div className="panel-foot">Card spends as charged in {rateCtx.home}, cash at the trip or default rate. Tap a category to see its entries.</div>
    </div>
  );
}
