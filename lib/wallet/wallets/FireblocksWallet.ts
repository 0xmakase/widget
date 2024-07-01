import { Core } from '@walletconnect/core';
import { Web3Wallet, Web3WalletTypes } from '@walletconnect/web3wallet';
import { buildApprovedNamespaces, getSdkError } from '@walletconnect/utils';
// import { fromBase64, fromBech32, toHex } from "@cosmjs/encoding";
import {
    Registry,
    TxBodyEncodeObject,
    encodePubkey,
    makeAuthInfoBytes,
    makeSignDoc,
} from '@cosmjs/proto-signing';
import { AbstractWallet, Account, WalletArgument, WalletName } from '../Wallet';
import { Transaction } from '../../utils/type';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
// import { Any } from "cosmjs-types/google/protobuf/any";
// import { PubKey } from "cosmjs-types/cosmos/crypto/secp256k1/keys";
// import { SignMode } from "cosmjs-types/cosmos/tx/signing/v1beta1/signing";
import { AminoTypes, createDefaultAminoConverters } from '@cosmjs/stargate';
// import { encodeSecp256k1Pubkey, makeSignDoc as makeSignDocAmino } from "@cosmjs/amino";
import { createWasmAminoConverters } from '@cosmjs/cosmwasm-stargate';

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

    async initialize() {
        const core = new Core({
            projectId: process.env.PROJECT_ID,
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
    async onSessionProposal({ id, params }: Web3WalletTypes.SessionProposal) {
        try {
            const approvedNamespaces = buildApprovedNamespaces({
                proposal: params,
                supportedNamespaces: {
                    cosmos: {
                        chains: [`cosmos:${this.chainId}`],
                        methods: [
                            'cosmos_getAccounts',
                            'cosmos_signDirect',
                            'cosmos_signAmino',
                        ],
                        events: ['chainChanged', 'accountsChanged'],
                        // TODO
                        accounts: [
                            `cosmos:${this.chainId}:YOUR_ACCOUNT_ADDRESS`,
                        ],
                    },
                },
            });

            await this.web3wallet.approveSession({
                id,
                namespaces: approvedNamespaces,
            });
        } catch (error) {
            console.error('Session proposal error:', error);
            await this.web3wallet.rejectSession({
                id,
                reason: getSdkError('USER_REJECTED'),
            });
        }
    }

    // TODO
    async onSessionRequest(event: Web3WalletTypes.SessionRequest) {}

    // TODO
    async getAccounts() {
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
