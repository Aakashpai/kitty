import { useState } from 'react';
import { ChevronLeft, Copy, Link2, MoreHorizontal, Plus, UserPlus } from 'lucide-react';
import { computeHomeBalances, formatAmount, negligible, pairwiseDebts, type Invite, type Person, type Share } from '../../engine/index.ts';
import { api, errorText } from '../api.ts';
import { copyText, featureOn, useLedger } from '../store.tsx';
import { Avatar, DangerButton, Empty, ErrorBox, Spinner, fmtDate, useBusy } from '../components/ui.tsx';
import { ShareModal } from './Trips.tsx';
import { SimpleView } from './Simple.tsx';

export function People() {
  const { state, balances, reload, me, rateCtx, owner: isOwner } = useLedger();
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; name: string; upi: string } | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [sharing, setSharing] = useState<Person | null>(null);
  const [busy, guard] = useBusy();
  const home = rateCtx.home;
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
  const userOf = (personId: number) => state.users?.find((u) => u.person_id === personId);
  const inviteOf = (personId: number) => state.invites?.find((i) => i.person_id === personId);
  const inviteUrl = (i: Invite) => `${window.location.origin}${window.location.pathname}#/invite/${i.token}`;
  const copyInvite = async (i: Invite) => {
    await copyText(inviteUrl(i));
    setCopied(i.id);
    window.setTimeout(() => setCopied(null), 1500);
  };
  // Every live view-only link, whoever made it, so the owner can see what is out there and turn any of it off.
  const [copiedLink, setCopiedLink] = useState<number | null>(null);
  const linkWhat = (x: Share) => {
    const trip = x.trip_id != null ? (state.trips.find((t) => t.id === x.trip_id)?.name ?? 'A trip') : null;
    const person = x.person_id != null ? `${state.people.find((p) => p.id === x.person_id)?.name ?? 'Someone'}’s view` : null;
    return trip && person ? `${trip} · ${person}` : (trip ?? `${person} · all trips`);
  };
  const copyLink = async (x: Share) => {
    await copyText(`${window.location.origin}${window.location.pathname}#/s/${x.token}${x.person_id != null ? '/simple' : ''}`);
    setCopiedLink(x.id);
    window.setTimeout(() => setCopiedLink(null), 1500);
  };
  const tripsOf = (id: number) => state.trips.filter((t) => t.members.includes(id)).length;

  // Where I stand with each person: exact per currency, plus one headline in the home currency.
  const pairs = pairwiseDebts(balances);
  const homePairs = pairwiseDebts(computeHomeBalances(state.transactions, rateCtx));
  const withMe = (id: number) => pairs.filter((d) => (d.from === id && d.to === me.id) || (d.to === id && d.from === me.id)).map((d) => ({ currency: d.currency, amount: d.to === me.id ? d.amount : -d.amount }));
  const withMeHome = (id: number) => {
    const d = homePairs.find((x) => (x.from === id && x.to === me.id) || (x.to === id && x.from === me.id));
    return d ? (d.to === me.id ? d.amount : -d.amount) : 0;
  };
  const words = (list: { currency: string; amount: number }[]) => {
    const they = list.filter((x) => x.amount > 0).map((x) => formatAmount(x.amount, x.currency));
    const you = list.filter((x) => x.amount < 0).map((x) => formatAmount(-x.amount, x.currency));
    return [they.length ? `owes you ${they.join(' + ')}` : '', you.length ? `you owe ${you.join(' + ')}` : ''].filter(Boolean).join(' · ');
  };
  const people = [...state.people].sort((a, b) => (a.is_me ? -1 : b.is_me ? 1 : Math.abs(withMeHome(b.id)) - Math.abs(withMeHome(a.id)) || a.name.localeCompare(b.name)));

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>People</h1><div className="sub">{state.people.length - 1} friend{state.people.length === 2 ? '' : 's'} · amounts shown as what each person owes you, or you owe them</div></div>
        {isOwner && <form className="row" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void add(); }}>
          <input value={name} placeholder="Friend's name" style={{ width: 220 }} onChange={(e) => setName(e.target.value)} data-testid="person-name" />
          <button className="primary" type="submit" disabled={busy || !name.trim()} data-testid="add-person">{busy ? <Spinner /> : <Plus />}Add</button>
        </form>}
      </div>
      <ErrorBox error={err} />
      <div className="panel">
        <div className="people-list" data-testid="people-table">
          {people.map((p) => {
            const cur = p.is_me ? [] : withMe(p.id);
            const total = p.is_me ? 0 : withMeHome(p.id);
            const u = userOf(p.id), inv = inviteOf(p.id);
            return (
              <div key={p.id} className="person-row" style={{ opacity: p.archived ? 0.55 : 1 }} data-testid={`person-${p.id}`}>
                <Avatar id={p.id} name={p.name} />
                <div className="body">
                  {editing?.id === p.id ? (
                    <form className="row" style={{ flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); void update(p, { name: editing.name, upi_id: editing.upi.trim() || null }).then(() => setEditing(null)); }}>
                      <input value={editing.name} autoFocus style={{ width: 180 }} placeholder="Name" onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                      <input value={editing.upi} style={{ width: 180 }} placeholder="UPI ID (name@bank)" onChange={(e) => setEditing({ ...editing, upi: e.target.value })} data-testid="upi-input" />
                      <button className="small primary" type="submit" disabled={busy}>Save</button>
                      <button className="small ghost" type="button" onClick={() => setEditing(null)}>Cancel</button>
                    </form>
                  ) : (
                    <div className="title">
                      <a href={`#/people/${p.id}`} className="person-link" data-testid={`open-person-${p.id}`}>{p.name}</a>
                      {p.is_me ? <span className="badge">you</span> : null}
                      {u && <span className="badge">can sign in</span>}
                      {inv && <span className="badge">invited</span>}
                      {p.archived ? <span className="badge">archived</span> : null}
                    </div>
                  )}
                  <div className="meta">{tripsOf(p.id)} trip{tripsOf(p.id) === 1 ? '' : 's'}{cur.length ? ` · ${words(cur)}` : p.is_me ? '' : ' · settled'}{p.upi_id ? ` · UPI ${p.upi_id}` : ''}</div>
                </div>
                <div className="amt">
                  {p.is_me ? null : negligible(total, home, rateCtx.small) ? (
                    <span className="label faint" title="Left over from exchange rates and rounding">{formatAmount(Math.abs(total), home)} · negligible</span>
                  ) : total > 0 ? (
                    <><span className="label pos">owes you</span><span className="amount money pos">{formatAmount(total, home)}</span></>
                  ) : total < 0 ? (
                    <><span className="label neg">you owe</span><span className="amount money neg">{formatAmount(-total, home)}</span></>
                  ) : cur.length ? (
                    <span className="label faint">no rate for {cur.map((c) => c.currency).join(', ')}</span>
                  ) : (
                    <span className="label faint">settled</span>
                  )}
                </div>
                <div className="actions row" style={{ flexWrap: 'nowrap', gap: 4 }}>
                  {isOwner && !p.is_me && !u && !inv && !p.archived && (
                    <button className="small" disabled={busy} onClick={() => void run(() => api('POST', '/api/invites', { person_id: p.id }))} data-testid={`invite-${p.id}`}><UserPlus />Invite</button>
                  )}
                  {isOwner && inv && (
                    <button className="small" onClick={() => void copyInvite(inv)} data-testid={`copy-invite-${p.id}`}><Copy />{copied === inv.id ? 'Copied' : 'Copy link'}</button>
                  )}
                  {(isOwner || p.id === me.id) && <details className="menu">
                    <summary aria-label={`More actions for ${p.name}`}><MoreHorizontal /></summary>
                    <div className="menu-list" onClick={(e) => { (e.currentTarget.closest('details') as HTMLDetailsElement).open = false; }}>
                      <button className="small ghost" onClick={() => setEditing({ id: p.id, name: p.name, upi: p.upi_id ?? '' })}>Rename / UPI ID</button>
                      {isOwner && featureOn(state, 'shares') && !p.is_me && <button className="small ghost" onClick={() => setSharing(p)} data-testid={`share-person-${p.id}`}>Share their view</button>}
                      {isOwner && !p.is_me && <button className="small ghost" disabled={busy} onClick={() => void update(p, { archived: p.archived ? 0 : 1 })}>{p.archived ? 'Unarchive' : 'Archive'}</button>}
                      {isOwner && !p.is_me && <DangerButton confirm={`Delete ${p.name}? Only possible if they have no transactions.`} onConfirm={() => run(() => api('DELETE', `/api/people/${p.id}`))}>Delete</DangerButton>}
                    </div>
                  </details>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="panel-foot">The {home} figure values card charges at their real {home} amount and everything else at your set rates; the small line is the exact position per currency. Group-wide balances between friends are on the Balances page.</div>
      </div>
      {isOwner && state.people.length <= 1 && <Empty title="Just you so far">Add the friends you travel with; they only need a login if they want to see the ledger themselves.</Empty>}
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
                    <td><span className="badge">{u.role === 'owner' ? 'owner · admin' : 'member'}</span></td>
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
                      <button className="small ghost" disabled={busy} onClick={() => void run(() => api('DELETE', `/api/invites/${i.id}`))}>Cancel</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel-foot">Each trip is its own group: someone who signs in sees only the trips you add them to and entries that involve them, from their own point of view. You see everything. Send an invite link privately; whoever opens it first gets that person's seat.</div>
        </div>
      )}
      {isOwner && (
        <div className="panel" data-testid="links-panel">
          <div className="panel-head"><h3>Shared links</h3><span className="faint small">View-only links that work right now, made by you or a member</span></div>
          {state.shares.length === 0 ? <div className="panel-body faint small">No links are on.</div> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Shows</th><th>Made by</th><th>Created</th><th></th></tr></thead>
                <tbody>
                  {state.shares.map((x) => (
                    <tr key={x.id} data-testid={`link-${x.id}`}>
                      <td><div>{linkWhat(x)}</div>{x.label && <div className="faint small">{x.label}</div>}</td>
                      <td className="muted">{state.users?.find((u) => u.id === x.created_by)?.name ?? '—'}</td>
                      <td className="muted">{fmtDate(x.created_at.slice(0, 10))}</td>
                      <td className="actions">
                        <button className="small" onClick={() => void copyLink(x)} data-testid={`copy-link-${x.id}`}><Copy />{copiedLink === x.id ? 'Copied' : 'Copy link'}</button>
                        <DangerButton confirm="Turn this link off? Anyone who has it loses access straight away." onConfirm={() => run(() => api('DELETE', `/api/shares/${x.id}`))}>Turn off</DangerButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {sharing && <ShareModal person={sharing} onClose={() => setSharing(null)} />}
    </div>
  );
}

/** What one person sees on their share link, for the admin: only their entries, their share, where they stand. */
export function PersonView({ id }: { id: number }) {
  const { people, owner, state } = useLedger();
  const [scope, setScope] = useState('');
  const [share, setShare] = useState(false);
  const p = people.get(id);
  if (!p) return <Empty title="Person not found"><a href="#/people">Back to people</a></Empty>;
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <a href="#/people" className="back"><ChevronLeft />All people</a>
          <h1 className="row" style={{ gap: 10 }}><Avatar id={p.id} name={p.name} small />{p.name}</h1>
          <div className="sub">{p.is_me ? 'Your own entries and where you stand' : `What ${p.name} sees on their link: only their entries, their share, and what they owe or are owed`}</div>
        </div>
        {owner && featureOn(state, 'shares') && !p.is_me && <button onClick={() => setShare(true)} data-testid="share-person-page"><Link2 />Share their view</button>}
      </div>
      <div className="simple-wrap"><SimpleView scope={scope} onScope={setScope} focus={p.id} /></div>
      {share && <ShareModal person={p} onClose={() => setShare(false)} />}
    </div>
  );
}
