// Reads a UPI payment receipt (Google Pay, PhonePe, Paytm…) from the text the iPhone recognises in its screenshot.
import { parseAmount } from './money.ts';

export interface Receipt {
  amount: number | null; // paise
  direction: 'paid' | 'received' | null;
  name: string | null; // the other side, as printed
  upiIds: string[]; // every UPI ID on the receipt (yours too)
  ref: string | null; // UPI transaction ID
  date: string | null; // YYYY-MM-DD
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Text recognition is messy (₹ may come out as "Rs", "%" or "Z"), so every field is looked for loosely and may be null. */
export function parseReceipt(text: string): Receipt {
  const t = text.replace(/\r/g, '').replace(/[  ]/g, ' ');
  const money = /(?:₹|rs\.?|inr|%|z)\s?(\d[\d,]*(?:\.\d{1,2})?)/i.exec(t)?.[1] ?? /^\s*(\d{1,3}(?:,\d{2,3})+(?:\.\d{2})?|\d{1,7}(?:\.\d{2})?)\s*$/m.exec(t)?.[1]; // a bare amount line, never the 12-digit UPI ID
  const amount = money ? parseAmount(money, 'INR') : null;
  // The first "To …" / "Paid to …" or "From …" / "Received from …" line says which way the money went and to whom.
  const side = /^\s*(paid to|sent to|to|received from|from)\b[\s:]+(.+)$/im.exec(t);
  const direction = side ? (/from/i.test(side[1]!) ? 'received' : 'paid') : null;
  const name = side?.[2]!.replace(/\s*[\w.-]+@[a-z]+.*$/i, '').replace(/\s*\(.*$/, '').trim() || null;
  const upiIds = [...new Set([...t.matchAll(/[a-z0-9._-]{2,}@[a-z]{2,}/gi)].map((m) => m[0].toLowerCase()))];
  const ref = /upi\s*(?:transaction|txn|ref(?:erence)?)?\s*(?:id|no\.?|number)?\s*[:\-]?\s*(\d{10,16})/i.exec(t)?.[1] ?? /\b(\d{12})\b/.exec(t)?.[1] ?? null;
  // "28 Oct 2026" or "Oct 28, 2026"
  const dm = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*,?\s+(\d{4})/i.exec(t);
  const md = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})/i.exec(t);
  const [day, mon, year] = dm ? [dm[1]!, dm[2]!, dm[3]!] : md ? [md[2]!, md[1]!, md[3]!] : [];
  const date = day && mon && year ? `${year}-${String(MONTHS.indexOf(mon.toLowerCase().slice(0, 3)) + 1).padStart(2, '0')}-${day.padStart(2, '0')}` : null;
  return { amount: amount && amount > 0 ? amount : null, direction, name, upiIds, ref, date };
}
