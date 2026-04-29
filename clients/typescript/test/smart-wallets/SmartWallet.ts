import type { Wallet } from '../utils/wallet.ts';

export interface SmartWallet extends Wallet {
    readonly name: string;
}
