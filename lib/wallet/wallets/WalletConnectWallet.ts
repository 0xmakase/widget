import SignClient from '@walletconnect/sign-client';
import { SessionTypes } from '@walletconnect/types';
import { fromBase64 } from '@cosmjs/encoding';
import { Secp256k1 } from '@cosmjs/crypto';
import {
    type Registry,
    type TxBodyEncodeObject,
    type DirectSignResponse,
    type AccountData,
    makeAuthInfoBytes,
    makeSignDoc,
} from '@cosmjs/proto-signing';
import {
    AbstractWallet,
    Account,
    WalletArgument,
    WalletName,
    keyType,
} from '../Wallet';
import { Transaction } from '../../utils/type';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { Any } from 'cosmjs-types/google/protobuf/any';
import { PubKey } from 'cosmjs-types/cosmos/crypto/secp256k1/keys';
import { SignMode } from 'cosmjs-types/cosmos/tx/signing/v1beta1/signing';
import { AminoTypes, createDefaultAminoConverters } from '@cosmjs/stargate';
import {
    type AminoSignResponse,
    makeSignDoc as makeSignDocAmino,
} from '@cosmjs/amino';
import { createWasmAminoConverters } from '@cosmjs/cosmwasm-stargate';
import { WalletConnectModal } from '@walletconnect/modal';

export class WalletConnectWallet implements AbstractWallet {
    name: WalletName = WalletName.WalletConnect;
    chainId: string;
    registry: Registry;
    conf: WalletArgument;
    signClient: SignClient | null = null;
    session: SessionTypes.Struct | null = null;
    aminoTypes = new AminoTypes({
        ...createDefaultAminoConverters(),
        ...createWasmAminoConverters(),
    });
    modal: WalletConnectModal;

    constructor(arg: WalletArgument, registry: Registry) {
        this.chainId =
            arg.chainId === 'cosmoshub-4' || arg.chainId === 'dymension_1100-1'
                ? 'cosmos:' + arg.chainId
                : arg.chainId || 'cosmos:cosmoshub-4';
        this.registry = registry;
        this.conf = arg;
        this.modal = new WalletConnectModal({
            projectId: process.env.VITE_WALLET_CONNECT_PROJECT_ID || '',
            chains: [this.chainId],
        });
        console.log('WalletConnectWallet', this.chainId);
    }

    async initSignClient() {
        this.signClient = await SignClient.init({
            projectId: process.env.VITE_WALLET_CONNECT_PROJECT_ID || '',
            metadata: {
                name: 'Omakase Explorer',
                description:
                    'OmakaseのValidatorとして運用しているブロックチェーンのエクスプローラー',
                url: 'https://omakase-explorer.web.app',
                icons: [
                    'https://raw.githubusercontent.com/0xmakase/blockscout/master/apps/block_scout_web/assets/static/images/omakase-symbol.svg',
                ],
            },
        });
    }

    async connect() {
        if (!this.signClient) {
            await this.initSignClient();
        }

        // NOTE: Restore session SEE: https://docs.walletconnect.com/api/sign/dapp-usage#restoring-a-session
        const lastKeyIndex = this.signClient!.session.getAll().length - 1;
        const lastSession = this.signClient!.session.getAll()[lastKeyIndex];
        if (lastSession) {
            this.session = lastSession;
            return;
        }

        const { uri, approval } = await this.signClient!.connect({
            requiredNamespaces: {
                cosmos: {
                    methods: [
                        'cosmos_getAccounts',
                        'cosmos_signDirect',
                        'cosmos_signAmino',
                    ],
                    chains: [this.chainId],
                    events: ['chainChanged', 'accountsChanged'],
                },
            },
        });

        if (uri) {
            await this.modal.openModal({ uri });
            this.session = await approval();
            this.modal.closeModal();
        }
    }

    async disconnect() {
        if (!this.session) {
            await this.connect();
        }
        await this.signClient!.disconnect({
            topic: this.session!.topic,
            reason: {
                code: 6000,
                message: 'User disconnected',
            },
        });
        this.session = null;
    }

    async getAccounts(): Promise<Account[]> {
        if (!this.session) {
            await this.connect();
        }

        const accounts = await this.signClient!.request<AccountData[]>({
            topic: this.session!.topic,
            chainId: this.chainId,
            request: {
                method: 'cosmos_getAccounts',
                params: {},
            },
        });

        return accounts;
    }

    supportCoinType(_coinType?: string | undefined): Promise<boolean> {
        return Promise.resolve(true);
    }

    async sign(transaction: Transaction): Promise<TxRaw> {
        if (
            transaction.messages.findIndex((x) =>
                x.typeUrl.startsWith('/cosmwasm.wasm')
            ) > -1
        ) {
            return this.signDirect(transaction);
        }
        return this.signAmino(transaction);
    }

    async signDirect(transaction: Transaction): Promise<TxRaw> {
        const accounts = await this.getAccounts();
        const accountFromSigner = accounts[0];

        const pubkey = Any.fromPartial({
            typeUrl: keyType(transaction.chainId),
            value: PubKey.encode({
                key: accountFromSigner.pubkey,
            }).finish(),
        });

        const txBodyEncodeObject: TxBodyEncodeObject = {
            typeUrl: '/cosmos.tx.v1beta1.TxBody',
            value: {
                messages: transaction.messages,
                memo: transaction.memo,
            },
        };

        const txBodyBytes = this.registry.encode(txBodyEncodeObject);
        const gasLimit = Number(transaction.fee.gas);
        const authInfoBytes = makeAuthInfoBytes(
            [{ pubkey, sequence: transaction.signerData.sequence }],
            transaction.fee.amount,
            gasLimit,
            transaction.fee.granter,
            transaction.fee.payer
        );

        const { signature } =
            await this.signClient!.request<DirectSignResponse>({
                topic: this.session!.topic,
                chainId: this.chainId,
                request: {
                    method: 'cosmos_signDirect',
                    params: {
                        signerAddress: accountFromSigner.address,
                        signDoc: makeSignDoc(
                            txBodyBytes,
                            authInfoBytes,
                            transaction.chainId,
                            transaction.signerData.accountNumber
                        ),
                    },
                },
            });

        return TxRaw.fromPartial({
            bodyBytes: txBodyBytes,
            authInfoBytes: authInfoBytes,
            signatures: [fromBase64(signature.signature)],
        });
    }

    async signAmino(tx: Transaction): Promise<TxRaw> {
        const accounts = await this.getAccounts();
        const accountFromSigner = accounts[0];
        const pubKeyBytes = fromBase64(accountFromSigner.pubkey.toString());
        const compressedPubkey = Secp256k1.compressPubkey(pubKeyBytes);
        const pubkey = Any.fromPartial({
            typeUrl: keyType(tx.chainId),
            value: PubKey.encode({
                key: compressedPubkey,
            }).finish(),
        });

        const msgs = tx.messages.map((msg) => this.aminoTypes.toAmino(msg));
        const signDoc = makeSignDocAmino(
            msgs,
            tx.fee,
            tx.chainId,
            tx.memo,
            tx.signerData.accountNumber,
            tx.signerData.sequence
        );

        const { signature, signed } =
            await this.signClient!.request<AminoSignResponse>({
                topic: this.session!.topic,
                chainId: this.chainId,
                request: {
                    method: 'cosmos_signAmino',
                    params: {
                        signerAddress: accountFromSigner.address,
                        signDoc,
                    },
                },
            });

        const signedTxBody = {
            messages: signed.msgs.map((msg) => this.aminoTypes.fromAmino(msg)),
            memo: signed.memo,
        };
        const signedTxBodyEncodeObject: TxBodyEncodeObject = {
            typeUrl: '/cosmos.tx.v1beta1.TxBody',
            value: signedTxBody,
        };
        const signedTxBodyBytes = this.registry.encode(
            signedTxBodyEncodeObject
        );

        const signedGasLimit = Number(signed.fee.gas);
        const signedSequence = Number(signed.sequence);
        const signedAuthInfoBytes = makeAuthInfoBytes(
            [{ pubkey, sequence: signedSequence }],
            signed.fee.amount,
            signedGasLimit,
            signed.fee.granter,
            signed.fee.payer,
            SignMode.SIGN_MODE_LEGACY_AMINO_JSON
        );
        return TxRaw.fromPartial({
            bodyBytes: signedTxBodyBytes,
            authInfoBytes: signedAuthInfoBytes,
            signatures: [fromBase64(signature.signature)],
        });
    }
}
