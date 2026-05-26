import { address, createNoopSigner, type Instruction } from '@solana/kit';
import { describe, expect, test } from 'vitest';
import { filterPayableSubscribers, sendBatchedSubscriberInstructions } from '../../../webapp/src/lib/collect-utils.ts';

const PROGRAM_ADDRESS = address('11111111111111111111111111111111');

function instruction(id: number): Instruction {
    return {
        programAddress: PROGRAM_ADDRESS,
        accounts: [],
        data: new Uint8Array([id]),
    };
}

describe('webapp collection utilities', () => {
    test('filters a zero-balance subscriber before transfer batching', async () => {
        const mint = address('11111111111111111111111111111111');
        const delegator = address('11111111111111111111111111111112');
        const subscriber = {
            subscriptionAddress: 'sub-zero-balance',
            delegator,
            amount: 1n,
        };
        const rpc = {
            getAccountInfo: () => ({
                send: async () => ({
                    value: {
                        data: {
                            parsed: {
                                info: {
                                    mint,
                                    owner: delegator,
                                    tokenAmount: { amount: '0' },
                                    delegate: '11111111111111111111111111111113',
                                    delegatedAmount: { amount: '18446744073709551615' },
                                },
                            },
                        },
                    },
                }),
            }),
        };

        const result = await filterPayableSubscribers({
            rpc,
            subscribers: [subscriber],
            mint,
            tokenProgram: PROGRAM_ADDRESS,
            programAddress: PROGRAM_ADDRESS,
        });

        expect(result.payable).toEqual([]);
        expect(result.failures).toEqual([
            {
                subscriber,
                reason: 'insufficient-balance',
                message: 'Subscriber token account balance is below the collectible amount',
            },
        ]);
    });

    test('isolates a failing subscriber and continues sending valid transfers', async () => {
        const signer = createNoopSigner(address('11111111111111111111111111111112'));
        const failingInstruction = instruction(2);
        const sentInstructionIds: number[][] = [];

        const result = await sendBatchedSubscriberInstructions({
            feePayer: signer,
            transfers: [
                {
                    subscriber: {
                        subscriptionAddress: 'sub-1',
                        delegator: 'delegator-1',
                        amount: 1n,
                    },
                    instruction: instruction(1),
                },
                {
                    subscriber: {
                        subscriptionAddress: 'sub-2',
                        delegator: 'delegator-2',
                        amount: 1n,
                    },
                    instruction: failingInstruction,
                },
                {
                    subscriber: {
                        subscriptionAddress: 'sub-3',
                        delegator: 'delegator-3',
                        amount: 1n,
                    },
                    instruction: instruction(3),
                },
            ],
            sendInstructions: async instructions => {
                sentInstructionIds.push(instructions.map(ix => ix.data[0] ?? -1));
                if (instructions.includes(failingInstruction)) {
                    throw new Error('Transaction simulation failed: insufficient funds');
                }
                return `sig-${sentInstructionIds.length}`;
            },
        });

        expect(result.collected).toBe(2);
        expect(result.signatures).toEqual(['sig-2', 'sig-5']);
        expect(result.failures).toEqual([
            {
                subscriber: {
                    subscriptionAddress: 'sub-2',
                    delegator: 'delegator-2',
                    amount: 1n,
                },
                reason: 'transfer-failed',
                message: 'Transaction simulation failed: insufficient funds',
            },
        ]);
        expect(sentInstructionIds).toEqual([[1, 2, 3], [1], [2, 3], [2], [3]]);
    });

    test('does not split and replay a batch after an ambiguous send error', async () => {
        const signer = createNoopSigner(address('11111111111111111111111111111112'));
        const sentInstructionIds: number[][] = [];

        const result = await sendBatchedSubscriberInstructions({
            feePayer: signer,
            transfers: [
                {
                    subscriber: {
                        subscriptionAddress: 'sub-1',
                        delegator: 'delegator-1',
                        amount: 1n,
                    },
                    instruction: instruction(1),
                },
                {
                    subscriber: {
                        subscriptionAddress: 'sub-2',
                        delegator: 'delegator-2',
                        amount: 1n,
                    },
                    instruction: instruction(2),
                },
            ],
            sendInstructions: async instructions => {
                sentInstructionIds.push(instructions.map(ix => ix.data[0] ?? -1));
                throw new Error('transport lost after broadcast');
            },
        });

        expect(result.collected).toBe(0);
        expect(result.signatures).toEqual([]);
        expect(result.confirmed).toEqual([]);
        expect(result.failures).toEqual([
            {
                subscriber: {
                    subscriptionAddress: 'sub-1',
                    delegator: 'delegator-1',
                    amount: 1n,
                },
                reason: 'transfer-failed',
                message:
                    'Payment batch status is unknown and was not retried automatically: transport lost after broadcast',
            },
            {
                subscriber: {
                    subscriptionAddress: 'sub-2',
                    delegator: 'delegator-2',
                    amount: 1n,
                },
                reason: 'transfer-failed',
                message:
                    'Payment batch status is unknown and was not retried automatically: transport lost after broadcast',
            },
        ]);
        expect(sentInstructionIds).toEqual([[1, 2]]);
    });
});
