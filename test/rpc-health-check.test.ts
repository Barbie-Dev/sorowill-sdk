import { describe, expect, it, vi } from 'vitest';
import { SoroWillClient } from '../src/index';

describe('RPC health check (issue #186)', () => {
  it('isHealthy() returns true when server is healthy', async () => {
    const mockServer = {
      getHealth: vi.fn().mockResolvedValue({ status: 'healthy' }),
      simulateTransaction: vi.fn(),
      getAccount: vi.fn(),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      pollTransaction: vi.fn(),
      getContractWasmByContractId: vi.fn(),
    };

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: mockServer as any,
    });

    const result = await client.isHealthy();

    expect(result).toBe(true);
    expect(mockServer.getHealth).toHaveBeenCalled();
  });

  it('isHealthy() returns false when server health check fails', async () => {
    const mockServer = {
      getHealth: vi.fn().mockRejectedValue(new Error('Connection refused')),
      simulateTransaction: vi.fn(),
      getAccount: vi.fn(),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      pollTransaction: vi.fn(),
      getContractWasmByContractId: vi.fn(),
    };

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: mockServer as any,
    });

    const result = await client.isHealthy();

    expect(result).toBe(false);
    expect(mockServer.getHealth).toHaveBeenCalled();
  });

  it('isHealthy() returns false when server throws an error', async () => {
    const mockServer = {
      getHealth: vi.fn().mockRejectedValue(new Error('Timeout')),
      simulateTransaction: vi.fn(),
      getAccount: vi.fn(),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      pollTransaction: vi.fn(),
      getContractWasmByContractId: vi.fn(),
    };

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: mockServer as any,
    });

    const result = await client.isHealthy();

    expect(result).toBe(false);
  });

  it('isHealthy() never throws - network failures resolve to false', async () => {
    const mockServer = {
      getHealth: vi.fn().mockRejectedValue(new Error('Network error')),
      simulateTransaction: vi.fn(),
      getAccount: vi.fn(),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      pollTransaction: vi.fn(),
      getContractWasmByContractId: vi.fn(),
    };

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: mockServer as any,
    });

    // Should not throw
    expect(async () => {
      await client.isHealthy();
    }).not.toThrow();

    const result = await client.isHealthy();
    expect(result).toBe(false);
  });

  it('isHealthy() returns false when server does not have getHealth method', async () => {
    const mockServer = {
      // No getHealth method - custom server implementation
      simulateTransaction: vi.fn(),
      getAccount: vi.fn(),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      pollTransaction: vi.fn(),
      getContractWasmByContractId: vi.fn(),
    };

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: mockServer as any,
    });

    const result = await client.isHealthy();

    // When getHealth is not available, the server is not reported as healthy
    expect(result).toBe(false);
  });
});
