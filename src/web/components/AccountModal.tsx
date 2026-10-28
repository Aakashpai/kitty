import { useEffect, useState, type FormEvent } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { api, errorText } from '../api.ts';
import { useLedger } from '../store.tsx';
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

export function AccountModal({ onClose }: { onClose: () => void }) {
  const { user } = useLedger();
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.next !== f.confirm) return setErr('New passwords do not match');
    setBusy(true);
    try {
      await api('POST', '/api/auth/password', { current: f.current, next: f.next });
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
