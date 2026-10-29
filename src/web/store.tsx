import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { computeBalances, type Account, type Balances, type Id, type LedgerState, type Person, type RateCtx, type Trip, type Tx, type UserPublic } from '../engine/index.ts';
import { ApiError, api, errorText, flushQueue, queued } from './api.ts';
import { Login, Setup } from './pages/Auth.tsx';

export interface Ledger {
  state: LedgerState;
  reload: () => Promise<void>;
  me: Person;
  user: UserPublic | null;
  readOnly: boolean;
  owner: boolean; // the admin; members only get the trips they belong to and entries involving them
  ownAccounts: Account[]; // accounts whose balances this viewer can see: all for the owner, their own for a member
  people: Map<Id, Person>;
  accounts: Map<Id, Account>;
  trips: Map<Id, Trip>;
  balances: Balances; // overall, every transaction
  rateCtx: RateCtx; // how foreign amounts convert into the home currency
  who: (id: Id | null | undefined) => string; // "You" / name
  accountName: (id: Id | null | undefined) => string;
  logout: () => Promise<void>;
}

const Ctx = createContext<Ledger | null>(null);
type Phase = 'loading' | 'setup' | 'login' | 'ready' | 'down';

// The last ledger this device loaded, so the app still opens (read-only, plus queued new entries) without a connection.
const CACHE = 'kitty-state';
const cacheState = (s: LedgerState) => { try { localStorage.setItem(CACHE, JSON.stringify(s)); } catch { /* full or private */ } };
const cachedState = (): LedgerState | null => { try { return JSON.parse(localStorage.getItem(CACHE) ?? 'null') as LedgerState | null; } catch { return null; } };

/** Thin bar at the very top while any request is in flight; appears only after 150ms so quick calls don't flicker. */
function Progress() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let timer: number | undefined;
    const on = (e: Event) => {
      const n = (e as CustomEvent<number>).detail;
      if (n > 0) {
        if (timer == null) timer = window.setTimeout(() => setShow(true), 150);
      } else {
        if (timer != null) window.clearTimeout(timer);
        timer = undefined;
        setShow(false);
      }
    };
    window.addEventListener('ledger:inflight', on);
    return () => {
      window.removeEventListener('ledger:inflight', on);
      if (timer != null) window.clearTimeout(timer);
    };
  }, []);
  return show ? <div className="progress" role="progressbar" aria-label="Working" data-testid="progress" /> : null;
}

/** Polls /api/health until it answers, then calls onBack. Returns a stop function. */
function watchHealth(onBack: () => void, onTick: (secondsLeft: number) => void) {
  let left = 5;
  const id = window.setInterval(async () => {
    left -= 1;
    onTick(left);
    if (left > 0) return;
    left = 5;
    try {
      await fetch('/api/health', { cache: 'no-store' }).then((r) => {
        if (r.ok) onBack();
      });
    } catch {
      /* still down */
    }
  }, 1000);
  return () => window.clearInterval(id);
}

export function LedgerProvider({ children, initialState, readOnly = false }: { children: ReactNode; initialState?: LedgerState; readOnly?: boolean }) {
  const [state, setState] = useState<LedgerState | null>(initialState ?? null);
  const [phase, setPhase] = useState<Phase>(initialState ? 'ready' : 'loading');
  useEffect(() => { if (initialState) setState(initialState); }, [initialState]); // read-only pages refetch after a vote or a tick
  const [offline, setOffline] = useState(false);
  const [countdown, setCountdown] = useState(5);
  const [downMessage, setDownMessage] = useState('');
  const booting = useRef(false);

  const reload = useCallback(async () => {
    if (initialState) return;
    try {
      const s = await api<LedgerState>('GET', '/api/state');
      setState(s);
      cacheState(s);
      setOffline(false);
      if (queued().some((q) => !q.error) && (await flushQueue())) setState(await api<LedgerState>('GET', '/api/state'));
    } catch (e) {
      // 401 and network errors are handled by the events below; anything else is shown on the Down screen.
      if (!(e instanceof Error && /Lost contact|Sign in/.test(e.message))) setDownMessage(errorText(e));
    }
  }, [initialState]);

  const boot = useCallback(async () => {
    if (initialState || booting.current) return;
    booting.current = true;
    try {
      const status = await api<{ needsSetup: boolean; user: UserPublic | null }>('GET', '/api/auth/status');
      if (status.needsSetup) setPhase('setup');
      else if (!status.user) setPhase('login');
      else {
        const s = await api<LedgerState>('GET', '/api/state');
        setState(s);
        cacheState(s);
        setPhase('ready');
        setOffline(false);
        if (queued().some((q) => !q.error) && (await flushQueue())) setState(await api<LedgerState>('GET', '/api/state'));
      }
    } catch (e) {
      const cached = e instanceof ApiError && e.status === 0 ? cachedState() : null;
      if (cached) {
        setState(cached);
        setPhase('ready');
        setOffline(true);
        return;
      }
      setDownMessage(errorText(e));
      setPhase((p) => (p === 'ready' ? p : 'down'));
    } finally {
      booting.current = false;
    }
  }, [initialState]);

  useEffect(() => {
    void boot();
  }, [boot]);

  // Shell-wide signals from the API client and the browser.
  useEffect(() => {
    if (initialState) return;
    const onUnauth = () => { setState(null); setPhase('login'); };
    const onOffline = () => setOffline(true);
    const onBrowserOnline = () => void reload();
    window.addEventListener('ledger:unauthenticated', onUnauth);
    window.addEventListener('ledger:offline', onOffline);
    window.addEventListener('online', onBrowserOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('ledger:unauthenticated', onUnauth);
      window.removeEventListener('ledger:offline', onOffline);
      window.removeEventListener('online', onBrowserOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [initialState, reload]);

  // While down or offline, keep checking quietly and come back on our own.
  useEffect(() => {
    if (phase !== 'down' && !offline) return;
    return watchHealth(() => { if (phase === 'down') void boot(); else void reload(); }, setCountdown);
  }, [phase, offline, boot, reload]);

  const value = useMemo<Ledger | null>(() => {
    if (!state) return null;
    const people = new Map(state.people.map((p) => [p.id, p]));
    const accounts = new Map(state.accounts.map((a) => [a.id, a]));
    const trips = new Map(state.trips.map((t) => [t.id, t]));
    const me = (state.user?.person_id != null ? people.get(state.user.person_id) : undefined) ?? state.people.find((p) => p.is_me) ?? state.people[0]!;
    const owner = state.user?.role === 'owner';
    return {
      state,
      reload,
      me,
      user: state.user,
      readOnly,
      owner,
      ownAccounts: owner ? state.accounts : state.accounts.filter((a) => a.person_id === me.id),
      people,
      accounts,
      trips,
      balances: computeBalances(state.transactions, state.accounts),
      rateCtx: { home: state.settings.home_currency, rates: state.settings.rates ?? {}, trips: state.trips, accounts: state.accounts },
      who: (id) => (id == null ? '—' : id === me.id && !readOnly ? 'You' : (people.get(id)?.name ?? `#${id}`)),
      accountName: (id) => (id == null ? '—' : (accounts.get(id)?.name ?? `#${id}`)),
      logout: async () => {
        const waiting = queued().length;
        if (waiting && !window.confirm(`${waiting} new entr${waiting === 1 ? 'y has' : 'ies have'} not synced from this device yet. Sign out and discard ${waiting === 1 ? 'it' : 'them'}?`)) return;
        try { localStorage.removeItem(CACHE); localStorage.removeItem('kitty-queue'); } catch { /* private mode */ }
        await api('POST', '/api/auth/logout').catch(() => undefined);
        setState(null);
        setPhase('login');
      },
    };
  }, [state, reload, readOnly]);

  if (phase === 'setup') return <Setup onDone={() => void boot()} />;
  if (phase === 'login') return <Login onDone={() => void boot()} />;
  if (phase === 'down') {
    return (
      <div className="center-box down" data-testid="down">
        <span className="pulse" aria-hidden />
        <h2>The ledger is out of reach</h2>
        <p className="muted">Nothing has been lost. {countdown > 0 ? `Retrying in ${countdown}s.` : 'Retrying now…'}</p>
        {downMessage && <p className="faint small">{downMessage}</p>}
        <button onClick={() => void boot()}>Try now</button>
      </div>
    );
  }
  if (!value) return <div className="center-box"><span className="pulse" aria-hidden /><p className="muted">Opening your ledger…</p></div>;
  return (
    <Ctx.Provider value={value}>
      <Progress />
      {offline && (
        <div className="banner" role="status" data-testid="offline-banner">
          <span className="pulse small" aria-hidden />
          Offline. New entries are kept on this device and sync when the ledger is back; edits need a connection — {countdown > 0 ? `retrying in ${countdown}s` : 'retrying now'}.
        </div>
      )}
      {children}
    </Ctx.Provider>
  );
}

export function useLedger(): Ledger {
  const v = useContext(Ctx);
  if (!v) throw new Error('useLedger outside LedgerProvider');
  return v;
}

export const today = () => new Date().toISOString().slice(0, 10);
export const COMMON_CURRENCIES = ['INR', 'SGD', 'USD', 'EUR', 'GBP', 'AED', 'THB', 'MYR', 'IDR', 'JPY', 'AUD', 'LKR', 'VND', 'CHF', 'HKD', 'KRW', 'NPR', 'CAD'];
export const CATEGORIES = ['Food', 'Drinks', 'Groceries', 'Travel', 'Stay', 'Shopping', 'Activities', 'Health', 'Bills', 'Gifts', 'Expenses'];
/** Category an entry groups under; entries without one (mostly cash spends) count as Expenses. */
export const categoryOf = (t: Pick<Tx, 'category'>) => t.category || 'Expenses';

export { guessCategory } from '../engine/index.ts'; // shared with the server (Apple Pay shortcut)

/** Copies text, falling back to a prompt where the clipboard API is unavailable (http on LAN, old browsers). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    window.prompt('Copy this link:', text);
    return false;
  }
}
