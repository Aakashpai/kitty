import { useEffect, useState } from 'react';
import type { LedgerState } from '../../engine/index.ts';
import { api, errorText } from '../api.ts';
import { LedgerProvider, useLedger } from '../store.tsx';
import { TripView } from './Trips.tsx';
import { Bookings } from '../components/Bookings.tsx';
import { SimpleView } from './Simple.tsx';
import { APP_NAME, Logo, fmtDate } from '../components/ui.tsx';

function SharedInner({ token, simple, onRefresh }: { token: string; simple: boolean; onRefresh: () => Promise<void> }) {
  const { state, me } = useLedger();
  const [scope, setScope] = useState('');
  const person = state.shared_person_id != null ? me : null;
  const family = !!state.shared_bookings_only;
  const trip = state.trips[0];
  if (!person && !trip) return null;
  // Bookings first on the phone while a trip is on or coming up (person links: each of their trips).
  const live = state.trips.filter((t) => !t.end_date || t.end_date >= new Date().toLocaleDateString('en-CA')).filter((t) => (state.plan ?? []).some((p) => p.trip_id === t.id && p.kind === 'booking'));
  return (
    <div className="shared">
      <header className="shared-head">
        <span className="brand" style={{ padding: 0 }}><span className="mark"><Logo size={16} /></span><span>{APP_NAME}</span></span>
        <span className="row">
          {!person && !family && <a className="btn" href={simple ? `#/s/${token}` : `#/s/${token}/simple`} data-testid="shared-toggle">{simple ? 'Full view' : 'Simple view'}</a>}
          <span className="badge">View only</span>
        </span>
      </header>
      <main className={simple || person ? 'main simple-main' : 'main'} style={{ margin: '0 auto' }}>
        <div className="page-head">
          <div>
            <h1>{person ? person.name : trip!.name}</h1>
            <div className="sub">{person ? 'Only the entries you are part of, and where things stand' : family ? (trip!.start_date ? `${fmtDate(trip!.start_date)} – ${fmtDate(trip!.end_date)}` : 'Bookings') : `${trip!.start_date ? `${fmtDate(trip!.start_date)} – ${fmtDate(trip!.end_date)} · ` : ''}${trip!.currency}${trip!.notes ? ` · ${trip!.notes}` : ''}`}</div>
          </div>
        </div>
        {family ? <Bookings trip={trip!} shareToken={token} /> : (
          <>
            {(person || simple) && live.map((t) => <section key={t.id} className="stack tight" style={{ marginBottom: 24 }}>{person && <h2>{t.name} · bookings</h2>}<Bookings trip={t} shareToken={token} /></section>)}
            {person ? <SimpleView scope={scope} onScope={setScope} /> : simple ? <SimpleView scope={String(trip!.id)} /> : <TripView trip={trip!} shareToken={token} onRefresh={onRefresh} />}
          </>
        )}
        <p className="faint small" style={{ marginTop: 24 }}>{family ? 'Shared read-only: the trip’s bookings, nothing about money.' : 'Shared read-only. Amounts stay in the currency they were spent in; nothing here can be edited.'}</p>
      </main>
    </div>
  );
}

export function SharedPage({ token, simple = false }: { token: string; simple?: boolean }) {
  const [state, setState] = useState<LedgerState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<LedgerState>('GET', `/api/shared/${token}`).then(setState).catch((e) => setErr(errorText(e)));
  }, [token]);
  if (err) {
    return (
      <div className="center-box down">
        <h2>This link doesn’t work anymore</h2>
        <p className="muted">{err}</p>
      </div>
    );
  }
  if (!state) return <div className="center-box"><span className="pulse" aria-hidden /><p className="muted">Opening the shared trip…</p></div>;
  return (
    <LedgerProvider initialState={state} readOnly>
      <SharedInner token={token} simple={simple} onRefresh={async () => setState(await api<LedgerState>('GET', `/api/shared/${token}`))} />
    </LedgerProvider>
  );
}
