import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowRightLeft, Banknote, HandCoins, Receipt, TrendingUp, Undo2, X, type LucideIcon } from 'lucide-react';
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

export const TypeIcon = ({ type, small = false }: { type: TxType; small?: boolean }) => {
  const I = TYPE_ICON[type];
  return <span className={`ticon ${type} ${small ? 'sm' : ''}`} aria-hidden><I /></span>;
};
export const TypeBadge = ({ type }: { type: TxType }) => {
  const I = TYPE_ICON[type];
  return <span className={`badge type-${type}`}><I />{TYPE_LABEL[type]}</span>;
};

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
