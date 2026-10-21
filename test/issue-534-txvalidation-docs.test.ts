/**
 * Tests for issue #534: assertPreparedTransactionMatchesIntendedOperation
 * doesn't document what operations it validates — the function name is
 * unclear about which operations are covered.
 *
 * Acceptance criteria:
 * - Module comment added
 * - Supported operations documented
 * - Example provided
 *
 * The docs-live-in-source pattern (reading `src/*.ts` and asserting on its
 * content) is the same one used by `package-exports-audit.test.ts` and
 * `dependency-audit.test.ts`.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const TX_VALIDATION_SOURCE = readFileSync(
  join(__dirname, '../src/txValidation.ts'),
  'utf-8',
);

describe('txValidation — issue #534: documented supported operations', () => {
  it('has a module-level comment at the top of the file', () => {
    expect(TX_VALIDATION_SOURCE.startsWith('/**')).toBe(true);
  });

  it('documents what the module validates', () => {
    expect(TX_VALIDATION_SOURCE).toContain('## What this module validates');
    expect(TX_VALIDATION_SOURCE).toContain('assertPreparedTransactionMatchesIntendedOperation');
  });

  it('documents the supported operations', () => {
    expect(TX_VALIDATION_SOURCE).toContain('## Supported operations');
    // Soroban contract invocations are compared field-by-field …
    expect(TX_VALIDATION_SOURCE).toContain('INVOKE_HOST_FUNCTION');
    expect(TX_VALIDATION_SOURCE).toContain('HOST_FUNCTION_TYPE_INVOKE_CONTRACT');
    // … and every other operation type via whole-operation XDR equality.
    expect(TX_VALIDATION_SOURCE).toContain('PAYMENT');
    expect(TX_VALIDATION_SOURCE).toContain('byte-identical');
  });

  it('documents envelope-level behavior (counts, ordering, fee bumps, simulation)', () => {
    expect(TX_VALIDATION_SOURCE).toContain('operation *count*');
    expect(TX_VALIDATION_SOURCE).toContain('Fee-bump');
    expect(TX_VALIDATION_SOURCE).toContain('SimulationResultError');
  });

  it('provides a usage example', () => {
    expect(TX_VALIDATION_SOURCE).toContain('@example');
    // Both the module-level doc and the function doc carry examples.
    expect(TX_VALIDATION_SOURCE.match(/@example/g)?.length).toBeGreaterThanOrEqual(2);
    expect(TX_VALIDATION_SOURCE).toContain('intendedTransactionXdr');
    expect(TX_VALIDATION_SOURCE).toContain('preparedTransactionXdr');
  });

  it('documents the function itself with its comparison order', () => {
    const fnDocIndex = TX_VALIDATION_SOURCE.indexOf(
      'export function assertPreparedTransactionMatchesIntendedOperation',
    );
    expect(fnDocIndex).toBeGreaterThan(0);

    // The doc comment immediately above the exported function.
    const docStart = TX_VALIDATION_SOURCE.lastIndexOf('/**', fnDocIndex);
    const fnDoc = TX_VALIDATION_SOURCE.slice(docStart, fnDocIndex);
    expect(fnDoc).toContain('simulationResponse');
    expect(fnDoc).toContain('INVOKE_HOST_FUNCTION');
    expect(fnDoc).toContain('@example');
  });
});
