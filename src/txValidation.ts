import { TransactionBuilder, xdr } from '@stellar/stellar-sdk';

export interface TransactionMatchOptions {
  intendedTransactionXdr: string;
  preparedTransactionXdr: string;
  networkPassphrase: string;
  context: string;
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

export function assertPreparedTransactionMatchesIntendedOperation(
  options: TransactionMatchOptions,
): void {
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
