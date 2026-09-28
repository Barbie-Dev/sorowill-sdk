import { Account, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

const VOID_SCVAL = xdr.ScVal.scvVoid();

// Create a stub spec that can decode will-like data
function makeStubSpec() {
  const rawWill = {
    id: 1n,
    owner: 'GOWNER',
    token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
    balance: 1_000_000n,
    beneficiaries: [{ address: 'GBEN', percentage: 100 }],
    checkin_period_days: 90n,
    grace_period_days: 7n,
    last_checkin: 1_700_000_000n,
    trigger_time: undefined,
    status: 'Active',
    guardians: [],
    guardian_votes: 0,
  };

  return {
    funcArgsToScVals: () => [] as xdr.ScVal[],
    funcResToNative: (method: string, _value: xdr.ScVal) => {
      switch (method) {
        case 'get_wills_by_owner':
        case 'get_wills_by_beneficiary':
          return [rawWill];
        case 'create_will':
          return rawWill.id;
        case 'cancel_will':
          return rawWill.balance;
        default:
          // Every other method (get_will, check_in, trigger_will, ...) decodes
          // to a RawWill shape.
          return rawWill;
      }
    },
  };
}

const stubSpec = makeStubSpec();

// Mock Spec.fromWasm to avoid needing a real WASM binary
vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual('@stellar/stellar-sdk');
  return {
    ...(actual as Record<string, unknown>),
    contract: {
      ...((actual as Record<string, unknown>).contract as Record<string, unknown>),
      Spec: { fromWasm: vi.fn(() => stubSpec) },
    },
  };
});

const TEST_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

vi.mock('../src/wallet', () => ({
  getPublicKey: vi.fn(async () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
  signTransaction: vi.fn(async (tx: string) => tx),
  getDefaultWalletAdapter: vi.fn(() => ({
    isConnected: async () => true,
    connect: async () => ({ publicKey: TEST_ACCOUNT, network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' }),
    reconnect: async () => ({ publicKey: TEST_ACCOUNT, network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' }),
    disconnect: async () => {},
    getPublicKey: async () => TEST_ACCOUNT,
    signTransaction: async (tx: string) => tx,
  })),
}));

import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import { SoroWillError, SoroWillRestoreRequiredError } from '../src/errors';

const WASM_BINARY = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

function makeRpcServer(simImpl?: () => Promise<unknown>, wasmImpl?: () => Promise<Uint8Array>): SoroWillRpcServer {
  return {
    async getContractWasmByContractId(): Promise<Uint8Array> {
      if (wasmImpl) return await wasmImpl();
      return WASM_BINARY;
    },
    async simulateTransaction() {
      if (simImpl) return (await simImpl()) as never;
      return { transactionData: 'AAAA', result: { retval: VOID_SCVAL } } as never;
    },
    async getAccount(address: string) { return new Account(address, '1'); },
    async prepareTransaction(tx: unknown) { return tx as never; },
    async sendTransaction() { return { status: 'PENDING', hash: 'abc123' } as never; },
    async pollTransaction() {
      return { status: 'SUCCESS', createdAt: 1_700_000_000, returnValue: VOID_SCVAL } as never;
    },
  };
}

// ===========================================================================
// Task 1: refreshSpec
// ===========================================================================
describe('refreshSpec', () => {
  it('re-fetches the spec after invalidation', async () => {
    let wasmCalls = 0;

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer(undefined, async () => {
        wasmCalls += 1;
        return WASM_BINARY;
      }) as unknown as SoroWillRpcServer,
    });

    await client.getWill('1');
    expect(wasmCalls).toBe(1);

    await client.getWill('1');
    expect(wasmCalls).toBe(1);

    await client.refreshSpec();
    await client.getWill('1');
    expect(wasmCalls).toBe(2);
  });

  it('returns the freshly-loaded spec', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer() as unknown as SoroWillRpcServer,
    });
    const spec = await client.refreshSpec();
    expect(spec).toBeDefined();
    expect(typeof spec.funcArgsToScVals).toBe('function');
    expect(typeof spec.funcResToNative).toBe('function');
  });
});

// ===========================================================================
// Task 2: specPromise error recovery
// ===========================================================================
describe('specPromise error recovery', () => {
  it('clears cached rejection so next call retries', async () => {
    let wasmCalls = 0;

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer(undefined, async () => {
        wasmCalls += 1;
        if (wasmCalls === 1) throw new Error('temporary network failure');
        return WASM_BINARY;
      }) as unknown as SoroWillRpcServer,
    });

    await expect(client.getWill('1')).rejects.toThrow('temporary network failure');
    expect(wasmCalls).toBe(1);

    await expect(client.getWill('1')).resolves.toBeDefined();
    expect(wasmCalls).toBe(2);
  });

  it('retries after refreshSpec clears poisoned promise', async () => {
    let wasmCalls = 0;

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer(undefined, async () => {
        wasmCalls += 1;
        if (wasmCalls === 1) throw new Error('first fetch fails');
        return WASM_BINARY;
      }) as unknown as SoroWillRpcServer,
    });

    await expect(client.getWill('1')).rejects.toThrow('first fetch fails');
    expect(wasmCalls).toBe(1);

    await client.refreshSpec();
    expect(wasmCalls).toBe(2);
    await expect(client.getWill('1')).resolves.toBeDefined();
  });
});

// ===========================================================================
// Task 3: Restore-required simulation
// ===========================================================================
describe('restore-required simulation', () => {
  it('throws SoroWillRestoreRequiredError for restore response', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer(async () => ({
        transactionData: 'AAAA',
        result: { retval: VOID_SCVAL },
        restorePreamble: { minResourceFee: '100', transactionData: 'AAAA' },
      })),
    });

    try {
      await client.getWill('1');
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SoroWillRestoreRequiredError);
      if (error instanceof SoroWillRestoreRequiredError) {
        expect(error.message).toContain('requires ledger-entry restoration');
        expect(error.simulation).toBeDefined();
      }
    }
  });

  it('throws SoroWillError for non-restore simulation error', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer(async () => ({
        error: 'HostError: something went wrong',
      })),
    });

    await expect(client.getWill('1')).rejects.toThrow(SoroWillError);
    await expect(client.getWill('1')).rejects.toThrow(/simulation failed/);
  });

  it('throws SoroWillError when no result in simulation', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer(async () => ({
        transactionData: 'AAAA',
      })),
    });

    await expect(client.getWill('1')).rejects.toThrow(SoroWillError);
    await expect(client.getWill('1')).rejects.toThrow(/returned no result/);
  });
});

// ===========================================================================
// Task 4: Public methods
// ===========================================================================
describe('SoroWillClient public methods', () => {
  it('getWill returns a mapped Will', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer() as unknown as SoroWillRpcServer,
    });
    const will = await client.getWill('1');
    expect(will.id).toBe('1');
    expect(will.owner).toBe('GOWNER');
    expect(will.status).toBe('Active');
  });

  it('getWillsByOwner returns an array', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer() as unknown as SoroWillRpcServer,
    });
    const wills = await client.getWillsByOwner('GOWNER');
    expect(Array.isArray(wills)).toBe(true);
    expect(wills[0]?.id).toBe('1');
  });

  it('getWillsByBeneficiary returns an array', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer() as unknown as SoroWillRpcServer,
    });
    const wills = await client.getWillsByBeneficiary('GBEN');
    expect(Array.isArray(wills)).toBe(true);
    expect(wills[0]?.id).toBe('1');
  });

  it('createWill returns willId and txHash', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer() as unknown as SoroWillRpcServer,
    });
    const result = await client.createWill({
      token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
      amount: '1000000',
      beneficiaries: [
        { address: 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG', percentage: 100 },
      ],
      checkinPeriodDays: 90,
      gracePeriodDays: 7,
      guardians: [],
    });
    expect(result.willId).toBe('1');
    expect(result.txHash).toBe('abc123');
  });

  it('checkIn returns txHash and nextDeadline', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer() as unknown as SoroWillRpcServer,
    });
    const result = await client.checkIn('1');
    expect(result.txHash).toBe('abc123');
    expect(result.nextDeadline).toBeInstanceOf(Date);
  });

  it('triggerWill returns txHash', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer() as unknown as SoroWillRpcServer,
    });
    const result = await client.triggerWill('1');
    expect(result.txHash).toBe('abc123');
  });

  it('emergencyCheckIn returns txHash and nextDeadline', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer() as unknown as SoroWillRpcServer,
    });
    const result = await client.emergencyCheckIn('1');
    expect(result.txHash).toBe('abc123');
    expect(result.nextDeadline).toBeInstanceOf(Date);
  });

  it('releaseInheritance returns txHash', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer() as unknown as SoroWillRpcServer,
    });
    const result = await client.releaseInheritance('1');
    expect(result.txHash).toBe('abc123');
  });

  it('cancelWill returns txHash and refundAmount', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer() as unknown as SoroWillRpcServer,
    });
    const result = await client.cancelWill('1');
    expect(result.txHash).toBe('abc123');
    expect(result.refundAmount).toBe('1000000');
  });

  it('updateBeneficiaries returns txHash', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer() as unknown as SoroWillRpcServer,
    });
    const result = await client.updateBeneficiaries({
      willId: '1',
      beneficiaries: [
        { address: 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG', percentage: 100 },
      ],
    });
    expect(result.txHash).toBe('abc123');
  });

  it('topUp returns txHash', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer() as unknown as SoroWillRpcServer,
    });
    const result = await client.topUp('1', '500000');
    expect(result.txHash).toBe('abc123');
  });

  it('guardianTrigger returns txHash', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer() as unknown as SoroWillRpcServer,
    });
    const result = await client.guardianTrigger('1');
    expect(result.txHash).toBe('abc123');
  });

  it('destroy does not throw', () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer() as unknown as SoroWillRpcServer,
    });
    expect(() => client.destroy()).not.toThrow();
  });
});
