import SignClient from '@walletconnect/sign-client';
import { SessionTypes } from '@walletconnect/types';
import { fromBase64, fromBech32, toHex } from '@cosmjs/encoding';
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

const modal = new WalletConnectModal({
    projectId: process.env.VITE_WALLET_CONNECT_PROJECT_ID || '',
    chains: ['cosmos:cosmoshub-4'],
    // chains: ['cosmos:theta-testnet-001'],
});

export class WalletConnectWallet implements AbstractWallet {
    name: WalletName = WalletName.WalletConnect;
    chainId: string;
    registry: Registry;
    conf: WalletArgument;
    signClient: SignClient | null;
    session: SessionTypes.Struct | null;
    aminoTypes = new AminoTypes({
        ...createDefaultAminoConverters(),
        ...createWasmAminoConverters(),
    });

    constructor(arg: WalletArgument, registry: Registry) {
        // this.chainId =
        //     arg.chainId === 'cosmoshub-4'
        //         ? 'cosmos:cosmoshub-4'
        //         : arg.chainId || 'cosmos:cosmoshub-4';
        this.chainId = 'cosmos:theta-testnet-001';
        this.registry = registry;
        this.session = null;
        this.signClient = null;
        this.conf = arg;
    }

    async connect() {
        this.signClient = await SignClient.init({
            projectId: process.env.VITE_WALLET_CONNECT_PROJECT_ID || '',
            metadata: {
                name: 'TODO My Cosmos dApp',
                description: 'TODO A dApp for Cosmos',
                url: 'https://my-cosmos-dapp.com',
                icons: ['https://my-cosmos-dapp.com/icon.png'],
            },
        });
        const { uri, approval } = await this.signClient.connect({
            requiredNamespaces: {
                cosmos: {
                    methods: [
                        'cosmos_getAccounts',
                        'cosmos_signDirect',
                        'cosmos_signAmino',
                    ],
                    // chains: [this.chainId],
                    chains: ['cosmos:theta-testnet-001'],
                    events: ['chainChanged', 'accountsChanged'],
                },
            },
        });

        if (uri) {
            await modal.openModal({ uri });
        }

        this.session = await approval();
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
            value: accountFromSigner.pubkey,
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
        // base64 decode
        const pubKeyBytes = fromBase64(accountFromSigner.pubkey.toString());
        // secp256k1
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
        console.log(signDoc);

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
        console.log(signature, signed);

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
        const txRaw = TxRaw.fromPartial({
            bodyBytes: signedTxBodyBytes,
            authInfoBytes: signedAuthInfoBytes,
            signatures: [fromBase64(signature.signature)],
        });
        console.log(txRaw);
        return txRaw;
    }
}
