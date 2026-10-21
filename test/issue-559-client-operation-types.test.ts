import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SoroWillClient } from '../src/SoroWillClient';

describe('Issue #559: SoroWillClient method operation type indications and examples', () => {
  const clientSourcePath = path.resolve(__dirname, '../src/SoroWillClient.ts');
  const sourceCode = fs.readFileSync(clientSourcePath, 'utf8');

  // List of public instance methods and static factories on SoroWillClient
  const readOnlyMethods = [
    'fromEnv',
    'forNetwork',
    'getWill',
    'getWillsByOwner',
    'getWillsByBeneficiary',
    'isHealthy',
    'getActiveRpcUrl',
    'getContractId',
    'getNetwork',
    'getNetworkFeeStats',
    'flushFeeStatsCache',
    'previewFee',
    'buildTransaction',
    'buildSep7SigningUri',
    'waitForTransaction',
    'subscribeToEvents',
    'reportError',
    'refreshSpec',
    'destroy',
    'assertWalletNetwork',
  ];

  const writeMethods = [
    'createWill',
    'checkIn',
    'emergencyCheckIn',
    'triggerWill',
    'guardianTrigger',
    'releaseInheritance',
    'cancelWill',
    'updateBeneficiaries',
    'topUp',
    'batch',
    'submitSignedTransaction',
  ];

  it('declares all expected public methods on SoroWillClient', () => {
    const proto = SoroWillClient.prototype;
    const allInstanceMethods = [...readOnlyMethods, ...writeMethods].filter(
      (m) => m !== 'fromEnv' && m !== 'forNetwork',
    );

    for (const methodName of allInstanceMethods) {
      expect(
        typeof (proto as unknown as Record<string, unknown>)[methodName],
        `expected SoroWillClient.prototype.${methodName} to be a function`,
      ).toBe('function');
    }

    expect(typeof SoroWillClient.fromEnv).toBe('function');
    expect(typeof SoroWillClient.forNetwork).toBe('function');
  });

  it('documents all read-only methods with operation type and examples in JSDoc', () => {
    for (const methodName of readOnlyMethods) {
      // Find method definition in source code
      const regex = new RegExp(`(/\\*\\*[\\s\\S]*?\\*/)\\s*(?:async\\s+)?(?:static\\s+)?${methodName}\\s*\\(`, 'g');
      const matches = [...sourceCode.matchAll(regex)];
      expect(
        matches.length,
        `Expected JSDoc comment preceding method "${methodName}"`,
      ).toBeGreaterThanOrEqual(1);

      for (const match of matches) {
        const comment = match[1] ?? '';
        const hasReadOnlyIndication =
          comment.includes('Read-only') ||
          comment.includes('@readonly') ||
          comment.includes('read-only');
        expect(
          hasReadOnlyIndication,
          `Method "${methodName}" JSDoc should indicate read-only operation type`,
        ).toBe(true);

        expect(
          comment.includes('@example'),
          `Method "${methodName}" JSDoc should include @example`,
        ).toBe(true);
      }
    }
  });

  it('documents all write methods with operation type and examples in JSDoc', () => {
    for (const methodName of writeMethods) {
      const regex = new RegExp(`(/\\*\\*[\\s\\S]*?\\*/)\\s*(?:async\\s+)?(?:static\\s+)?${methodName}\\s*\\(`, 'g');
      const matches = [...sourceCode.matchAll(regex)];
      expect(
        matches.length,
        `Expected JSDoc comment preceding method "${methodName}"`,
      ).toBeGreaterThanOrEqual(1);

      for (const match of matches) {
        const comment = match[1] ?? '';
        const hasWriteIndication =
          comment.includes('Write') ||
          comment.includes('write') ||
          comment.includes('State-changing');
        expect(
          hasWriteIndication,
          `Method "${methodName}" JSDoc should indicate write / state-changing operation type`,
        ).toBe(true);

        expect(
          comment.includes('@example'),
          `Method "${methodName}" JSDoc should include @example`,
        ).toBe(true);
      }
    }
  });

  it('allows read-only local methods to execute without wallet signing', () => {
    const client = new SoroWillClient({
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      network: 'testnet',
      rpcUrl: 'https://soroban-testnet.stellar.org',
    });

    // Read-only getters do not trigger transactions or throw wallet missing errors
    expect(client.getContractId()).toBe('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM');
    expect(client.getNetwork()).toBe('testnet');
    expect(client.getActiveRpcUrl()).toBe('https://soroban-testnet.stellar.org');

    const report = client.reportError(new Error('Sample test failure'));
    expect(report.name).toBe('Error');
    expect(report.message).toBe('Sample test failure');
    expect(report.contractId).toBe('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM');

    expect(() => client.flushFeeStatsCache()).not.toThrow();
    expect(() => client.destroy()).not.toThrow();
  });
});
