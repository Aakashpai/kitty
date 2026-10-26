import { useState } from 'react';
import { Copy, Plus, UserPlus, X } from 'lucide-react';
import { pairwiseDebts, type Invite, type Person } from '../../engine/index.ts';
import { api, errorText } from '../api.ts';
import { copyText, useLedger } from '../store.tsx';
import { Avatar, DangerButton, ErrorBox, MoneyList, Spinner, fmtDate, useBusy } from '../components/ui.tsx';

export function People() {
  const { state, balances, reload, me, user } = useLedger();
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const isOwner = user?.role === 'owner';
  const userOf = (personId: number) => state.users?.find((u) => u.person_id === personId);
  const inviteOf = (personId: number) => state.invites?.find((i) => i.person_id === personId);
  const inviteUrl = (i: Invite) => `${window.location.origin}${window.location.pathname}#/invite/${i.token}`;
  const copyInvite = async (i: Invite) => {
    await copyText(inviteUrl(i));
    setCopied(i.id);
    window.setTimeout(() => setCopied(null), 1500);
  };
  const pairs = pairwiseDebts(balances);
  const [busy, guard] = useBusy();
  const run = (fn: () => Promise<unknown>) =>
    guard(async () => {
      try {
        await fn();
        await reload();
        setErr(null);
      } catch (e) {
        setErr(errorText(e));
      }
    });
  const add = () => run(async () => { await api('POST', '/api/people', { name }); setName(''); });
  const update = (p: Person, patch: Partial<Person>) => run(() => api('PUT', `/api/people/${p.id}`, { ...p, ...patch }));
  const tripsOf = (id: number) => state.trips.filter((t) => t.members.includes(id)).length;
  const withYou = (id: number) => pairs.filter((d) => (d.from === id && d.to === me.id) || (d.to === id && d.from === me.id)).map((d): [string, number] => [d.currency, d.to === me.id ? d.amount : -d.amount]);
  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>People</h1><div className="sub">{state.people.length - 1} friend{state.people.length === 2 ? '' : 's'}</div></div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void add(); }}>
          <input value={name} placeholder="Friend's name" style={{ width: 220 }} onChange={(e) => setName(e.target.value)} data-testid="person-name" />
          <button className="primary" type="submit" disabled={busy || !name.trim()} data-testid="add-person">{busy ? <Spinner /> : <Plus />}Add</button>
        </form>
      </div>
      <ErrorBox error={err} />
      <div className="panel">
        <div className="table-wrap">
          <table data-testid="people-table">
            <thead><tr><th>Name</th><th>Trips</th><th className="num">Balance with you</th><th className="num">Overall net</th><th></th></tr></thead>
            <tbody>
              {state.people.map((p) => (
                <tr key={p.id} style={{ opacity: p.archived ? 0.55 : 1 }}>
                  <td>
                    {editing?.id === p.id ? (
                      <form className="row" style={{ flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); void update(p, { name: editing.name }).then(() => setEditing(null)); }}>
                        <input value={editing.name} autoFocus style={{ width: 180 }} onChange={(e) => setEditing({ id: p.id, name: e.target.value })} />
                        <button className="small primary" type="submit" disabled={busy}>Save</button>
                        <button className="small ghost" type="button" onClick={() => setEditing(null)}>Cancel</button>
                      </form>
                    ) : (
                      <span className="who"><Avatar id={p.id} name={p.name} />{p.name} {p.is_me ? <span className="badge">you</span> : null} {p.archived ? <span className="badge">archived</span> : null}</span>
                    )}
                  </td>
                  <td className="muted">{tripsOf(p.id)}</td>
                  <td className="num">{p.is_me ? <span className="faint">—</span> : <MoneyList map={withYou(p.id)} sign empty="settled" />}</td>
                  <td className="num"><MoneyList map={balances.net.get(p.id) ?? new Map()} sign empty="settled" /></td>
                  <td className="actions">
                    {isOwner && !p.is_me && !userOf(p.id) && !inviteOf(p.id) && !p.archived && (
                      <button className="small" disabled={busy} onClick={() => void run(() => api('POST', '/api/invites', { person_id: p.id }))} data-testid={`invite-${p.id}`}><UserPlus />Invite</button>
                    )}
                    {isOwner && inviteOf(p.id) && (
                      <button className="small" onClick={() => void copyInvite(inviteOf(p.id)!)} data-testid={`copy-invite-${p.id}`}><Copy />{copied === inviteOf(p.id)!.id ? 'Copied' : 'Copy invite link'}</button>
                    )}
                    {userOf(p.id) && <span className="badge">can sign in</span>}
                    <button className="small ghost" onClick={() => setEditing({ id: p.id, name: p.name })}>Rename</button>
                    {!p.is_me && <button className="small ghost" disabled={busy} onClick={() => void update(p, { archived: p.archived ? 0 : 1 })}>{p.archived ? 'Unarchive' : 'Archive'}</button>}
                    {!p.is_me && <DangerButton confirm={`Delete ${p.name}? Only possible if they have no transactions.`} onConfirm={() => run(() => api('DELETE', `/api/people/${p.id}`))}>Delete</DangerButton>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel-foot">“Balance with you” is positive when they owe you. “Overall net” includes everyone they owe or are owed by.</div>
      </div>
      {isOwner && (
        <div className="panel" data-testid="access-panel">
          <div className="panel-head"><h3>Who can sign in</h3><span className="faint small">Invite links work once and expire after 7 days</span></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead>
              <tbody>
                {(state.users ?? []).map((u) => (
                  <tr key={u.id}>
                    <td><span className="who"><Avatar id={u.person_id ?? 0} name={u.name} small />{u.name}</span></td>
                    <td className="muted">{u.email}</td>
                    <td><span className="badge">{u.role}</span></td>
                    <td className="actions">
                      {u.role !== 'owner' && <DangerButton confirm={`Remove ${u.name}'s access? Their transactions stay.`} onConfirm={() => run(() => api('DELETE', `/api/users/${u.id}`))}>Remove access</DangerButton>}
                    </td>
                  </tr>
                ))}
                {(state.invites ?? []).map((i) => (
                  <tr key={`inv-${i.id}`} style={{ opacity: 0.8 }}>
                    <td><span className="who"><Avatar id={i.person_id} name={state.people.find((p) => p.id === i.person_id)?.name ?? '?'} small />{state.people.find((p) => p.id === i.person_id)?.name}</span></td>
                    <td className="muted">Invite pending · expires {fmtDate(i.expires_at.slice(0, 10))}</td>
                    <td><span className="badge">invited</span></td>
                    <td className="actions">
                      <button className="small" onClick={() => void copyInvite(i)}><Copy />{copied === i.id ? 'Copied' : 'Copy link'}</button>
                      <button className="small ghost" disabled={busy} onClick={() => void run(() => api('DELETE', `/api/invites/${i.id}`))} aria-label="Cancel invite"><X />Cancel</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel-foot">Everyone who signs in shares this ledger and sees balances from their own point of view. Send an invite link privately; whoever opens it first gets that person’s seat.</div>
        </div>
      )}
    </div>
  );
}
