export class ApiError extends Error {
  status: number;
  details: string[];
  constructor(status: number, message: string, details: string[] = []) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Thin JSON client. Network failures and 401s are also broadcast so the shell can react. */
let inflight = 0;
const signal = () => window.dispatchEvent(new CustomEvent('ledger:inflight', { detail: inflight }));

export async function api<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  inflight += 1;
  signal();
  try {
    let res: Response;
    try {
      res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
    } catch {
      window.dispatchEvent(new Event('ledger:offline'));
      throw new ApiError(0, 'Lost contact with the ledger. Nothing was changed.');
    }
    const json = (await res.json().catch(() => ({}))) as { error?: string; details?: string[]; code?: string };
    if (res.status === 401 && json.code === 'unauthenticated') window.dispatchEvent(new Event('ledger:unauthenticated'));
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      window.dispatchEvent(new Event('ledger:offline'));
      throw new ApiError(res.status, 'The ledger is unreachable right now. Nothing was changed.');
    }
    if (!res.ok) throw new ApiError(res.status, json.error ?? res.statusText, json.details ?? []);
    return json as T;
  } finally {
    inflight -= 1;
    signal();
  }
}

export const errorText = (e: unknown): string => {
  if (e instanceof ApiError) return e.details.length ? `${e.message}: ${e.details.join('; ')}` : e.message;
  return e instanceof Error ? e.message : String(e);
};

// New entries saved without a connection wait here, on this device only, until the ledger answers again.
export interface Queued { ref: string; body: Record<string, unknown>; at: string; error?: string }
const QUEUE = 'kitty-queue';
export const queued = (): Queued[] => {
  try {
    return JSON.parse(localStorage.getItem(QUEUE) ?? '[]') as Queued[];
  } catch {
    return [];
  }
};
const saveQueue = (q: Queued[]) => {
  try {
    localStorage.setItem(QUEUE, JSON.stringify(q));
  } catch {
    /* private mode: nothing can wait */
  }
  window.dispatchEvent(new Event('ledger:queue'));
};
export const enqueue = (body: Record<string, unknown>) => saveQueue([...queued(), { ref: crypto.randomUUID(), body, at: new Date().toISOString() }]);
export const dropQueued = (ref: string) => saveQueue(queued().filter((q) => q.ref !== ref));

/** Sends waiting entries oldest first and stops at the first lost connection; the ref makes a resend return the first copy. */
export async function flushQueue(): Promise<number> {
  let sent = 0;
  for (const q of queued().filter((x) => !x.error)) {
    try {
      await api('POST', '/api/transactions', { ...q.body, queue_ref: q.ref });
      dropQueued(q.ref);
      sent += 1;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status === 0 || e.status >= 500) break;
      saveQueue(queued().map((x) => (x.ref === q.ref ? { ...x, error: errorText(e) } : x))); // rejected: keep it for the user to fix or drop
    }
  }
  return sent;
}
