import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowRightLeft, Banknote, BedDouble, Gift, HandCoins, HeartPulse, Plane, Receipt, ShoppingBag, ShoppingCart, Tag, Ticket, TrendingUp, Undo2, Utensils, Wine, X, Zap, type LucideIcon } from 'lucide-react';
import { formatAmount, type TxType } from '../../engine/index.ts';

/** Kitty's mark: a coin with ears. Inherits currentColor; eyes use --logo-eye (defaults to the primary surface). */
export const Logo = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable="false">
    <path d="M7 12 L9 3 L15 9 Q16 8.6 17 9 L23 3 L25 12 A10 10 0 1 1 7 12 Z" fill="currentColor" />
    <circle cx="12.5" cy="17.5" r="1.7" fill="var(--logo-eye, var(--primary))" />
    <circle cx="19.5" cy="17.5" r="1.7" fill="var(--logo-eye, var(--primary))" />
  </svg>
);
export const APP_NAME = 'Kitty';

export const Spinner = () => <span className="spinner" aria-hidden />;

/**
 * Guards an async action: while it runs, `busy` is true and further calls are ignored,
 * so a double tap can never submit twice.
 */
export function useBusy(): [boolean, <T>(fn: () => Promise<T>) => Promise<T | undefined>] {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (lock.current) return undefined;
    lock.current = true;
    setBusy(true);
    try {
      return await fn();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }, []);
  return [busy, run];
}

export const TYPE_LABEL: Record<TxType, string> = { expense: 'Expense', transfer: 'Transfer', withdrawal: 'Cash withdrawal', repayment: 'Repayment', income: 'Income', refund: 'Refund' };
export const TYPE_ICON: Record<TxType, LucideIcon> = { expense: Receipt, transfer: ArrowRightLeft, withdrawal: Banknote, repayment: HandCoins, income: TrendingUp, refund: Undo2 };

// Icon and fixed hue per category, so Food is always the same orange fork and knife; Expenses and custom ones stay neutral.
const CATEGORY_LOOK: Record<string, [LucideIcon, number | null]> = {
  Food: [Utensils, 24], Drinks: [Wine, 330], Groceries: [ShoppingCart, 95], Travel: [Plane, 205], Stay: [BedDouble, 250],
  Shopping: [ShoppingBag, 285], Activities: [Ticket, 160], Health: [HeartPulse, 355], Bills: [Zap, 45], Gifts: [Gift, 310], Expenses: [Receipt, null],
};
const lookOf = (category: string | null | undefined) => CATEGORY_LOOK[category || 'Expenses'] ?? [Tag, null];
const hue = (h: number | null) => (h == null ? undefined : ({ '--h': h }) as CSSProperties);

/** Inline category glyph, tinted with the category's hue (for chips and table rows). */
export const CategoryGlyph = ({ category }: { category: string | null | undefined }) => {
  const [I, h] = lookOf(category);
  return <I className={`cat-glyph${h == null ? '' : ' tint'}`} style={hue(h)} aria-hidden />;
};

/** Square tile for a row: expenses show their category, everything else its type. */
export const TypeIcon = ({ type, category, small = false }: { type: TxType; category?: string | null; small?: boolean }) => {
  const [I, h] = type === 'expense' ? lookOf(category) : [TYPE_ICON[type], null];
  return <span className={`ticon ${h == null ? type : 'cat'} ${small ? 'sm' : ''}`} style={hue(h)} aria-hidden><I /></span>;
};
export const TypeBadge = ({ type }: { type: TxType }) => {
  const I = TYPE_ICON[type];
  return <span className={`badge type-${type}`}><I />{TYPE_LABEL[type]}</span>;
};

// Country names come from the browser (Intl), so there is no list to keep; only short forms people type are added here.
const ALIASES: Record<string, string> = { usa: 'US', uk: 'GB', uae: 'AE', england: 'GB', scotland: 'GB', wales: 'GB', turkey: 'TR', 'czech republic': 'CZ', holland: 'NL', macau: 'MO', 'ivory coast': 'CI' };
let countries: { re: RegExp; codes: Map<string, string> } | null = null;
const countryIndex = () => {
  const dn = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
  const codes = new Map(Object.entries(ALIASES));
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b), name = dn.of(code);
    if (!name || name === code || /unknown|world|europe|nations|outlying|pseudo/i.test(name)) continue;
    for (const n of [name, name.replace(/\s*\(.*\)|\s+SAR China/g, ''), /\((.*)\)/.exec(name)?.[1]]) if (n) codes.set(n.toLowerCase(), code);
  }
  // Longest first so "South Sudan" beats "Sudan"; letters on either side rule out "Oman" inside "Romania".
  const alts = [...codes.keys()].sort((x, y) => y.length - x.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return { re: new RegExp(`(?<!\\p{L})(${alts.join('|')})(?!\\p{L})`, 'iu'), codes };
};
/** "Singapore 2026" -> 🇸🇬; null when the name has no country in it. */
export const flagOf = (name: string): string | null => {
  countries ??= countryIndex();
  const code = countries.codes.get(countries.re.exec(name)?.[1]?.toLowerCase() ?? '');
  return code ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0))) : null;
};
/** A trip's mark: its country's flag when the name has one, otherwise the coloured dot passed in. */
export const TripMark = ({ name, children }: { name: string; children: ReactNode }) => {
  const flag = flagOf(name);
  return flag ? <span className="flag" aria-hidden>{flag}</span> : <>{children}</>;
};

/** Spent against a budget: a bar that turns red past 100%, then what is left (or how far over). */
export const BudgetBar = ({ spent, limit, currency }: { spent: number; limit: number; currency: string }) => (
  <span className="budget" data-testid="budget-bar">
    <span className={`meter${spent > limit ? ' over' : ''}`}><i style={{ width: `${Math.min(100, (Math.max(spent, 0) / limit) * 100)}%` }} /></span>
    <span className={`small ${spent > limit ? 'neg' : 'faint'}`}>{spent > limit ? `${formatAmount(spent - limit, currency)} over` : `${formatAmount(limit - spent, currency)} left`} · budget {formatAmount(limit, currency)}</span>
  </span>
);

/** Stable hue per entity id, so a person or trip keeps its colour everywhere. */
export const hueOf = (id: number) => Math.round((id * 137.508) % 360);
export const hueStyle = (id: number) => ({ '--h': hueOf(id) }) as CSSProperties;
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';
export const Avatar = ({ id, name, small = false }: { id: number; name: string; small?: boolean }) => (
  <span className={`avatar ${small ? 'sm' : ''}`} style={hueStyle(id)} title={name} aria-hidden>{initials(name)}</span>
);

export const Money = ({ amount, currency, sign = false }: { amount: number; currency: string; sign?: boolean }) => (
  <span className={`money ${amount < 0 ? 'neg' : amount > 0 && sign ? 'pos' : ''}`}>{(sign && amount > 0 ? '+' : '') + formatAmount(amount, currency)}</span>
);

/** Renders a per-currency map as a compact list. */
export const MoneyList = ({ map, sign = false, empty = '—' }: { map: Map<string, number> | [string, number][]; sign?: boolean; empty?: string }) => {
  const entries = (map instanceof Map ? [...map] : map).filter(([, v]) => v !== 0).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return <span className="faint">{empty}</span>;
  return (
    <span className="money-list">
      {entries.map(([c, v]) => <Money key={c} amount={v} currency={c} sign={sign} />)}
    </span>
  );
};

export const Stat = ({ label, icon: I, children, foot, testId }: { label: string; icon?: LucideIcon; children: ReactNode; foot?: ReactNode; testId?: string }) => (
  <div className="stat" data-testid={testId}>
    <span className="label">{I && <I />}{label}</span>
    <span className="value">{children}</span>
    {foot && <span className="foot">{foot}</span>}
  </div>
);

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="ghost icon" onClick={onClose} aria-label="Close"><X /></button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export const Field = ({ label, children, hint, className = '' }: { label: string; children: ReactNode; hint?: string; className?: string }) => (
  <label className={`field ${className}`}>
    <span className="field-label">{label}</span>
    {children}
    {hint && <span className="hint">{hint}</span>}
  </label>
);

export const ErrorBox = ({ error }: { error: string | null }) => (error ? <div className="error-box" role="alert">{error}</div> : null);

export const Empty = ({ title, children }: { title?: string; children?: ReactNode }) => (
  <div className="empty">{title && <strong>{title}</strong>}{children}</div>
);

/** Confirm-then-run button; shows the error inline if the action fails. */
export function DangerButton({ onConfirm, confirm, children, small = true }: { onConfirm: () => Promise<void>; confirm: string; children: ReactNode; small?: boolean }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, run] = useBusy();
  return (
    <span className="danger-wrap">
      <button
        className={`danger ${small ? 'small' : ''}`}
        disabled={busy}
        onClick={() => {
          if (busy || !window.confirm(confirm)) return;
          void run(async () => {
            try {
              await onConfirm();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            }
          });
        }}
      >
        {busy && <Spinner />}{children}
      </button>
      <ErrorBox error={err} />
    </span>
  );
}

export const fmtDate = (d: string | null | undefined) => (d ? new Date(d + (d.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const fmtShort = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
export const fmtWhen = (iso: string) => new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
