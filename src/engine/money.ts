// Money is always an integer count of minor units (cents, paise, ...). No floats touch balances.
const DECIMALS: Record<string, number> = {
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  CLP: 0, ISK: 0, JPY: 0, KRW: 0, PYG: 0, UGX: 0, VND: 0, XAF: 0, XOF: 0,
};

export const decimalsOf = (currency: string): number => DECIMALS[currency.toUpperCase()] ?? 2;

/** "1,234.50" -> 123450 (for a 2-decimal currency). Returns null for anything that is not a clean number. */
export function parseAmount(text: string, currency: string): number | null {
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text.replace(/[,\s_]/g, ''));
  if (!m || (!m[2] && !m[3])) return null;
  const d = decimalsOf(currency);
  const frac = (m[3] ?? '').padEnd(d, '0');
  if (frac.length > d) return null; // more decimals than the currency has
  const minor = Number((m[2] || '0') + frac);
  if (!Number.isSafeInteger(minor)) return null;
  return m[1] && minor ? -minor : minor;
}

/** 123450 -> "SGD 1,234.50". Pass withCode=false for a bare "1,234.50". */
export function formatAmount(minor: number, currency: string, withCode = true): string {
  const d = decimalsOf(currency);
  const unit = 10 ** d;
  const abs = Math.abs(minor);
  const fracPart = abs % unit;
  const intPart = (abs - fracPart) / unit;
  const body = new Intl.NumberFormat('en-US').format(intPart) + (d ? '.' + String(fracPart).padStart(d, '0') : '');
  return (minor < 0 ? '-' : '') + (withCode ? currency + ' ' : '') + body;
}

/** 123450 -> "1234.50" (plain, for inputs). */
export function toMajor(minor: number, currency: string): string {
  const d = decimalsOf(currency);
  const unit = 10 ** d;
  const abs = Math.abs(minor);
  const frac = abs % unit;
  return (minor < 0 ? '-' : '') + String((abs - frac) / unit) + (d ? '.' + String(frac).padStart(d, '0') : '');
}

/**
 * Split `total` (minor units, may be negative) across `weights` using the largest-remainder
 * method. Deterministic: ties go to the earlier index. The parts always sum to `total`.
 * Weights may be fractional (percentages such as 33.33); they are scaled to integers first.
 */
export function allocate(total: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(total)) throw new Error('total must be an integer in minor units');
  if (weights.length === 0) return [];
  const scaled = weights.map((w) => {
    if (!Number.isFinite(w) || w < 0) throw new Error('weights must be non-negative numbers');
    return BigInt(Math.round(w * 1e6));
  });
  const W = scaled.reduce((a, b) => a + b, 0n);
  if (W === 0n) throw new Error('weights must not all be zero');
  const T = BigInt(Math.abs(total));
  const parts = scaled.map((w) => Number((T * w) / W));
  const order = scaled.map((w, i) => ({ i, r: (T * w) % W })).sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  let left = Math.abs(total) - parts.reduce((a, b) => a + b, 0);
  for (const { i } of order) {
    if (left === 0) break;
    if (scaled[i] === 0n) continue; // a zero-weight participant never receives a rounding unit
    parts[i] = (parts[i] ?? 0) + 1;
    left -= 1;
  }
  return total < 0 ? parts.map((p) => -p) : parts;
}

export const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
