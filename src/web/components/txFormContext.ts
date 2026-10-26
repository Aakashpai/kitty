import { createContext, useContext } from 'react';
import type { Tx, TxInput } from '../../engine/index.ts';

export type OpenTxForm = (opts?: { initial?: Partial<TxInput>; existing?: Tx; onSaved?: (tx: Tx) => void }) => void;
export const TxFormCtx = createContext<OpenTxForm>(() => {});
export const useTxForm = () => useContext(TxFormCtx);
