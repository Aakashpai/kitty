import { useEffect, useState } from 'react';
import { ArrowRightLeft, ChartColumn, FileInput, LayoutGrid, LogOut, Moon, Plane, Plus, Scale, Sun, Users, Wallet, type LucideIcon } from 'lucide-react';
import type { TxInput, Tx } from '../engine/index.ts';
import { LedgerProvider, useLedger } from './store.tsx';
import { useRoute } from './router.tsx';
import { TxForm } from './components/TxForm.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { Overview } from './pages/Overview.tsx';
import { Trips } from './pages/Trips.tsx';
import { Transactions } from './pages/Transactions.tsx';
import { People } from './pages/People.tsx';
import { Accounts } from './pages/Accounts.tsx';
import { Balances } from './pages/Balances.tsx';
import { Imports } from './pages/Imports.tsx';
import { Reports } from './pages/Reports.tsx';
import { InviteAccept } from './pages/Auth.tsx';
import { SharedPage } from './pages/Shared.tsx';
import { TxFormCtx, type OpenTxForm } from './components/txFormContext.ts';
import { APP_NAME, Avatar, Logo, hueStyle } from './components/ui.tsx';
import { AccountModal } from './components/AccountModal.tsx';

const NAV: [string, string, LucideIcon][] = [
  ['', 'Overview', LayoutGrid],
  ['trips', 'Trips & Groups', Plane],
  ['transactions', 'Transactions', ArrowRightLeft],
  ['people', 'People', Users],
  ['accounts', 'Accounts & Cash', Wallet],
  ['balances', 'Balances & Settlement', Scale],
  ['imports', 'Imports & Reconciliation', FileInput],
  ['reports', 'Reports & Exports', ChartColumn],
];

const useTheme = () => {
  const [theme, setTheme] = useState(() => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('theme', theme); } catch { /* private mode */ }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))] as const;
};

function Shell() {
  const { section, id, path } = useRoute();
  const { state, user, logout } = useLedger();
  const [theme, toggleTheme] = useTheme();
  const [form, setForm] = useState<{ initial?: Partial<TxInput>; existing?: Tx; onSaved?: (tx: Tx) => void } | null>(null);
  const [account, setAccount] = useState(false);
  const open: OpenTxForm = (opts = {}) => setForm(opts);

  // "N" opens the form from anywhere, unless the user is typing or a dialog is already up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== 'n' || e.metaKey || e.ctrlKey || e.altKey || form || document.querySelector('.modal-backdrop')) return;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      e.preventDefault();
      setForm({});
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [form]);

  const page = (() => {
    switch (section) {
      case 'trips': return <Trips id={id} creating={path === '/trips/new'} />;
      case 'transactions': return <Transactions />;
      case 'people': return <People />;
      case 'accounts': return <Accounts id={id} />;
      case 'balances': return <Balances />;
      case 'imports': return <Imports />;
      case 'reports': return <Reports />;
      default: return <Overview />;
    }
  })();
  const trips = state.trips.filter((t) => !t.archived);
  return (
    <TxFormCtx.Provider value={open}>
      <div className="app">
        <aside className="sidebar">
          <a className="brand" href="#/"><span className="mark"><Logo size={16} /></span><span>{APP_NAME}</span></a>
          <nav className="nav" aria-label="Sections">
            {NAV.map(([p, label, I]) => (
              <a key={p} href={`#/${p}`} className={section === p ? 'active' : ''} title={label} aria-label={label}><I /><span className="label">{label}</span></a>
            ))}
          </nav>
          <div className="nav-label">Trips <a href="#/trips/new" title="New trip" aria-label="New trip"><Plus /></a></div>
          <nav className="nav" aria-label="Trips">
            {trips.map((t) => (
              <a key={t.id} href={`#/trips/${t.id}`} className={`trip-link ${section === 'trips' && id === t.id ? 'active' : ''}`} style={hueStyle(t.id)}>
                <span className="dot"><i /></span><span className="name">{t.name}</span>
              </a>
            ))}
            {trips.length === 0 && <span className="faint small trip-link" style={{ padding: '4px 10px' }}>No trips yet</span>}
          </nav>
          <div className="sidebar-foot">
            <button className="primary add-side" onClick={() => open()} data-testid="add-transaction"><Plus />Add transaction</button>
            <span className="shortcut">Press <kbd className="kbd">N</kbd> to add</span>
            <button className="ghost theme-toggle" onClick={toggleTheme} aria-label="Toggle theme" data-testid="theme-toggle">
              {theme === 'dark' ? <Sun /> : <Moon />}<span className="label">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
            </button>
            {user && (
              <div className="user-block" data-testid="user-block">
                <Avatar id={user.person_id ?? 0} name={user.name} small />
                <button type="button" className="info" onClick={() => setAccount(true)} title="Account settings" data-testid="account-button"><div>{user.name}</div><div className="faint small">{user.email}</div></button>
                <button className="ghost icon small" onClick={() => void logout()} title="Sign out" aria-label="Sign out" data-testid="logout"><LogOut /></button>
              </div>
            )}
          </div>
        </aside>
        <main className="main">{page}</main>
        <button className="primary fab" onClick={() => open()} aria-label="Add transaction"><Plus />Add</button>
      </div>
      {account && <AccountModal onClose={() => setAccount(false)} />}
      {form && (
        <TxForm
          initial={form.initial}
          existing={form.existing}
          onClose={() => setForm(null)}
          onSaved={(tx) => {
            setForm(null);
            form.onSaved?.(tx);
          }}
        />
      )}
    </TxFormCtx.Provider>
  );
}

export function App() {
  const { section, parts } = useRoute();
  if (section === 'invite' && parts[1]) return <ErrorBoundary><InviteAccept token={parts[1]} /></ErrorBoundary>;
  if (section === 's' && parts[1]) return <ErrorBoundary><SharedPage token={parts[1]} /></ErrorBoundary>;
  return (
    <ErrorBoundary>
      <LedgerProvider>
        <Shell />
      </LedgerProvider>
    </ErrorBoundary>
  );
}
