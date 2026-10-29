import { useEffect, useState, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { ArrowRightLeft, ChartColumn, FileInput, FolderLock, LayoutGrid, LogOut, Moon, Menu, Plane, Plus, Scale, Smartphone, Sun, Users, Wallet, X, type LucideIcon } from 'lucide-react';
import { parseReceipt, type Trip, type TxInput, type Tx } from '../engine/index.ts';
import { dropQueued, flushQueue, queued } from './api.ts';
import { LedgerProvider, guessCategory, useLedger } from './store.tsx';
import { navigate, useRoute } from './router.tsx';
import { TxForm } from './components/TxForm.tsx';
import { QuickAdd, liveTrip, localToday } from './components/QuickAdd.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { Overview } from './pages/Overview.tsx';
import { Trips } from './pages/Trips.tsx';
import { Transactions } from './pages/Transactions.tsx';
import { People, PersonView } from './pages/People.tsx';
import { Accounts } from './pages/Accounts.tsx';
import { Balances } from './pages/Balances.tsx';
import { Imports } from './pages/Imports.tsx';
import { Reports } from './pages/Reports.tsx';
import { InviteAccept } from './pages/Auth.tsx';
import { SharedPage } from './pages/Shared.tsx';
import { SimpleView } from './pages/Simple.tsx';
import { Docs } from './pages/Docs.tsx';
import { DocsShared } from './pages/DocsShared.tsx';
import { forgetMaster } from './vault.ts';
import { TxFormCtx, useTxForm, type OpenTxForm } from './components/txFormContext.ts';
import { APP_NAME, Avatar, Logo, TripMark, hueStyle } from './components/ui.tsx';
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
  ['docs', 'Documents', FolderLock],
];

const useTheme = () => {
  const [theme, setTheme] = useState(() => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('theme', theme); } catch { /* private mode */ }
  }, [theme]);
  // The new theme spreads as a circle from where the toggle was pressed (centre of the button from the keyboard).
  const toggle = (e: MouseEvent<HTMLElement>) => {
    const next = theme === 'dark' ? 'light' : 'dark';
    const apply = () => { document.documentElement.dataset.theme = next; flushSync(() => setTheme(next)); };
    if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return apply();
    const b = e.currentTarget.getBoundingClientRect();
    const x = e.detail ? e.clientX : b.left + b.width / 2, y = e.detail ? e.clientY : b.top + b.height / 2;
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    void document.startViewTransition(apply).ready.then(() =>
      document.documentElement.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] }, { duration: 500, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' }),
    ).catch(() => undefined);
  };
  return [theme, toggle] as const;
};

/** "Simple view": one phone-friendly page instead of the full app. Off by default; remembered per device. */
const useSimple = () => {
  const [simple, setSimple] = useState(() => { try { return localStorage.getItem('view-mode') === 'simple'; } catch { return false; } });
  const toggle = () => setSimple((s) => { try { localStorage.setItem('view-mode', s ? 'full' : 'simple'); } catch { /* private mode */ } return !s; });
  return [simple, toggle] as const;
};

function Shell() {
  const { section, id, path } = useRoute();
  const { state, user, logout, owner, me } = useLedger();
  const [quick, setQuick] = useState<Trip | null>(null);
  const [theme, toggleTheme] = useTheme();
  const [form, setForm] = useState<{ initial?: Partial<TxInput>; existing?: Tx; onSaved?: (tx: Tx) => void } | null>(null);
  const [formKey, setFormKey] = useState(0); // a fresh form each time, even when one form opens another ("Again" chips)
  const [account, setAccount] = useState(false);
  const [simple, toggleSimple] = useSimple();
  const [scope, setScope] = useState('');
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [path]);
  useEffect(() => { document.body.style.overflow = menu ? 'hidden' : ''; return () => { document.body.style.overflow = ''; }; }, [menu]);
  const open: OpenTxForm = (opts = {}) => { setForm(opts); setFormKey((k) => k + 1); };
  // On a trip day the Add buttons open the one-screen Quick add; any other day, the full form.
  const addFast = () => { const t = liveTrip(state.trips, me.id); if (t) setQuick(t); else open(); };

  // "#/quick" (a home-screen bookmark) opens Quick add. "#/receipt?text=…" is the "Share to Kitty" shortcut: the text the
  // iPhone read off a Google Pay receipt becomes a filled-in entry to check: a repayment with a friend, else an expense.
  useEffect(() => {
    if (path.startsWith('/quick')) { addFast(); navigate('/'); return; }
    if (!path.startsWith('/receipt')) return;
    const r = parseReceipt(new URLSearchParams(path.split('?')[1] ?? '').get('text') ?? '');
    navigate('/transactions');
    const dupe = r.ref ? state.transactions.find((t) => t.reference === r.ref) : undefined;
    if (dupe) { window.alert(`Already in Kitty: “${dupe.description}” on ${dupe.date} (UPI ${r.ref}).`); return; }
    const mine = me.upi_id?.toLowerCase();
    const first = (n: string) => n.trim().split(/\s+/)[0]!.toLowerCase();
    const friend = state.people.find((p) => p.id !== me.id && p.upi_id && r.upiIds.includes(p.upi_id.toLowerCase()) && p.upi_id.toLowerCase() !== mine)
      ?? (r.name ? state.people.find((p) => p.id !== me.id && first(p.name) === first(r.name!)) : undefined);
    const date = r.date ?? localToday();
    const base: Partial<TxInput> = { amount: r.amount ?? 0, currency: 'INR', date, reference: r.ref, notes: 'From a Google Pay receipt' };
    const short = (n: string) => n.split(' ')[0];
    if (friend || r.direction === 'received') {
      const them = friend ? short(friend.name) : (r.name ?? 'Someone');
      open({ initial: { ...base, type: 'repayment', method: 'UPI', payer_id: r.direction === 'received' ? (friend?.id ?? null) : me.id, payee_id: r.direction === 'received' ? me.id : (friend?.id ?? null),
        description: r.direction === 'received' ? `${them} paid ${short(me.name)} (UPI)` : `${short(me.name)} paid ${them} (UPI)` } });
    } else {
      open({ initial: { ...base, type: 'expense', description: r.name ?? 'UPI payment', category: guessCategory(r.name ?? ''), trip_id: liveTrip(state.trips, me.id, date)?.id ?? null } });
    }
  }, [path]);

  // "#/add?amount=1250&currency=SGD&…" is the Apple Pay shortcut's "Edit in Kitty": open the add form filled in, then show the trip.
  useEffect(() => {
    if (!path.startsWith('/add')) return;
    const q = new URLSearchParams(path.split('?')[1] ?? '');
    const trip = Number(q.get('trip')) || null;
    const initial: Partial<TxInput> = { type: 'expense', trip_id: trip, amount: Number(q.get('amount')) || 0, description: q.get('description') ?? '' };
    for (const k of ['currency', 'date', 'category'] as const) { const v = q.get(k); if (v) initial[k] = v; }
    setForm(initial.amount ? { initial } : {});
    setFormKey((k) => k + 1);
    navigate(trip ? `/trips/${trip}` : '/');
  }, [path]);

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
      case 'people': return id != null && !Number.isNaN(id) ? <PersonView id={id} /> : <People />;
      case 'accounts': return <Accounts id={id} />;
      case 'balances': return <Balances />;
      case 'imports': return <Imports />;
      case 'reports': return <Reports />;
      case 'docs': return <Docs folderId={id} />;
      default: return <Overview />;
    }
  })();
  const trips = state.trips.filter((t) => !t.archived);
  return (
    <TxFormCtx.Provider value={open}>
      {simple ? (
        <div className="simple-app">
          <header className="shared-head">
            <a className="brand" href="#/" style={{ padding: 0 }}><span className="mark"><Logo size={16} /></span><span>{APP_NAME}</span></a>
            <span className="row">
              <button className="ghost small" onClick={toggleSimple} data-testid="simple-toggle"><LayoutGrid />Full view</button>
              <button className="ghost icon small" onClick={toggleTheme} aria-label="Toggle theme" data-testid="theme-toggle">{theme === 'dark' ? <Sun /> : <Moon />}</button>
              {user && <button className="ghost icon small" onClick={() => { forgetMaster(); void logout(); }} title="Sign out" aria-label="Sign out" data-testid="logout"><LogOut /></button>}
            </span>
          </header>
          <main className="main simple-main"><QueueBanner /><SimpleView scope={scope} onScope={setScope} /></main>
          <button className="primary fab" onClick={addFast} aria-label="Add transaction"><Plus />Add</button>
        </div>
      ) : (
      <div className="app">
        <aside className="sidebar">
          <a className="brand" href="#/"><span className="mark"><Logo size={16} /></span><span>{APP_NAME}</span></a>
          <button className="ghost icon hamburger" onClick={() => setMenu((o) => !o)} aria-label={menu ? 'Close menu' : 'Open menu'} aria-expanded={menu} data-testid="hamburger">{menu ? <X /> : <Menu />}</button>
          <div className={`side-body${menu ? ' open' : ''}`}>
          <nav className="nav" aria-label="Sections">
            {NAV.map(([p, label, I]) => (
              <a key={p} href={`#/${p}`} className={section === p ? 'active' : ''} title={label} aria-label={label}><I /><span className="label">{label}</span></a>
            ))}
          </nav>
          <div className="nav-label">Trips {owner && <a href="#/trips/new" title="New trip" aria-label="New trip"><Plus /></a>}</div>
          <nav className="nav" aria-label="Trips">
            {trips.map((t) => (
              <a key={t.id} href={`#/trips/${t.id}`} className={`trip-link ${section === 'trips' && id === t.id ? 'active' : ''}`} style={hueStyle(t.id)}>
                <TripMark name={t.name} id={t.id} /><span className="name">{t.name}</span>
              </a>
            ))}
            {trips.length === 0 && <span className="faint small trip-link" style={{ padding: '4px 10px' }}>No trips yet</span>}
          </nav>
          <div className="sidebar-foot">
            <button className="primary add-side" onClick={addFast} data-testid="add-transaction"><Plus />Add transaction</button>
            <span className="shortcut">Press <kbd className="kbd">N</kbd> to add</span>
            <button className="ghost theme-toggle" onClick={toggleSimple} title="Simple view" data-testid="simple-toggle"><Smartphone /><span className="label">Simple view</span></button>
            <button className="ghost theme-toggle" onClick={toggleTheme} aria-label="Toggle theme" data-testid="theme-toggle">
              {theme === 'dark' ? <Sun /> : <Moon />}<span className="label">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
            </button>
            {user && (
              <div className="user-block" data-testid="user-block">
                <Avatar id={user.person_id ?? 0} name={user.name} small />
                <button type="button" className="info" onClick={() => setAccount(true)} title="Account settings" data-testid="account-button"><div>{user.name}</div><div className="faint small">{user.email}</div></button>
                <button className="ghost icon small" onClick={() => { forgetMaster(); void logout(); }} title="Sign out" aria-label="Sign out" data-testid="logout"><LogOut /></button>
              </div>
            )}
          </div>
          </div>
        </aside>
        <main className="main"><QueueBanner />{page}</main>
        <button className="primary fab" onClick={addFast} aria-label="Add transaction"><Plus />Add</button>
      </div>
      )}
      {account && <AccountModal onClose={() => setAccount(false)} />}
      {quick && <QuickAdd trip={quick} onClose={() => setQuick(null)} onMore={(initial) => { setQuick(null); open({ initial }); }} />}
      {form && (
        <TxForm
          key={formKey}
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

/** New entries saved without a connection and still on this device; ones the ledger rejected can be fixed or dropped. */
function QueueBanner() {
  const { reload } = useLedger();
  const openForm = useTxForm();
  const [list, setList] = useState(queued);
  const [syncing, setSyncing] = useState(false);
  useEffect(() => {
    const on = () => setList(queued());
    window.addEventListener('ledger:queue', on);
    return () => window.removeEventListener('ledger:queue', on);
  }, []);
  const waiting = list.filter((q) => !q.error).length;
  if (!list.length) return null;
  const sync = async () => {
    setSyncing(true);
    try { if (await flushQueue()) await reload(); } finally { setSyncing(false); }
  };
  return (
    <div className="info-box stack tight" role="status" data-testid="queue-banner">
      {waiting > 0 && (
        <div className="row between">
          <span>{waiting} new entr{waiting === 1 ? 'y is' : 'ies are'} saved on this device and will sync when the ledger is reachable.</span>
          <button className="small" disabled={syncing} onClick={() => void sync()}>{syncing ? 'Syncing…' : 'Sync now'}</button>
        </div>
      )}
      {list.filter((q) => q.error).map((q) => (
        <div key={q.ref} className="row between">
          <span>“{String(q.body.description || 'An entry')}” was not accepted: {q.error}</span>
          <span className="row">
            <button className="small" onClick={() => openForm({ initial: q.body as Partial<TxInput>, onSaved: () => dropQueued(q.ref) })}>Fix</button>
            <button className="small ghost" onClick={() => { if (window.confirm('Discard this entry?')) dropQueued(q.ref); }}>Discard</button>
          </span>
        </div>
      ))}
    </div>
  );
}

/** Copies each column header onto its cells as data-label, so the phone CSS can stack wide tables and still name every value. */
function labelTables() {
  for (const t of document.querySelectorAll('table')) {
    const heads = [...t.querySelectorAll('thead th')].map((th) => th.textContent ?? '');
    for (const tr of t.querySelectorAll('tbody tr, tfoot tr')) {
      [...tr.children].forEach((td, i) => { const l = heads[i] ?? ''; if (td.getAttribute('data-label') !== l) td.setAttribute('data-label', l); });
    }
  }
}

export function App() {
  const { section, parts } = useRoute();
  useEffect(() => {
    let raf = 0;
    const run = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(labelTables); };
    const mo = new MutationObserver(run);
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    run();
    return () => { mo.disconnect(); cancelAnimationFrame(raf); };
  }, []);
  if (section === 'invite' && parts[1]) return <ErrorBoundary><InviteAccept token={parts[1]} /></ErrorBoundary>;
  if (section === 'docs' && parts[1] === 's' && parts[2]) return <ErrorBoundary><DocsShared token={parts[2]} keyB64={parts[3] ?? ''} /></ErrorBoundary>;
  if (section === 's' && parts[1]) return <ErrorBoundary><SharedPage token={parts[1]} simple={parts[2] === 'simple'} /></ErrorBoundary>;
  return (
    <ErrorBoundary>
      <LedgerProvider>
        <Shell />
      </LedgerProvider>
    </ErrorBoundary>
  );
}
