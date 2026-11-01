import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { ApiError, api, errorText } from '../api.ts';
import type { DocsState } from '../../engine/index.ts';
import { deriveMasterKey, makeCheck, newSalt, passesCheck, rememberMaster, unwrapKey, wrapKey } from '../vault.ts';
import { featureOn, useLedger } from '../store.tsx';
import { FEATURES, currencySymbol, type FeatureKey } from '../../engine/index.ts';
import { ErrorBox, Field, Modal } from './ui.tsx';

const b64urlBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

/** This device's phone notifications: when someone else adds, edits or comments on an entry you are in. */
function Notifications() {
  const [reg, setReg] = useState<ServiceWorkerRegistration | null | undefined>(undefined);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  useEffect(() => {
    if (!supported) return setReg(null);
    void navigator.serviceWorker.getRegistration().then(async (r) => {
      setReg(r ?? null);
      setOn(!!(await r?.pushManager.getSubscription()));
    });
  }, [supported]);
  const toggle = async () => {
    if (!reg) return;
    setBusy(true);
    setErr(null);
    try {
      const current = await reg.pushManager.getSubscription();
      if (current) {
        await api('POST', '/api/push/off', { endpoint: current.endpoint });
        await current.unsubscribe();
        setOn(false);
      } else {
        if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in the browser’s site settings, then try again.');
        const { key } = await api<{ key: string }>('GET', '/api/push/key');
        // Subscribing talks to the browser's push service; if that never answers, give up instead of spinning forever.
        const timeout = new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('timeout')), 20_000));
        const sub = await Promise.race([reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlBytes(key) }), timeout]).catch(() => {
          throw new Error('This browser could not set up notifications. Private or incognito windows cannot; try a normal window or the installed app.');
        });
        await api('POST', '/api/push', sub.toJSON());
        setOn(true);
      }
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack tight" data-testid="notifications">
      <h3>Phone notifications</h3>
      {reg === undefined ? null : reg ? (
        <div className="row between">
          <span className="muted small">{on ? 'On for this device: you hear when someone else adds, changes or comments on an entry you are in.' : 'Get a notification when someone else adds, changes or comments on an entry you are in.'}</span>
          <button className={on ? '' : 'primary'} disabled={busy} onClick={() => void toggle()} data-testid="push-toggle">{on ? <BellOff /> : <Bell />}{busy ? 'Working…' : on ? 'Turn off' : 'Turn on'}</button>
        </div>
      ) : (
        <span className="muted small">{/iPhone|iPad/.test(navigator.userAgent) ? 'On iPhone, add Kitty to the home screen first (Share → Add to Home Screen), open it from there, then turn this on.' : 'Not available in this browser. Open Kitty in Chrome, Edge, Firefox or Safari, or install it to the home screen.'}</span>
      )}
      <ErrorBox error={err} />
    </div>
  );
}

/** How small a leftover must be to count as negligible (and get Call it square), in the home currency. */
function SquareUnder() {
  const { state, reload } = useLedger();
  const saved = state.settings.square_under ?? 10;
  const [v, setV] = useState(String(saved));
  const [err, setErr] = useState<string | null>(null);
  const n = Number(v);
  const save = async () => {
    try {
      await api('PUT', '/api/settings', { square_under: n });
      await reload();
      setErr(null);
    } catch (x) { setErr(errorText(x)); }
  };
  return (
    <form className="plan-row" style={{ borderBottom: '1px solid var(--border)', paddingLeft: 'var(--space-6)' }} onSubmit={(e) => { e.preventDefault(); void save(); }} data-testid="square-under-form">
      <span className="grow muted small">Negligible under</span>
      <span className="row" style={{ gap: 'var(--space-1)' }}>{currencySymbol(state.settings.home_currency)}<input inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} style={{ width: 80 }} aria-label="Negligible under" data-testid="square-under" /></span>
      <button type="submit" className="small" disabled={!(n > 0) || n === saved}>Save</button>
      <ErrorBox error={err} />
    </form>
  );
}

type StorageUse = { files: number; database: number; caps: { files: number; database: number }; bucket: boolean };
const gb = (n: number) => (n >= 1e9 ? `${+(n / 1e9).toFixed(2)} GB` : `${+(n / 1e6).toFixed(1)} MB`);

/** How full the two free-plan stores are; the server refuses uploads past each ceiling. */
function Storage() {
  const [s, setS] = useState<StorageUse | null>(null);
  useEffect(() => { void api<StorageUse>('GET', '/api/storage').then(setS).catch(() => setS(null)); }, []);
  if (!s) return null;
  const rows: [string, number, number][] = [
    ...(s.bucket ? [['Documents · Cloudflare R2, free up to 10 GB', s.files, s.caps.files] as [string, number, number]] : []),
    ['Entries & bill photos · Turso, free up to 5 GB', s.database, s.caps.database],
  ];
  return (
    <section className="stack tight" data-testid="storage">
      <h3>Storage</h3>
      <p className="muted small" style={{ margin: 0 }}>Uploads stop at {s.bucket ? `${gb(s.caps.files)} and ` : ''}{gb(s.caps.database)}, a little under each free limit, so nothing is ever billed.</p>
      {rows.map(([label, used, cap]) => (
        <div key={label} className="stack tight">
          <div className="row between"><span className="small">{label}</span><span className="small muted">{gb(used)} of {gb(cap)}</span></div>
          <span className={`meter${used > cap * 0.9 ? ' over' : ''}`}><i style={{ width: `${Math.min(100, (used / cap) * 100)}%` }} /></span>
        </div>
      ))}
    </section>
  );
}

export function AccountModal({ onClose }: { onClose: () => void }) {
  const { user, state, reload } = useLedger();
  const [flagErr, setFlagErr] = useState<string | null>(null);
  const setFlag = async (key: FeatureKey, on: boolean) => {
    try {
      await api('PUT', '/api/settings', { flags: { ...(state.settings.flags ?? {}), [key]: on } });
      await reload();
      setFlagErr(null);
    } catch (x) { setFlagErr(errorText(x)); }
  };
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.next !== f.confirm) return setErr('New passwords do not match');
    setBusy(true);
    try {
      // Documents are encrypted under a key derived from the password, so the folder keys are re-wrapped first.
      let revert: (() => Promise<unknown>) | null = null;
      try {
        const d = await api<DocsState>('GET', '/api/docs');
        if (d.vault) {
          const oldMaster = await deriveMasterKey(f.current, d.vault.salt);
          if (!(await passesCheck(oldMaster, d.vault.check_iv, d.vault.check_ct))) throw new Error('Current password is wrong');
          const salt = newSalt();
          const newMaster = await deriveMasterKey(f.next, salt);
          const roots = d.folders.filter((x) => x.parent_id == null && x.key_iv && x.key_ct);
          const folders = await Promise.all(roots.map(async (x) => ({ id: x.id, ...(await wrapKey(newMaster, await unwrapKey(oldMaster, x.key_iv!, x.key_ct!))) })));
          const before = { salt: d.vault.salt, check_iv: d.vault.check_iv, check_ct: d.vault.check_ct, folders: roots.map((x) => ({ id: x.id, key_iv: x.key_iv!, key_ct: x.key_ct! })) };
          await api('PUT', '/api/docs/vault', { salt, ...(await makeCheck(newMaster)), folders });
          revert = () => api('PUT', '/api/docs/vault', before);
          await rememberMaster(newMaster);
        }
      } catch (x) {
        if (!(x instanceof ApiError && x.status === 403)) throw x; // members have no vault
      }
      try {
        await api('POST', '/api/auth/password', { current: f.current, next: f.next });
      } catch (x) {
        await revert?.().catch(() => undefined);
        throw x;
      }
      setDone(true);
      setErr(null);
      setF({ current: '', next: '', confirm: '' });
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Your account" onClose={onClose}>
      <div className="stack">
        <dl className="kv">
          <div style={{ display: 'contents' }}><dt>Name</dt><dd>{user?.name}</dd></div>
          <div style={{ display: 'contents' }}><dt>Email</dt><dd>{user?.email}</dd></div>
          <div style={{ display: 'contents' }}><dt>Role</dt><dd>{user?.role === 'owner' ? 'owner · admin' : 'member'}</dd></div>
        </dl>
        <Notifications />
        {user?.role === 'owner' && (
          <section className="stack tight" data-testid="features">
            <h3>Features</h3>
            <p className="muted small" style={{ margin: 0 }}>Switch parts of the app off for everyone, share links included. Nothing is deleted; turn a feature back on and it is all still there.</p>
            <div className="panel">
              {FEATURES.map((f) => (
                <Fragment key={f.key}>
                  <label className="plan-row check">
                    <input type="checkbox" checked={featureOn(state, f.key)} onChange={(e) => void setFlag(f.key, e.target.checked)} data-testid={`flag-${f.key}`} />
                    <span><strong>{f.label}</strong><span className="muted small" style={{ display: 'block' }}>{f.hint}</span></span>
                  </label>
                  {f.key === 'square' && <SquareUnder />}
                </Fragment>
              ))}
            </div>
            <ErrorBox error={flagErr} />
          </section>
        )}
        {user?.role === 'owner' && <Storage />}
        <form className="stack" onSubmit={(e) => void submit(e)} data-testid="password-form">
          <h3>Change password</h3>
          <Field label="Current password"><input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} data-testid="pw-current" /></Field>
          <Field label="New password" hint="At least 8 characters"><input type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} data-testid="pw-next" /></Field>
          <Field label="Confirm new password"><input type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} data-testid="pw-confirm" /></Field>
          {done && <div className="ok-box">Password changed.</div>}
          <ErrorBox error={err} />
          <div className="row end"><button type="submit" className="primary" disabled={busy || !f.current || f.next.length < 8} data-testid="pw-submit">{busy ? 'Saving…' : 'Change password'}</button></div>
        </form>
      </div>
    </Modal>
  );
}
