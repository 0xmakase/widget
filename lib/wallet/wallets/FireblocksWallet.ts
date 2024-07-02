import { Core } from '@walletconnect/core';
import { Web3Wallet } from '@walletconnect/web3wallet';
import { Registry } from '@cosmjs/proto-signing';
import { AbstractWallet, Account, WalletArgument, WalletName } from '../Wallet';
import { Transaction } from '../../utils/type';
import { AminoTypes, createDefaultAminoConverters } from '@cosmjs/stargate';
import { createWasmAminoConverters } from '@cosmjs/cosmwasm-stargate';
import {
    FireblocksSDK,
    Web3ConnectionFeeLevel,
    Web3ConnectionType,
} from 'fireblocks-sdk';

export class FireblocksWallet implements AbstractWallet {
    name: WalletName = WalletName.Fireblocks;
    chainId: string;
    registry: Registry;
    aminoTypes = new AminoTypes({
        ...createDefaultAminoConverters(),
        ...createWasmAminoConverters(),
    });
    web3wallet!: InstanceType<typeof Web3Wallet>;

    constructor(arg: WalletArgument, registry: Registry) {
        this.chainId = arg.chainId || 'cosmoshub';
        this.registry = registry;
    }

    async initializeWeb3Wallet() {
        console.log(process.env);
        const core = new Core({
            projectId: process.env.VITE_WALLET_CONNECT_PROJECT_ID,
        });

        this.web3wallet = await Web3Wallet.init({
            core,
            metadata: {
                name: 'Fireblocks Wallet',
                description: 'Fireblocks Wallet for Cosmos',
                url: 'https://fireblocks.com',
                icons: [
                    'https://fireblocks.com/wp-content/uploads/2021/04/cropped-favicon-192x192.png',
                ],
            },
        });
    }

    // TODO
    async getAccounts(): Promise<Account[]> {
        if (!this.web3wallet) {
            await this.initializeWeb3Wallet();
        }
        try {
            const { uri } = await this.web3wallet.core.pairing.create();

            console.log('WalletConnect URI:', uri);

            const fireblocks = new FireblocksSDK(
                process.env.VITE_FIREBLOCKS_SECRET_KEY || '',
                process.env.VITE_FIREBLOCKS_API_KEY || '',
                process.env.VITE_FIREBLOCKS_API_BASE_URL || ''
            );

            const connectionResponse = await fireblocks.createWeb3Connection(
                Web3ConnectionType.WALLET_CONNECT,
                {
                    feeLevel: Web3ConnectionFeeLevel.MEDIUM,
                    vaultAccountId: 0,
                    uri,
                }
            );

            console.log(connectionResponse);

            const result = await fireblocks.submitWeb3Connection(
                Web3ConnectionType.WALLET_CONNECT,
                connectionResponse.id,
                true
            );
            console.log(result);
        } catch (error) {
            console.error('Error connecting to dApp:', error);
            throw error;
        }
        return [];
    }

    supportCoinType(coinType?: string): Promise<boolean> {
        return Promise.resolve(true);
    }

    async sign(transaction: Transaction) {
        if (
            transaction.messages.findIndex((x) =>
                x.typeUrl.startsWith('/cosmwasm.wasm')
            ) > -1
        ) {
            return this.signDirect(transaction);
        }
        return this.signAmino(transaction);
    }

    // TODO
    async signDirect(tx: Transaction) {}

    // TODO
    async signAmino(tx: Transaction) {}
}
