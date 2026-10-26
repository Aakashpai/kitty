import { useState, type FormEvent } from 'react';
import { api, errorText } from '../api.ts';
import { useLedger } from '../store.tsx';
import { ErrorBox, Field, Modal } from './ui.tsx';

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
