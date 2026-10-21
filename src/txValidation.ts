/**
 * Transaction-match validation for prepared Soroban transactions.
 *
 * ## What this module validates
 *
 * {@link assertPreparedTransactionMatchesIntendedOperation} verifies that a
 * *prepared* transaction (the version produced by
 * `rpc.Server.prepareTransaction()` / fee-bumping, which may have been
 * rewritten by the RPC node) still performs exactly the operations the caller
 * originally intended. It is the guard against a hostile or buggy RPC node
 * silently swapping, reordering, or mutating operations between simulation
 * and submission.
 *
 * ## Supported operations
 *
 * Every Stellar operation type is covered, in one of two comparison modes:
 *
 * 1. **Soroban contract invocations**
 *    (`INVOKE_HOST_FUNCTION` / `HOST_FUNCTION_TYPE_INVOKE_CONTRACT`) are
 *    compared field-by-field:
 *    - the host-function discriminant must match,
 *    - the invoked contract address must match,
 *    - the function name must match,
 *    - every `ScVal` argument must match pairwise (compared as base64 XDR).
 *
 * 2. **All other operation types** (e.g. `PAYMENT`, `CREATE_ACCOUNT`,
 *    `CHANGE_TRUST`, `MANAGE_SELL_OFFER`, `BEGIN_SPONSORING_RESERVES`) are
 *    compared as whole operations: the base64 XDR of the intended and
 *    prepared operations must be byte-identical.
 *
 * In both modes the operation *count* of the two transaction envelopes must
 * also match, and the check is applied index-by-index so reordering is
 * detected. Fee-bump envelopes are supported: operations are read from the
 * inner (v1) transaction.
 *
 * When a `simulationResponse` is supplied, its `status` is checked first —
 * a non-`"SUCCESS"` simulation throws {@link SimulationResultError} before any
 * structural comparison happens.
 *
 * ## Example
 *
 * @example
 * ```ts
 * import { Server, TransactionBuilder } from '@stellar/stellar-sdk';
 * import { assertPreparedTransactionMatchesIntendedOperation } from '@sorowill/sdk';
 *
 * const server = new Server(rpcUrl, { allowHttp: true });
 * const intended = TransactionBuilder.fromXDR(intendedXdr, networkPassphrase);
 *
 * // prepareTransaction() may rewrite fees, resource limits, etc.
 * const prepared = await server.prepareTransaction(intended);
 * const simulation = await server.simulateTransaction(prepared);
 *
 * assertPreparedTransactionMatchesIntendedOperation({
 *   context: 'create_will',
 *   networkPassphrase,
 *   intendedTransactionXdr: intended.toXDR(),
 *   preparedTransactionXdr: prepared.toXDR(),
 *   simulationResponse: simulation,
 * });
 * // Safe to sign and submit `prepared`.
 * ```
 */
import { TransactionBuilder, xdr } from '@stellar/stellar-sdk';

export interface TransactionMatchOptions {
  intendedTransactionXdr: string;
  preparedTransactionXdr: string;
  networkPassphrase: string;
  context: string;
  /**
   * Optional Soroban simulation response associated with the prepared
   * transaction.  When provided, the simulation's `status` field is checked
   * before any structural comparison is performed.  A status other than
   * `"SUCCESS"` throws {@link SimulationResultError} immediately so that
   * invalid prepared transactions are caught before they reach the network.
   *
   * Pass the raw object returned by `rpc.Server.simulateTransaction()` (or
   * `rpc.Server.prepareTransaction()`'s underlying simulation response).
   */
  simulationResponse?: SimulationResponse;
}

/**
 * Minimal shape of a Soroban RPC simulation response needed for status
 * validation.  Using a structural type avoids a hard dependency on the
 * `@stellar/stellar-sdk` RPC type hierarchy.
 */
export interface SimulationResponse {
  /** `"SUCCESS"` indicates a simulation that the contract accepted. */
  status?: string;
  /** Human-readable error detail returned by the RPC node on failure. */
  error?: string;
}

/**
 * Raised by {@link assertPreparedTransactionMatchesIntendedOperation} when the
 * accompanying Soroban simulation response does not carry a `"SUCCESS"` status.
 *
 * A prepared transaction backed by a failed simulation will be rejected
 * on-chain, so throwing here saves a full RPC submission round-trip.
 */
export class SimulationResultError extends Error {
  /**
   * The status value returned by the simulation, e.g. `"ERROR"` or
   * `"FAILED"`.  Never embedded in the message because it may contain raw
   * contract addresses or other request-specific data.
   */
  readonly simulationStatus: string | undefined;
  /**
   * The raw error string from the simulation response, if present.  Kept as a
   * structured property rather than embedded in the message for the same
   * privacy reasons as {@link simulationStatus}.
   */
  readonly simulationError: string | undefined;

  constructor(
    context: string,
    simulationStatus: string | undefined,
    simulationError: string | undefined,
    options?: ErrorOptions,
  ) {
    super(
      `Soroban simulation for ${context} did not succeed — the prepared transaction should not be submitted.`,
      options,
    );
    this.name = 'SimulationResultError';
    this.simulationStatus = simulationStatus;
    this.simulationError = simulationError;
  }
}

function operationsMatch(intended: xdr.Operation, prepared: xdr.Operation): boolean {
  const intendedType = intended.body().switch();
  const preparedType = prepared.body().switch();

  if (intendedType !== preparedType) {
    return false;
  }

  if (intendedType === xdr.OperationType.invokeHostFunction()) {
    const intendedOp = intended.body().invokeHostFunctionOp();
    const preparedOp = prepared.body().invokeHostFunctionOp();

    if (!intendedOp || !preparedOp) {
      return false;
    }

    const intendedHostFn = intendedOp.hostFunction();
    const preparedHostFn = preparedOp.hostFunction();

    if (!intendedHostFn || !preparedHostFn) {
      return false;
    }

    if (intendedHostFn.switch() !== preparedHostFn.switch()) {
      return false;
    }

    if (intendedHostFn.switch() === xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
      const intendedInvoke = intendedHostFn.invokeContract();
      const preparedInvoke = preparedHostFn.invokeContract();

      if (
        intendedInvoke.contractAddress().toXDR('base64') !==
          preparedInvoke.contractAddress().toXDR('base64') ||
        intendedInvoke.functionName().toString() !== preparedInvoke.functionName().toString()
      ) {
        return false;
      }

      const intendedArgs = intendedInvoke.args();
      const preparedArgs = preparedInvoke.args();

      if (!intendedArgs || !preparedArgs || intendedArgs.length !== preparedArgs.length) {
        return false;
      }

      for (let i = 0; i < intendedArgs.length; i++) {
        if (intendedArgs[i]!.toXDR('base64') !== preparedArgs[i]!.toXDR('base64')) {
          return false;
        }
      }

      return true;
    }

    return false;
  }

  return prepared.toXDR('base64') === intended.toXDR('base64');
}

function readOperationsFromEnvelope(
  transactionXdr: string,
  networkPassphrase: string,
): xdr.Operation[] {
  const transaction = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
  const envelope = transaction.toEnvelope() as unknown as {
    v0?: () => { tx: () => { operations: () => xdr.Operation[] } };
    v1?: () => { tx: () => { operations: () => xdr.Operation[] } };
    feeBump?: () => {
      tx: () => {
        innerTx: () => {
          v1: () => { tx: () => { operations: () => xdr.Operation[] } };
        };
      };
    };
  };

  if (typeof envelope.v1 === 'function') {
    try {
      return envelope.v1().tx().operations();
    } catch {
      // fall through and try the remaining envelope variants
    }
  }

  if (typeof envelope.v0 === 'function') {
    try {
      return envelope.v0().tx().operations();
    } catch {
      // fall through and try the remaining envelope variants
    }
  }

  if (typeof envelope.feeBump === 'function') {
    try {
      return envelope.feeBump().tx().innerTx().v1().tx().operations();
    } catch {
      // fall through to the final error below
    }
  }

  throw new Error('Unable to decode transaction operations from XDR envelope');
}

/**
 * Asserts that a prepared transaction still performs exactly the operations
 * the caller intended to submit.
 *
 * See the module-level documentation above for the full description of what
 * is compared. In summary, the following checks are performed in order:
 *
 * 1. If `options.simulationResponse` is provided, its `status` must be
 *    `"SUCCESS"` (otherwise {@link SimulationResultError} is thrown).
 * 2. Both XDR envelopes are decoded and their operation lists compared —
 *    operation counts must be equal.
 * 3. Each operation pair (compared index-by-index) must match:
 *    - Soroban `INVOKE_HOST_FUNCTION` contract invocations: host-function
 *      type, contract address, function name, and every `ScVal` argument are
 *      compared field-by-field (arguments as base64 XDR).
 *    - All other operation types (e.g. `PAYMENT`, `CREATE_ACCOUNT`,
 *      `CHANGE_TRUST`, `MANAGE_SELL_OFFER`): the whole operation must be
 *      byte-identical (base64 XDR equality).
 *
 * Fee-bump envelopes are supported — operations are read from the inner
 * transaction. Throws a plain `Error` describing the mismatch otherwise.
 *
 * @example
 * ```ts
 * assertPreparedTransactionMatchesIntendedOperation({
 *   context: 'create_will',
 *   networkPassphrase: networks.TESTNET.passphrase,
 *   intendedTransactionXdr: intendedTx.toXDR(),
 *   preparedTransactionXdr: preparedTx.toXDR(),
 * });
 * ```
 */
export function assertPreparedTransactionMatchesIntendedOperation(
  options: TransactionMatchOptions,
): void {
  // Check the simulation result status before doing any structural validation.
  // A prepared transaction backed by a failed simulation will be rejected
  // on-chain, so we surface the problem here rather than at submission time.
  if (options.simulationResponse !== undefined) {
    const status = options.simulationResponse.status;
    if (status !== undefined && status !== 'SUCCESS') {
      throw new SimulationResultError(
        options.context,
        status,
        options.simulationResponse.error,
      );
    }
  }

  const intendedOperations = readOperationsFromEnvelope(
    options.intendedTransactionXdr,
    options.networkPassphrase,
  );
  const preparedOperations = readOperationsFromEnvelope(
    options.preparedTransactionXdr,
    options.networkPassphrase,
  );

  if (preparedOperations.length !== intendedOperations.length) {
    throw new Error(
      `Prepared transaction for ${options.context} contained ${preparedOperations.length} operation(s), expected ${intendedOperations.length}`,
    );
  }

  for (let index = 0; index < intendedOperations.length; index += 1) {
    const intended = intendedOperations[index];
    const prepared = preparedOperations[index];
    if (!intended || !prepared) {
      throw new Error(`Prepared transaction for ${options.context} was missing operation ${index}`);
    }

    if (!operationsMatch(intended, prepared)) {
      throw new Error(
        `Prepared transaction for ${options.context} did not match the intended operation at index ${index}`,
      );
    }
  }
}
