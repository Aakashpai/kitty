import { useState, type FormEvent } from 'react';
import { api, errorText } from '../api.ts';
import type { Vault } from '../../engine/index.ts';
import { deriveMasterKey, passesCheck, rememberMaster } from '../vault.ts';
import { APP_NAME, ErrorBox, Field, Logo } from '../components/ui.tsx';

function AuthFrame({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand" style={{ padding: 0, marginBottom: 20 }}><span className="mark"><Logo size={16} /></span><span>{APP_NAME}</span></div>
        <h1>{title}</h1>
        <p className="muted" style={{ marginBottom: 20 }}>{sub}</p>
        {children}
      </div>
    </div>
  );
}

export function Setup({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ name: '', email: '', password: '', confirm: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.password !== f.confirm) return setErr('Passwords do not match');
    setBusy(true);
    try {
      await api('POST', '/api/auth/setup', f);
      onDone();
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame title={`Set up ${APP_NAME}`} sub="This creates the owner account. You can invite friends afterwards from People.">
      <form className="stack" onSubmit={(e) => void submit(e)} data-testid="setup-form">
        <Field label="Your name"><input value={f.name} autoFocus autoComplete="name" onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="setup-name" /></Field>
        <Field label="Email"><input type="email" value={f.email} autoComplete="email" onChange={(e) => setF({ ...f, email: e.target.value })} data-testid="setup-email" /></Field>
        <Field label="Password" hint="At least 8 characters"><input type="password" value={f.password} autoComplete="new-password" onChange={(e) => setF({ ...f, password: e.target.value })} data-testid="setup-password" /></Field>
        <Field label="Confirm password"><input type="password" value={f.confirm} autoComplete="new-password" onChange={(e) => setF({ ...f, confirm: e.target.value })} data-testid="setup-confirm" /></Field>
        <ErrorBox error={err} />
        <button className="primary" type="submit" disabled={busy || !f.name || !f.email || f.password.length < 8} data-testid="setup-submit">{busy ? 'Creating…' : 'Create owner account'}</button>
      </form>
    </AuthFrame>
  );
}

export function Login({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ email: '', password: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('POST', '/api/auth/login', f);
      // The owner's documents are encrypted under a key derived from this password: derive it now so the vault opens without asking again.
      try {
        const d = await api<{ vault: Vault | null }>('GET', '/api/docs');
        if (d.vault) {
          const master = await deriveMasterKey(f.password, d.vault.salt);
          if (await passesCheck(master, d.vault.check_iv, d.vault.check_ct)) await rememberMaster(master);
        }
      } catch { /* members have no vault; the Documents page asks the owner if needed */ }
      onDone();
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame title="Sign in" sub="Only people who were invited can sign in.">
      <form className="stack" onSubmit={(e) => void submit(e)} data-testid="login-form">
        <Field label="Email"><input type="email" value={f.email} autoFocus autoComplete="email" onChange={(e) => setF({ ...f, email: e.target.value })} data-testid="login-email" /></Field>
        <Field label="Password"><input type="password" value={f.password} autoComplete="current-password" onChange={(e) => setF({ ...f, password: e.target.value })} data-testid="login-password" /></Field>
        <ErrorBox error={err} />
        <button className="primary" type="submit" disabled={busy || !f.email || !f.password} data-testid="login-submit">{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </AuthFrame>
  );
}

export function InviteAccept({ token }: { token: string }) {
  const [info, setInfo] = useState<{ person_name: string; owner_name: string } | null | 'bad'>(null);
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (info === null) {
    void api<{ person_name: string; owner_name: string }>('GET', `/api/invites/${token}`).then((i) => { setInfo(i); setF((x) => ({ ...x, name: i.person_name })); }).catch((e) => { setErr(errorText(e)); setInfo('bad'); });
    return <div className="center-box"><span className="pulse" aria-hidden /><p className="muted">Checking your invite…</p></div>;
  }
  if (info === 'bad') {
    return (
      <AuthFrame title="This invite doesn’t work anymore" sub={err ?? 'Ask for a fresh link.'}>
        <a className="btn" href="#/">Go to sign in</a>
      </AuthFrame>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('POST', `/api/invites/${token}/accept`, f);
      window.location.hash = '/';
      window.location.reload();
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame title={`Join ${info.owner_name}’s ${APP_NAME}`} sub={`You’ll be signed in as ${info.person_name}. Choose how you want to log in.`}>
      <form className="stack" onSubmit={(e) => void submit(e)} data-testid="invite-form">
        <Field label="Your name"><input value={f.name} autoComplete="name" onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="invite-name" /></Field>
        <Field label="Email"><input type="email" value={f.email} autoFocus autoComplete="email" onChange={(e) => setF({ ...f, email: e.target.value })} data-testid="invite-email" /></Field>
        <Field label="Password" hint="At least 8 characters"><input type="password" value={f.password} autoComplete="new-password" onChange={(e) => setF({ ...f, password: e.target.value })} data-testid="invite-password" /></Field>
        <ErrorBox error={err} />
        <button className="primary" type="submit" disabled={busy || !f.email || f.password.length < 8} data-testid="invite-submit">{busy ? 'Joining…' : 'Join'}</button>
      </form>
    </AuthFrame>
  );
}
