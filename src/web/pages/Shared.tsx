import { useEffect, useState } from 'react';
import type { LedgerState } from '../../engine/index.ts';
import { api, errorText } from '../api.ts';
import { LedgerProvider, useLedger } from '../store.tsx';
import { TripView } from './Trips.tsx';
import { APP_NAME, Logo, fmtDate } from '../components/ui.tsx';

function SharedInner() {
  const { state } = useLedger();
  const trip = state.trips[0];
  if (!trip) return null;
  return (
    <div className="shared">
      <header className="shared-head">
        <span className="brand" style={{ padding: 0 }}><span className="mark"><Logo size={16} /></span><span>{APP_NAME}</span></span>
        <span className="badge">View only</span>
      </header>
      <main className="main" style={{ margin: '0 auto' }}>
        <div className="page-head">
          <div>
            <h1>{trip.name}</h1>
            <div className="sub">{trip.start_date ? `${fmtDate(trip.start_date)} – ${fmtDate(trip.end_date)} · ` : ''}{trip.currency}{trip.notes ? ` · ${trip.notes}` : ''}</div>
          </div>
        </div>
        <TripView trip={trip} />
        <p className="faint small" style={{ marginTop: 24 }}>Shared read-only. Amounts stay in the currency they were spent in; nothing here can be edited.</p>
      </main>
    </div>
  );
}

export function SharedPage({ token }: { token: string }) {
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
      <SharedInner />
    </LedgerProvider>
  );
}
