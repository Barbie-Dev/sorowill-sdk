// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { waitFor } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { WillStatus, type Will } from '../src/types';
import type { SoroWillClient, SoroWillClientOptions } from '../src/SoroWillClient';

const mockWills: Will[] = [
  {
    id: '1',
    owner: 'GOWNER',
    token: 'CTOKEN',
    balance: '1000000000',
    beneficiaries: [{ address: 'GBEN', percentage: 100 }],
    checkinPeriodDays: 90,
    gracePeriodDays: 7,
    lastCheckin: new Date('2026-01-01'),
    triggerTime: null,
    status: WillStatus.Active,
    guardians: [],
    guardianVotes: 0,
  },
];

const constructedClients: Array<{ network: string; destroy: ReturnType<typeof vi.fn> }> = [];

vi.mock('../src/SoroWillClient', () => ({
  SoroWillClient: class {
    network: string;
    destroy = vi.fn();
    constructor(options: { network: string }) {
      this.network = options.network;
      constructedClients.push(this);
    }
    getWill = vi.fn().mockImplementation((willId: string) => {
      if (willId === '999') return Promise.reject(new Error('Will not found'));
      return Promise.resolve(mockWills[0]);
    });
    getWillsByOwner = vi.fn().mockImplementation((owner: string) => {
      if (owner === 'GUNKNOWN') return Promise.reject(new Error('Owner not found'));
      return Promise.resolve(mockWills);
    });
    getWillsByBeneficiary = vi.fn().mockImplementation((beneficiary: string) => {
      if (beneficiary === 'GUNKNOWN') return Promise.reject(new Error('Beneficiary not found'));
      return Promise.resolve(mockWills);
    });
  },
}));

import { useWill, useWillsByBeneficiary, useWillsByOwner } from '../src/react/hooks';

const CLIENT_OPTIONS = { network: 'testnet' as const, contractId: 'CABC' };

// Regression guard for #216: useWillsByOwner/useWillsByBeneficiary assume
// SoroWillClient's read methods resolve to a plain Will[] when called without
// pagination options. Never invoked at runtime — this only needs to typecheck,
// and fails to if that assumption ever drifts (e.g. the no-options overload
// starts returning a wrapper object).
function _assertWillsReturnTypeUnwrapped(client: SoroWillClient) {
  expectTypeOf(client.getWillsByOwner('G...')).resolves.toEqualTypeOf<Will[]>();
  expectTypeOf(client.getWillsByBeneficiary('G...')).resolves.toEqualTypeOf<Will[]>();
}
void _assertWillsReturnTypeUnwrapped;

describe('useWill', () => {
  beforeEach(() => {
    constructedClients.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('starts with loading state', () => {
    const { result } = renderHook(() => useWill(CLIENT_OPTIONS, '1'));
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('returns data after loading', async () => {
    const { result } = renderHook(() => useWill(CLIENT_OPTIONS, '1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeDefined();
    expect(result.current.data?.id).toBe('1');
    expect(result.current.error).toBeNull();
  });

  it('returns error on failure', async () => {
    const { result } = renderHook(() => useWill(CLIENT_OPTIONS, '999'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeDefined();
    expect(result.current.error?.message).toBe('Will not found');
    expect(result.current.data).toBeNull();
  });

  it('returns null data when willId is null', () => {
    const { result } = renderHook(() => useWill(CLIENT_OPTIONS, null));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('refetch re-runs the query', async () => {
    const { result } = renderHook(() => useWill(CLIENT_OPTIONS, '1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeDefined();

    await act(async () => {
      result.current.refetch();
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeDefined();
  });

  it('recreates the client when clientOptions.network changes', () => {
    const { rerender } = renderHook(
      (options: SoroWillClientOptions) => useWill(options, '1'),
      { initialProps: CLIENT_OPTIONS as SoroWillClientOptions },
    );
    expect(constructedClients).toHaveLength(1);
    expect(constructedClients[0]?.network).toBe('testnet');

    rerender({ ...CLIENT_OPTIONS, network: 'mainnet' });
    expect(constructedClients).toHaveLength(2);
    expect(constructedClients[1]?.network).toBe('mainnet');
  });

  it('calls client.destroy() on unmount', () => {
    const { unmount } = renderHook(() => useWill(CLIENT_OPTIONS, '1'));
    expect(constructedClients).toHaveLength(1);
    const client = constructedClients[0]!;

    unmount();
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it('works under StrictMode double-invoked effects', async () => {
    const { result } = renderHook(() => useWill(CLIENT_OPTIONS, '1'), {
      wrapper: StrictMode,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.id).toBe('1');
    expect(result.current.error).toBeNull();
  });
});

describe('useWillsByOwner', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns wills after loading', async () => {
    const { result } = renderHook(() => useWillsByOwner(CLIENT_OPTIONS, 'GOWNER'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('returns error on failure', async () => {
    const { result } = renderHook(() => useWillsByOwner(CLIENT_OPTIONS, 'GUNKNOWN'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeDefined();
    expect(result.current.data).toBeNull();
  });

  it('returns null when owner is null', () => {
    const { result } = renderHook(() => useWillsByOwner(CLIENT_OPTIONS, null));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('works under StrictMode double-invoked effects', async () => {
    const { result } = renderHook(() => useWillsByOwner(CLIENT_OPTIONS, 'GOWNER'), {
      wrapper: StrictMode,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });
});

describe('useWillsByBeneficiary', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns wills after loading', async () => {
    const { result } = renderHook(() => useWillsByBeneficiary(CLIENT_OPTIONS, 'GBEN'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('returns error on failure', async () => {
    const { result } = renderHook(() => useWillsByBeneficiary(CLIENT_OPTIONS, 'GUNKNOWN'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeDefined();
    expect(result.current.data).toBeNull();
  });

  it('returns null when beneficiary is null', () => {
    const { result } = renderHook(() => useWillsByBeneficiary(CLIENT_OPTIONS, null));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('works under StrictMode double-invoked effects', async () => {
    const { result } = renderHook(() => useWillsByBeneficiary(CLIENT_OPTIONS, 'GBEN'), {
      wrapper: StrictMode,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });
});
