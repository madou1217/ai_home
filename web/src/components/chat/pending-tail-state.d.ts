export declare function resolvePendingTailState(input: {
  messages: Array<{ role?: string; pending?: boolean }>;
  loading?: boolean;
  externalPending?: boolean;
  loadingStatusText?: string;
  externalPendingStatusText?: string;
  activeProvider?: string;
}): {
  visible: boolean;
  statusText: string;
};
