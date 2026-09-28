import * as React from 'react';
import type ReactNamespace from 'react';

import { SoroWillClient } from '../SoroWillClient';
import type { SoroWillClientOptions } from '../SoroWillClient';
import type { Will } from '../types';

/**
 * `react` is an optional peer dependency of this subpath. It is imported
 * statically via ES6 `import` syntax so that ESM-only bundlers (Vite,
 * esbuild, Webpack 5+) can resolve it at build time without relying on
 * CommonJS `require`/`createRequire`, which those bundlers do not support.
 */
const react: typeof ReactNamespace = React;
function getReact(): typeof ReactNamespace {
  return react;
}

/** Standard data-fetching state returned by the hooks. */
export interface UseQueryResult<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /**
   * `true` while a request for a new input is in flight and `data` still
   * holds the result of the previous input. `data` is reset to `null`
   * whenever the input becomes falsy, so it is never stale in that case.
   */
  isStale: boolean;
  refetch: () => void;
}

/**
 * Options that participate in `useSoroWillClient` memoization. Every field
 * listed here is compared by value (or reference for object/function fields)
 * so that changing any of them rebuilds the underlying `SoroWillClient`.
 * Fields not listed here are intentionally ignored for memoization purposes.
 */
const CLIENT_OPTION_KEYS = [
  'network',
  'contractId',
  'wallet',
  'hooks',
  'readCache',
  'retry',
  'eventSource',
  'debug',
] as const satisfies readonly (keyof SoroWillClientOptions)[];

function useSoroWillClient(options: SoroWillClientOptions): SoroWillClient {
  const deps = CLIENT_OPTION_KEYS.map((key) => options[key]);

  const client = getReact().useMemo(
    () => new SoroWillClient(options),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are derived from CLIENT_OPTION_KEYS
    deps,
  );

  // Destroy the client only when it is actually replaced (i.e. the memoized
  // instance changes), not on every effect cleanup. React StrictMode mounts,
  // cleans up, and remounts effects while `useMemo` keeps the same client
  // instance, so destroying in the cleanup would leave the remounted
  // component holding a destroyed client. Tracking the previous instance in a
  // ref lets us tear down the old client on replacement while leaving the
  // current one usable across StrictMode's simulated unmount/remount.
  const previousClientRef = getReact().useRef<SoroWillClient | null>(null);

  getReact().useEffect(() => {
    const previousClient = previousClientRef.current;
    previousClientRef.current = client;

    if (previousClient && previousClient !== client) {
      previousClient.destroy();
    }
  }, [client]);

  return client;
}

/**
 * Fetch a single will by its on-chain ID.
 *
 * @example
 * ```tsx
 * const { data, loading, error } = useWill({ network: 'testnet', contractId: '...' }, '42');
 * ```
 */
export function useWill(
  clientOptions: SoroWillClientOptions,
  willId: string | null,
): UseQueryResult<Will> {
  const client = useSoroWillClient(clientOptions);
  const [data, setData] = getReact().useState<Will | null>(null);
  const [error, setError] = getReact().useState<Error | null>(null);
  const [loading, setLoading] = getReact().useState(false);
  const [isStale, setIsStale] = getReact().useState(false);
  const [fetchKey, setFetchKey] = getReact().useState(0);

  const refetch = React.useCallback(() => setFetchKey((k) => k + 1), []);

  React.useEffect(() => {
    if (!willId) {
      setData(null);
      setError(null);
      setLoading(false);
      setIsStale(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);
    setIsStale(true);

    client
      .getWill(willId, { signal: controller.signal })
      .then((will) => {
        if (!cancelled) {
          setData(will);
          setLoading(false);
          setIsStale(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
          setIsStale(false);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [client, willId, fetchKey]);

  return { data, error, loading, isStale, refetch };
}

/**
 * Fetch all wills owned by a Stellar address.
 *
 * @example
 * ```tsx
 * const { data, loading, error } = useWillsByOwner({ network: 'testnet', contractId: '...' }, 'G...');
 * ```
 */
export function useWillsByOwner(
  clientOptions: SoroWillClientOptions,
  owner: string | null,
): UseQueryResult<Will[]> {
  const client = useSoroWillClient(clientOptions);
  const [data, setData] = getReact().useState<Will[] | null>(null);
  const [error, setError] = getReact().useState<Error | null>(null);
  const [loading, setLoading] = getReact().useState(false);
  const [isStale, setIsStale] = getReact().useState(false);
  const [fetchKey, setFetchKey] = getReact().useState(0);

  const refetch = React.useCallback(() => setFetchKey((k) => k + 1), []);

  React.useEffect(() => {
    if (!owner) {
      setData(null);
      setError(null);
      setLoading(false);
      setIsStale(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);
    setIsStale(true);

    client
      .getWillsByOwner(owner, { signal: controller.signal })
      .then((wills) => {
        if (!cancelled) {
          setData(wills);
          setLoading(false);
          setIsStale(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
          setIsStale(false);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [client, owner, fetchKey]);

  return { data, error, loading, isStale, refetch };
}

/**
 * Fetch all wills where a given address is named as a beneficiary.
 *
 * @example
 * ```tsx
 * const { data, loading, error } = useWillsByBeneficiary({ network: 'testnet', contractId: '...' }, 'G...');
 * ```
 */
export function useWillsByBeneficiary(
  clientOptions: SoroWillClientOptions,
  beneficiary: string | null,
): UseQueryResult<Will[]> {
  const client = useSoroWillClient(clientOptions);
  const [data, setData] = getReact().useState<Will[] | null>(null);
  const [error, setError] = getReact().useState<Error | null>(null);
  const [loading, setLoading] = getReact().useState(false);
  const [isStale, setIsStale] = getReact().useState(false);
  const [fetchKey, setFetchKey] = getReact().useState(0);

  const refetch = React.useCallback(() => setFetchKey((k) => k + 1), []);

  React.useEffect(() => {
    if (!beneficiary) {
      setData(null);
      setError(null);
      setLoading(false);
      setIsStale(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);
    setIsStale(true);

    client
      .getWillsByBeneficiary(beneficiary, { signal: controller.signal })
      .then((wills) => {
        if (!cancelled) {
          setData(wills);
          setLoading(false);
          setIsStale(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
          setIsStale(false);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [client, beneficiary, fetchKey]);

  return { data, error, loading, isStale, refetch };
}
