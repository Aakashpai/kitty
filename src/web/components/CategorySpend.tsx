import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, HandCoins, Undo2 } from 'lucide-react';
import { homeSpendingBy, type Id, type Tx } from '../../engine/index.ts';
import { CATEGORIES, categoryOf, useLedger } from '../store.tsx';
import { CategoryGlyph, MoneyList } from './ui.tsx';

/** A picked row of the table: its label and which entries sit behind it. */
export interface CategoryPick {
  label: string;
  match: (t: Tx) => boolean;
}

const REFUNDS = 'Refunds';
// Refunds get their own row (money back, negative) instead of quietly netting inside a category.
const spendKey = (t: Tx) => (t.type === 'refund' ? REFUNDS : categoryOf(t));
const rank = (c: string) => {
  const i = CATEGORIES.indexOf(c);
  return c === REFUNDS ? CATEGORIES.length + 1 : i < 0 ? CATEGORIES.length : i;
};
const sum = (groups: Map<string, Map<string, number>>) => {
  const t = new Map<string, number>();
  for (const m of groups.values()) for (const [cur, v] of m) t.set(cur, (t.get(cur) ?? 0) + v);
  return t;
};

/**
 * Spending per category in the home currency (everyone's total, one person's share, or both), refunds as their own
 * row, then repayments below the total in the currency that changed hands. Selecting a row picks it (again to clear),
 * so the caller can list the entries behind it. `compact` opens on the total alone, with the breakdown one tap away.
 */
export function CategorySpend({ txs, person, label = 'You', everyone = true, compact = false, selected, onSelect }: {
  txs: Tx[];
  person?: Id;
  label?: string;
  everyone?: boolean;
  compact?: boolean;
  selected: string | null;
  onSelect: (pick: CategoryPick | null) => void;
}) {
  const { rateCtx } = useLedger();
  const [open, setOpen] = useState(!compact);
  const toggle = () => {
    if (open && selected) onSelect(null); // closing must not leave the entries list filtered by a hidden row
    setOpen(!open);
  };
  const all = homeSpendingBy(txs, rateCtx, spendKey);
  const mine = person != null ? homeSpendingBy(txs, rateCtx, spendKey, person) : null;
  const shown = everyone || !mine ? all : mine;
  const cats = [...shown].filter(([, m]) => [...m.values()].some((v) => v !== 0)).map(([c]) => c).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const repaid = (pick: (t: Tx) => boolean) => {
    const m = new Map<string, number>();
    for (const t of txs) if (t.type === 'repayment' && pick(t)) m.set(t.currency, (m.get(t.currency) ?? 0) + t.amount);
    return m;
  };
  const isRepayment = (t: Tx) => t.type === 'repayment';
  const repayRows: { label: string; match: (t: Tx) => boolean; all?: Map<string, number>; mine?: Map<string, number> }[] = mine
    ? [
        { label: 'Repayments paid', match: (t) => isRepayment(t) && t.payer_id === person, all: everyone ? repaid(isRepayment) : undefined, mine: repaid((t) => t.payer_id === person) },
        { label: 'Repayments received', match: (t) => isRepayment(t) && t.payee_id === person, mine: repaid((t) => t.payee_id === person) },
      ]
    : [{ label: 'Repayments', match: isRepayment, all: repaid(isRepayment) }];
  const visible = repayRows.filter((r) => [r.all, r.mine].some((m) => m && [...m.values()].some((v) => v !== 0)));
  const pick = (p: CategoryPick) => onSelect(selected === p.label ? null : p);
  const cell = (m?: Map<string, number>) => <MoneyList map={m ?? new Map()} />;
  const row = (p: CategoryPick, icon: ReactNode, a?: Map<string, number>, b?: Map<string, number>) => (
    <tr key={p.label} className={`clickable ${selected === p.label ? 'on' : ''}`} tabIndex={0} role="button" aria-pressed={selected === p.label} onClick={() => pick(p)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(p); } }} data-testid={`category-${p.label}`}>
      <td><span className="who">{icon}{p.label}</span></td>
      {everyone && <td className="num">{cell(a)}</td>}
      {mine && <td className="num">{cell(b)}</td>}
    </tr>
  );
  if (!cats.length && !visible.length) return <div className="panel"><div className="panel-body faint small">Nothing spent yet.</div></div>;
  return (
    <div className="panel" data-testid="category-spend">
      <div className="table-wrap">
        <table>
          <thead><tr><th>Category</th>{everyone && <th className="num">Everyone</th>}{mine && <th className="num">{label}</th>}</tr></thead>
          <tbody>
            {open && cats.map((c) => row({ label: c, match: (t) => (t.type === 'expense' || t.type === 'refund') && spendKey(t) === c }, c === REFUNDS ? <Undo2 className="cat-glyph" aria-hidden /> : <CategoryGlyph category={c} />, all.get(c), mine?.get(c)))}
          </tbody>
          <tfoot>
            <tr><td>Total spent</td>{everyone && <td className="num">{cell(sum(all))}</td>}{mine && <td className="num" data-testid="category-mine-total">{cell(sum(mine))}</td>}</tr>
            {open && visible.map((r) => row(r, <HandCoins className="cat-glyph" aria-hidden />, r.all, r.mine))}
          </tfoot>
        </table>
      </div>
      {(open || compact) && (
        <div className="panel-foot row between">
          {open && <span>Spending in {rateCtx.home}: card spends as charged, cash at the trip or default rate. Repayments aren’t spending and show in the currency paid. Tap a row to see its entries.</span>}
          {compact && <button className="ghost small" onClick={toggle} aria-expanded={open} data-testid="category-toggle">{open ? <ChevronUp /> : <ChevronDown />}{open ? 'Hide breakdown' : 'Show breakdown'}</button>}
        </div>
      )}
    </div>
  );
}
