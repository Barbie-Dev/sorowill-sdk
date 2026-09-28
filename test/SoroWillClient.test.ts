// @ts-nocheck -- mock SDK types are fundamentally incompatible with real @stellar/stellar-sdk types
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { freighterApiMock, mockState } = vi.hoisted(() => ({
  freighterApiMock: {
    getAddress: vi.fn(async () => ({ address: 'GTESTACCOUNT', error: undefined })),
    requestAccess: vi.fn(),
    getNetworkDetails: vi.fn().mockResolvedValue({ network: 'TESTNET', networkPassphrase: 'TESTNET' }),
    isConnected: vi.fn(),
    signTransaction: vi.fn(),
  },
  mockState: {
    createdServerUrls: [] as string[],
    getAccount: vi.fn(async (publicKey: string) => ({ accountId: publicKey, sequence: '1' })),
    getContractWasmByContractId: vi.fn(async () => new Uint8Array()),
    pollTransaction: vi.fn(),
    prepareTransaction: vi.fn(async (tx: { toXDR: () => string }) => ({ toXDR: tx.toXDR })),
    sendTransaction: vi.fn(),
    simulateTransaction: vi.fn(),
  },
}));

vi.mock('@stellar/freighter-api', () => ({
  default: freighterApiMock,
}));

vi.mock('@stellar/stellar-sdk', async () => {
  const { StrKey } = await vi.importActual<typeof import('@stellar/stellar-sdk')>(
    '@stellar/stellar-sdk',
  );

  class MockAccount {
    constructor(
      public readonly accountId: string,
      public readonly sequence: string,
    ) {}
  }

  class MockContract {
    constructor(private readonly id: string) {}

    contractId(): string {
      return this.id;
    }

    call(method: string, ...args: unknown[]): { contractId: string; method: string; args: unknown[] } {
      return { contractId: this.id, method, args };
    }
  }

  class MockServer {
    constructor(public readonly url: string) {
      mockState.createdServerUrls.push(url);
    }

    getAccount = mockState.getAccount;
    getContractWasmByContractId = mockState.getContractWasmByContractId;
    pollTransaction = mockState.pollTransaction;
    prepareTransaction = mockState.prepareTransaction;
    sendTransaction = mockState.sendTransaction;
    simulateTransaction = mockState.simulateTransaction;
  }

  class MockTransactionBuilder {
    private operation: unknown;

    constructor(
      private readonly account: MockAccount,
      private readonly options: { fee: string; networkPassphrase: string },
    ) {}

    addOperation(operation: unknown): this {
      this.operation = operation;
      return this;
    }

    setTimeout(_timeout: number): this {
      return this;
    }

    build(): {
      source: string;
      fee: string;
      networkPassphrase: string;
      operation: unknown;
      toXDR: () => string;
    } {
      return {
        source: this.account.accountId,
        fee: this.options.fee,
        networkPassphrase: this.options.networkPassphrase,
        operation: this.operation,
        toXDR: () => 'TX_XDR',
      };
    }

    static fromXDR(_xdr: string, _networkPassphrase: string): unknown {
      return new MockTransaction();
    }
  }

  class MockTransaction {
    toXDR(): string {
      return 'TX_XDR';
    }
  }

  class MockFeeBumpTransaction {}

  return {
    Account: MockAccount,
    BASE_FEE: '100',
    Contract: MockContract,
    StrKey,
    Networks: {
      PUBLIC: 'PUBLIC',
      TESTNET: 'TESTNET',
    },
    Transaction: MockTransaction,
    FeeBumpTransaction: MockFeeBumpTransaction,
    TransactionBuilder: MockTransactionBuilder,
    contract: {
      Spec: Object.assign(
        function Spec(_entries?: unknown) {
          return {
            funcArgsToScVals: (_method: string, args: Record<string, unknown>) => [args],
            funcResToNative: (_method: string, value: unknown) => value,
          };
        },
        {
          fromWasm: () => ({
            funcArgsToScVals: (_method: string, args: Record<string, unknown>) => [args],
            funcResToNative: (_method: string, value: unknown) => value,
          }),
        },
      ),
    },
    rpc: {
      Api: {
        GetTransactionStatus: {
          SUCCESS: 'SUCCESS',
        },
        isSimulationError: (simulation: { error?: string }) => Boolean(simulation.error),
        isSimulationRestore: () => false,
      },
      Server: MockServer,
    },
    xdr: {
      ScVal: {
        scvVoid: () => ({}),
      },
      Operation: {},
      TransactionEnvelope: {
        fromXDR: () => ({
          switch: () => ({}),
          v1: () => ({
            tx: () => ({
              operations: () => [],
            }),
          }),
          toXDR: () => ({ toString: () => '' }),
        }),
      },
      EnvelopeType: {
        envelopeTypeTx: () => ({}),
        envelopeTypeTxFeeBump: () => ({}),
      },
      DecoratedSignature: {
        fromXDR: () => ({}),
      },
    },
  };
});

import { SoroWillClient } from '../src/SoroWillClient';
import { WillStatus, WillErrorCode, type EventSubscription, type SoroWillEvent } from '../src/types';
import { WebSocketNotConfiguredError } from '../src/errors';

function rawWill(id: number): {
  balance: bigint;
  beneficiaries: Array<{ address: string; percentage: number }>;
  checkin_period_days: bigint;
  grace_period_days: bigint;
  guardian_votes: number;
  guardians: string[];
  id: bigint;
  last_checkin: bigint;
  owner: string;
  status: WillStatus;
  token: string;
  trigger_time: bigint | undefined;
} {
  return {
    id: BigInt(id),
    owner: `GOWNER${id}`,
    token: `CTOKEN${id}`,
    balance: 1_000_000n * BigInt(id),
    beneficiaries: [{ address: `GBEN${id}`, percentage: 100 }],
    checkin_period_days: 90n,
    grace_period_days: 7n,
    last_checkin: 1_700_000_000n,
    trigger_time: undefined,
    status: WillStatus.Active,
    guardians: [],
    guardian_votes: 0,
  };
}

describe('SoroWillClient', () => {
  beforeEach(() => {
    mockState.createdServerUrls.length = 0;
    mockState.getAccount.mockClear();
    mockState.getContractWasmByContractId.mockClear();
    mockState.pollTransaction.mockReset();
    mockState.prepareTransaction.mockClear();
    mockState.sendTransaction.mockReset();
    mockState.simulateTransaction.mockReset();
    freighterApiMock.getAddress.mockClear();
  });

  it('constructs from environment variables', () => {
    const client = SoroWillClient.fromEnv({
      SOROWILL_NETWORK: 'mainnet',
      SOROWILL_CONTRACT_ID: 'CCONTRACT',
      SOROWILL_RPC_URL: 'https://rpc.example',
      SOROWILL_EVENT_RPC_URL: 'https://rpc-events.example',
      SOROWILL_EVENT_STREAM_URL: 'wss://stream.example/events',
      SOROWILL_EVENTS_POLL_INTERVAL_MS: '2500',
    });

    expect(client).toBeInstanceOf(SoroWillClient);
    expect(mockState.createdServerUrls).toContain('https://rpc.example');
    expect((client as unknown as { eventRpcUrl: string }).eventRpcUrl).toBe('https://rpc-events.example');
    expect((client as unknown as { eventStreamUrl: string }).eventStreamUrl).toBe('wss://stream.example/events');
  });

  it('supports client-side pagination for owner listings across multiple pages', async () => {
    mockState.simulateTransaction.mockResolvedValue({
      result: { retval: [rawWill(1), rawWill(2), rawWill(3)] },
    });

    const client = new SoroWillClient({ network: 'testnet', contractId: 'CCONTRACT' });
    const firstPage = await client.getWillsByOwner('GOWNER', { pageSize: 2 });
    if (Array.isArray(firstPage)) throw new Error('Expected paginated result');
    const secondPageOpts: Record<string, unknown> = { pageSize: 2 };
    if (firstPage.nextCursor) secondPageOpts.cursor = firstPage.nextCursor;
    const secondPage = await client.getWillsByOwner('GOWNER', secondPageOpts as never);
    if (Array.isArray(secondPage)) throw new Error('Expected paginated result');

    expect(firstPage.wills.map((will: { id: string }) => will.id)).toEqual(['1', '2']);
    expect(firstPage.nextCursor).toBe('2');
    expect(secondPage.wills.map((will: { id: string }) => will.id)).toEqual(['3']);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('supports client-side pagination for beneficiary listings across multiple pages', async () => {
    mockState.simulateTransaction.mockResolvedValue({
      result: { retval: [rawWill(4), rawWill(5), rawWill(6)] },
    });

    const client = new SoroWillClient({ network: 'testnet', contractId: 'CCONTRACT' });
    const firstPage = await client.getWillsByBeneficiary('GBEN', { pageSize: 1 });
    if (Array.isArray(firstPage)) throw new Error('Expected paginated result');
    const secondPageOptsB: Record<string, unknown> = { pageSize: 1 };
    if (firstPage.nextCursor) secondPageOptsB.cursor = firstPage.nextCursor;
    const secondPage = await client.getWillsByBeneficiary('GBEN', secondPageOptsB as never);
    if (Array.isArray(secondPage)) throw new Error('Expected paginated result');

    expect(firstPage.wills.map((will: { id: string }) => will.id)).toEqual(['4']);
    expect(firstPage.nextCursor).toBe('1');
    expect(secondPage.wills.map((will: { id: string }) => will.id)).toEqual(['5']);
    expect(secondPage.nextCursor).toBe('2');
  });

  it('returns an empty array from getWillsByOwner when the owner has zero wills', async () => {
    mockState.simulateTransaction.mockResolvedValue({
      result: { retval: [] },
    });

    const client = new SoroWillClient({ network: 'testnet', contractId: 'CCONTRACT' });
    const wills = await client.getWillsByOwner('GNEWWALLET');

    expect(wills).toEqual([]);
  });

  it('returns an empty array from getWillsByBeneficiary when the address is named in zero wills', async () => {
    mockState.simulateTransaction.mockResolvedValue({
      result: { retval: [] },
    });

    const client = new SoroWillClient({ network: 'testnet', contractId: 'CCONTRACT' });
    const wills = await client.getWillsByBeneficiary('GNEWWALLET');

    expect(wills).toEqual([]);
  });

  it('previews Soroban resource fees for create_will and top_up without submitting', async () => {
    mockState.simulateTransaction.mockImplementation(async (tx: { operation: { method: string } }) => ({
      minResourceFee: tx.operation.method === 'create_will' ? '1500' : '2750',
      result: { retval: undefined },
    }));

    const client = new SoroWillClient({ network: 'testnet', contractId: 'CCONTRACT' });

    await expect(
      client.previewFee('create_will', {
        owner: 'GTESTACCOUNT',
        token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
        amount: 1000n,
      }),
    ).resolves.toEqual({ resourceFee: '1500' });

    await expect(
      client.previewFee('top_up', {
        will_id: 1n,
        owner: 'GTESTACCOUNT',
        amount: 500n,
      }),
    ).resolves.toEqual({ resourceFee: '2750' });

    expect(mockState.sendTransaction).not.toHaveBeenCalled();
  });

  it('WillErrorCode matches contract error codes', () => {
    expect(WillErrorCode.WillNotFound).toBe(1);
    expect(WillErrorCode.NotOwner).toBe(2);
    expect(WillErrorCode.WillNotActive).toBe(3);
    expect(WillErrorCode.WillNotTriggered).toBe(4);
    expect(WillErrorCode.GracePeriodNotExpired).toBe(5);
    expect(WillErrorCode.GracePeriodExpired).toBe(6);
    expect(WillErrorCode.InvalidPercentages).toBe(7);
    expect(WillErrorCode.AlreadyVoted).toBe(8);
    expect(WillErrorCode.NotGuardian).toBe(9);
    expect(WillErrorCode.CheckinNotDue).toBe(10);
    expect(WillErrorCode.ZeroAmount).toBe(11);
    expect(WillErrorCode.TooManyBeneficiaries).toBe(12);
  });

  it('subscribes to events over polling transport', async () => {
    const seen: SoroWillEvent[] = [];
    let subscription: EventSubscription | undefined;

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: {
          events: [
            {
              id: 'evt-1',
              pagingToken: '1',
              ledger: 123,
              contractId: 'CCONTRACT',
              txHash: 'abc',
              type: 'contract',
              topics: ['will_created'],
              value: { will_id: '1' },
            },
          ],
          nextCursor: '1',
        },
      }),
    }));

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CCONTRACT',
      fetch: fetchMock as unknown as typeof fetch,
      defaultPollIntervalMs: 1,
    });

    subscription = await client.subscribeToEvents(
      (event) => {
        seen.push(event);
        subscription?.close();
      },
      { transport: 'polling', pollIntervalMs: 1 },
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(subscription.transport).toBe('polling');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(seen.map((event) => event.id)).toEqual(['evt-1']);
  });

  it('throws WebSocketNotConfiguredError when transport: "websocket" is explicitly requested but unconfigured', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CCONTRACT',
    });

    await expect(
      client.subscribeToEvents(() => {}, { transport: 'websocket' }),
    ).rejects.toThrow(WebSocketNotConfiguredError);
  });

  it('skips WASM fetch when specJson is provided', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CCONTRACT',
      specJson: new Uint8Array(),
    });

    mockState.simulateTransaction.mockResolvedValue({
      result: { retval: rawWill(1) },
    });

    await client.getWill('1');

    // The cached spec path skips getContractWasmByContractId entirely
    expect(mockState.getContractWasmByContractId).not.toHaveBeenCalled();
  });

  it('falls back to lazy WASM fetch when specJson is not provided', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CCONTRACT',
    });

    mockState.simulateTransaction.mockResolvedValue({
      result: { retval: rawWill(1) },
    });

    await client.getWill('1');

    expect(mockState.getContractWasmByContractId).toHaveBeenCalled();
  });

  it('subscribes to events over WebSocket transport and falls back to polling when streaming is unavailable', async () => {
    const websocketEvents: SoroWillEvent[] = [];
    const fallbackEvents: SoroWillEvent[] = [];

    const webSocketFactory = vi.fn((url: string) => {
      const socket = {
        close: vi.fn(),
        onclose: null as ((event: { code?: number; reason?: string }) => void) | null,
        onerror: null as ((event: Event | unknown) => void) | null,
        onmessage: null as ((event: { data: string }) => void) | null,
        onopen: null as ((event: Event | unknown) => void) | null,
        send: vi.fn(() => {
          queueMicrotask(() => {
            socket.onmessage?.({
              data: JSON.stringify({
                result: {
                  events: [
                    {
                      id: 'evt-ws-1',
                      pagingToken: '5',
                      ledger: 200,
                      contractId: 'CCONTRACT',
                      type: 'contract',
                      topics: ['checked_in'],
                      value: { will_id: '10' },
                    },
                  ],
                },
              }),
            });
          });
        }),
      };

      queueMicrotask(() => {
        if (url.includes('unsupported')) {
          socket.onerror?.(new Event('error'));
          return;
        }
        socket.onopen?.(new Event('open'));
      });

      return socket;
    });

    const fallbackFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: {
          events: [
            {
              id: 'evt-poll-1',
              pagingToken: '6',
              ledger: 201,
              contractId: 'CCONTRACT',
              type: 'contract',
              topics: ['guardian_triggered'],
              value: { will_id: '11' },
            },
          ],
          nextCursor: '6',
        },
      }),
    }));

    const wsClient = new SoroWillClient({
      network: 'testnet',
      contractId: 'CCONTRACT',
      webSocketFactory,
      eventStreamUrl: 'wss://stream.example/events',
    });

    const wsSubscription = await wsClient.subscribeToEvents((event: SoroWillEvent) => {
      websocketEvents.push(event);
    }, { transport: 'websocket' });

    await Promise.resolve();
    await Promise.resolve();

    expect(wsSubscription.transport).toBe('websocket');
    expect(websocketEvents.map((event) => event.id)).toEqual(['evt-ws-1']);

    let fallbackSubscription: EventSubscription | undefined;
    const fallbackClient = new SoroWillClient({
      network: 'testnet',
      contractId: 'CCONTRACT',
      eventStreamUrl: 'wss://unsupported.example/events',
      fetch: fallbackFetch as unknown as typeof fetch,
      webSocketFactory,
      defaultPollIntervalMs: 1,
    });

    fallbackSubscription = await fallbackClient.subscribeToEvents((event: SoroWillEvent) => {
      fallbackEvents.push(event);
      fallbackSubscription?.close();
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(fallbackSubscription.transport).toBe('polling');
    expect(fallbackFetch).toHaveBeenCalledTimes(1);
    expect(fallbackEvents.map((event) => event.id)).toEqual(['evt-poll-1']);
  });

  it('throws SoroWillError when TransactionBuilder.fromXDR returns a FeeBumpTransaction instead of a plain Transaction during invoke()', async () => {
    const { TransactionBuilder, FeeBumpTransaction } = await import('@stellar/stellar-sdk');
    const origFromXdr = TransactionBuilder.fromXDR;
    TransactionBuilder.fromXDR = vi.fn().mockReturnValue(new FeeBumpTransaction());
    freighterApiMock.signTransaction.mockResolvedValue({ signedTxXdr: 'SIGNED_TX_XDR', error: undefined });
    mockState.simulateTransaction.mockResolvedValue({ result: { retval: undefined } });

    try {
      const client = new SoroWillClient({
        network: 'testnet',
        contractId: 'CCONTRACT',
      });

      await expect(
        client.createWill({
          token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
          beneficiaries: [
            { address: 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG', percentage: 100 },
          ],
          amount: '1000000',
          checkinPeriodDays: 30,
          gracePeriodDays: 7,
          guardians: [],
        }),
      ).rejects.toThrow(/Expected a plain Transaction envelope after signing, but received FeeBumpTransaction/);
    } finally {
      TransactionBuilder.fromXDR = origFromXdr;
    }
  });
});
