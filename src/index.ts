/**
 * Public API surface of @sorowill/sdk.
 *
 * Everything exported from this module is part of the stable, semver-covered
 * API. Internal implementation types (e.g. Soroban's `xdr.ScVal`, the contract
 * spec adapter, RPC endpoint pool, debug logger) are intentionally NOT
 * re-exported and may change in any release. Import raw Soroban types from
 * `@stellar/stellar-sdk` directly if you need them.
 */
export { SoroWillClient, parseWillId, SoroWillInvalidIdError } from './SoroWillClient';
export { MAX_CHECKIN_PERIOD_DAYS } from './SoroWillClient';
export type {
  EventSubscription,
  EventSubscriptionOptions,
  EventSubscriptionTransport,
  RpcRetryOptions,
  SoroWillClientOptions,
  SoroWillNetwork,
  SoroWillRpcServer,
  SoroWillReadCacheOptions,
} from './SoroWillClient';
export { DEFAULT_CONTRACT_IDS } from './SoroWillClient';

export { HookManager } from './hooks';
export type {
  AfterInvokeContext,
  AfterInvokeHook,
  BeforeInvokeContext,
  BeforeInvokeHook,
  HookRegistry,
} from './hooks';

export {
  MultisigCollector,
  buildMultisigTransactionXdr,
  signWithSecretKey,
} from './multisig';
export type {
  CollectedSignature,
  MultisigCollectorOptions,
} from './multisig';

export {
  buildFeeBumpXdr,
  signFeeBumpXdr,
  submitFeeBump,
  submitFeeBumpTransaction,
  validateInnerTransactionSequence,
  StaleTransactionSequenceError,
} from './feeBump';
export type {
  FeeBumpOptions,
  SubmitFeeBumpOptions,
} from './feeBump';

export { SimulationResultError } from './txValidation';
export type {
  SimulationResponse,
  TransactionMatchOptions,
} from './txValidation';

export type {
  BatchOperation,
  BatchResult,
  Beneficiary,
  CreateWillParams,
  PaginatedWillsResult,
  PaginationOptions,
  RequestOptions,
  SoroWillEvent,
  UpdateBeneficiariesParams,
  Will,
} from './types';
export { WillStatus, WillErrorCode } from './types';

export {
  FreighterWalletAdapter,
  connectWallet,
  freighterAdapter,
  getDefaultWalletAdapter,
  getPublicKey,
  isFreighterInstalled,
  isFreighterInstallCheckError,
  isSignTransactionTimeoutError,
  isWalletNetworkMismatchError,
  isWalletSessionError,
  signTransaction,
  WalletSessionError,
} from './wallet';
export type {
  WalletAdapter,
  WalletAdapterError,
  WalletConnection,
  WalletSession,
} from './wallet';
export type { WalletAdapter, WalletConnection, WalletSessionOptions } from './wallet';

export { createAlbedoAdapter } from './adapters/albedo';
export type { AlbedoAdapterOptions } from './adapters/albedo';
export {
  LocalStorageWalletConnectSessionStore,
  MemoryWalletConnectSessionStore,
  WalletConnectAdapter,
  WalletConnectTimeoutError,
} from './walletConnect';
export type {
  WalletConnectAdapterOptions,
  WalletConnectClient,
  WalletConnectConnectResult,
  WalletConnectSession,
  WalletConnectSessionNamespace,
  WalletConnectSessionStore,
} from './walletConnect';

export {
  IndexedDbCachePersistenceAdapter,
  LocalStorageCachePersistenceAdapter,
  MemoryCachePersistenceAdapter,
  ReadCache,
  createReadCacheKey,
} from './cache';
export type { CachePersistenceAdapter, PersistedCacheEntry, ReadCacheOptions } from './cache';

export {
  addEventListener,
  unsubscribeFromWillEvents,
} from './events';
export type {
  WillEvent,
  WillEventListener,
  WillEventSource,
  WillEventSubscription,
} from './events';

export {
  AccountNotFundedError,
  AlreadyClaimedError,
  AlreadyVotedError,
  BeneficiaryNotFoundError,
  BeneficiaryValidationError,
  CheckinNotDueError,
  CheckinPeriodExceedsTtlError,
  ConfirmationWindowExpiredError,
  DuplicateBeneficiaryError,
  DuplicateGuardianError,
  DuplicateOperationError,
  ExorbitantFeeError,
  FixedAmountExceedsBalanceError,
  FreighterInstallCheckError,
  GracePeriodExpiredError,
  GracePeriodNotExpiredError,
  GuardianCooldownActiveError,
  HookExecutionError,
  HookRecursionError,
  InsufficientBalanceError,
  InvalidContractIdError,
  InvalidDayCountError,
  InvalidGuardianThresholdError,
  InvalidPaginationOptionsError,
  InvalidPercentageError,
  InvalidPercentagesError,
  InvalidPeriodError,
  InvalidPreimageError,
  InvalidPublicKeyError,
  InvalidSecretKeyError,
  InvalidSplitError,
  InvalidTokenError,
  InvalidTransactionXdrError,
  InvokeFailedError,
  KeeperBountyExceedsMaxError,
  MergeWouldExceedLimitsError,
  MultisigTimeoutError,
  NotGuardianError,
  GuardianValidationError,
  InvalidCursorError,
  NotOwnerError,
  NotSameOwnerError,
  OwnerCannotBeGuardianError,
  RequestTimeoutError,
  RequestQueueOverflowError,
  SameWillIdError,
  SignTransactionTimeoutError,
  SimulationError,
  SoroWillError,
  SoroWillInvalidAmountError,
  SoroWillRestoreRequiredError,
  TooManyBeneficiariesError,
  TooManyGuardiansError,
  TooManyIdsError,
  TooManyWillsError,
  TransactionSubmissionError,
  WalletNetworkMismatchError,
  WebSocketNotConfiguredError,
  WillContractError,
  WillNotActiveError,
  WillNotBothActiveError,
  WillNotConfirmedError,
  WillNotFoundError,
  WillNotReleasedError,
  WillNotSettledError,
  WillNotTriggeredError,
  ZeroAmountError,
  mapContractError,
  registerContractError,
  registerContractErrors,
  setContractErrorMap,
  getContractErrorMap,
  UnsupportedBatchSizeError,
  UnknownContractErrorCodeError,
} from './errors';
export type { ContractErrorFactory } from './errors';

export {
  DEFAULT_MAX_QUEUE_SIZE,
  RequestQueue,
  RequestPriority,
  getSharedRequestQueue,
  releaseSharedRequestQueue,
} from './requestQueue';
export type { RequestQueueOptions } from './requestQueue';

export { buildSep7TxUri, parseSep7Callback } from './sep7';
export { SEP7_MAX_ENVELOPE_BYTES, SEP7_MAX_URI_LENGTH } from './sep7';
export type { BuildSep7TxUriOptions, Sep7CallbackResult } from './sep7';

export {
  HanaWalletAdapter,
  HotWalletAdapter,
  LedgerWalletAdapter,
  LobstrWalletAdapter,
} from './adapters';
export type {
  InjectedWalletProvider,
  LedgerStellarApp,
  LedgerTransport,
  LedgerWalletAdapterOptions,
  LobstrSessionClient,
  LobstrWalletAdapterOptions,
  SignTransactionOptions,
} from './adapters';

export {
  MAX_BENEFICIARIES,
  MAX_GUARDIANS,
  calculateShares,
  deepFreezeObject,
  formatDeadline,
  formatTokenAmount,
  formatUSDC,
  getNextActionableState,
  getTimeUntilCheckin,
  hasDuplicateBeneficiaries,
  isBeneficiary,
  isCheckinDue,
  isGuardian,
  toStroops,
  validateBeneficiaries,
  validateGuardians,
} from './utils';
export type { NextActionableState } from './utils';

export {
  DEFAULT_NETWORK,
  getDefaultContractId,
  resolveSoroWillConfig,
} from './config';
export type { SoroWillConfig, SoroWillConfigInput } from './config';
