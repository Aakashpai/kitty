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
