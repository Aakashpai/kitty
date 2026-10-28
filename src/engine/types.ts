// Domain types shared by the engine, the server and the web client.
export type Id = number;

export type TxType = 'expense' | 'transfer' | 'withdrawal' | 'repayment' | 'income' | 'refund';
export const TX_TYPES: TxType[] = ['expense', 'transfer', 'withdrawal', 'repayment', 'income', 'refund'];

export type SplitMethod = 'equal' | 'amount' | 'percent' | 'weight';
export type AccountType = 'cash' | 'bank' | 'card' | 'wallet' | 'other';
export const ACCOUNT_TYPES: AccountType[] = ['cash', 'bank', 'card', 'wallet', 'other'];

export interface Person {
  id: Id;
  name: string;
  is_me: 0 | 1;
  archived: 0 | 1;
  upi_id?: string | null; // e.g. name@upi, used to build payment links in settle-up messages
}

export interface Account {
  id: Id;
  person_id: Id; // owner
  name: string;
  type: AccountType;
  currency: string;
  opening_balance: number; // minor units
  archived: 0 | 1;
}

export interface Trip {
  id: Id;
  name: string;
  start_date: string | null;
  end_date: string | null;
  currency: string; // default currency for the trip's transactions
  notes: string | null;
  archived: 0 | 1;
  members: Id[];
  rates: Record<string, number> | null; // optional overrides: units of home currency per 1 unit of this currency
  budget?: TripBudget | null;
  closed?: 0 | 1; // settled and locked: its entries cannot be added, changed or deleted until reopened
}

/** What the group plans to spend on a trip, in minor units of the home currency: overall and/or per category. */
export interface TripBudget {
  total: number | null;
  categories: Record<string, number>;
}

export interface Split {
  person_id: Id;
  amount: number; // minor units, final allocated share
  input: number | null; // raw percent / weight the user typed (null for equal/amount)
}

/**
 * One row of the ledger. All amounts are integers in the minor unit of their currency.
 *
 * Money legs are uniform across types: money leaves `from_account_id` and arrives in
 * `to_account_id`. `from_amount` / `to_amount` are the amounts in those accounts' own
 * currencies and may be null when the account currency equals `currency` (then = amount).
 *
 * | type       | payer_id            | payee_id  | from_account  | to_account      | splits |
 * | expense    | who paid            | -         | payer's       | -               | yes    |
 * | refund     | who receives refund | -         | -             | recipient's     | yes    |
 * | transfer   | owner (me)          | -         | source        | destination     | -      |
 * | withdrawal | owner (me)          | -         | bank/card     | cash holding    | -      |
 * | repayment  | who pays            | who gets  | payer's       | recipient's     | -      |
 * | income     | who receives        | -         | -             | recipient's     | -      |
 */
export interface Tx {
  id: Id;
  type: TxType;
  date: string; // YYYY-MM-DD
  description: string;
  notes: string | null;
  category: string | null;
  trip_id: Id | null;
  currency: string;
  amount: number;
  payer_id: Id | null;
  payee_id: Id | null;
  from_account_id: Id | null;
  from_amount: number | null;
  to_account_id: Id | null;
  to_amount: number | null;
  fee_amount: number | null; // transfer/withdrawal: fee charged to the from-account, in its currency
  settled_amount: number | null; // repayment: debt reduced, in settled_currency (null = amount/currency)
  settled_currency: string | null;
  linked_tx_id: Id | null; // refund -> original expense
  method: string | null; // repayment: UPI / cash / bank ...; transfer: channel
  reference: string | null;
  split_method: SplitMethod | null;
  full_settlement: 0 | 1; // repayment intended to clear the remaining balance
  splits: Split[];
  created_at: string;
  updated_at: string;
  items?: TxItem[] | null; // itemised bill behind an 'amount' split, kept so it can be edited later
  added_by?: Id | null; // person who recorded it (null for entries from before this was tracked)
  edited_by?: Id | null; // person who last changed it
  recurring_id?: Id | null; // made by a repeating rule
}

export type TxInput = Omit<Tx, 'id' | 'created_at' | 'updated_at'> & { id?: Id };

/** One line of an itemised bill: its price (minor units) is shared equally by `people`. */
export interface TxItem {
  name: string;
  amount: number;
  people: Id[];
}

/** A note on an entry ("what was this?"), visible to everyone who can see the entry. */
export interface Comment {
  id: Id;
  tx_id: Id;
  person_id: Id | null;
  body: string;
  created_at: string;
}

/** A repeating entry: `template` is copied on each `next_date` (weekly, or monthly on the same day of the month). */
export interface Recurring {
  id: Id;
  every: 'weekly' | 'monthly';
  next_date: string;
  template: TxInput;
  created_by: Id | null; // person
}

export interface Reconciliation {
  id: Id;
  account_id: Id;
  date: string;
  counted_amount: number;
  expected_amount: number;
  note: string | null;
  created_at: string;
}

export interface Activity {
  id: Id;
  at: string;
  action: 'create' | 'update' | 'delete' | 'restore' | 'seed';
  entity: string;
  entity_id: Id | null;
  summary: string;
  payload: string | null; // JSON snapshot
}

export interface LedgerCtx {
  people: Person[];
  accounts: Account[];
  trips: Trip[];
  transactions: Tx[];
}

export interface Settings {
  home_currency: string;
  rates: Record<string, number>; // e.g. { SGD: 75, MYR: 24.5 } = home-currency value of one unit
  shortcut_link?: string | null; // iCloud link to the Apple Pay shortcut, so friends can install it in one tap
}

export interface UserPublic {
  id: Id;
  email: string;
  name: string;
  role: 'owner' | 'member';
  person_id: Id | null;
  created_at: string;
  seen_at?: string | null; // when they last dismissed "new from others"
}

export interface Invite {
  id: Id;
  token: string;
  person_id: Id;
  created_by: Id;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

/** A view-only link to one trip. */
export interface Share {
  id: Id;
  token: string;
  trip_id: Id | null; // one trip, or null for everything
  person_id: Id | null; // when set, the link shows only this person's entries and position
  label: string | null;
  created_by: Id | null;
  created_at: string;
  revoked: 0 | 1;
}

export interface LedgerState extends LedgerCtx {
  settings: Settings;
  reconciliations: Reconciliation[];
  activity: Activity[];
  shares: Share[];
  recurring?: Recurring[];
  receipts?: { id: Id; tx_id: Id }[]; // photos are fetched one by one from /api/receipts/:id
  comments?: Comment[];
  user: UserPublic | null; // who is signed in (null for shared read-only views)
  shared_person_id?: Id | null; // person share links: whose point of view the page takes
  users?: UserPublic[]; // owner only
  invites?: Invite[]; // owner only
}

export const emptyTx = (type: TxType = 'expense', date = new Date().toISOString().slice(0, 10), currency = 'USD'): TxInput => ({
  type,
  date,
  description: '',
  notes: null,
  category: null,
  trip_id: null,
  currency,
  amount: 0,
  payer_id: null,
  payee_id: null,
  from_account_id: null,
  from_amount: null,
  to_account_id: null,
  to_amount: null,
  fee_amount: null,
  settled_amount: null,
  settled_currency: null,
  linked_tx_id: null,
  method: null,
  reference: null,
  split_method: null,
  full_settlement: 0,
  splits: [],
});
