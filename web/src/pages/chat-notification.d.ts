export declare function normalizeMessageText(value?: string): string;

export declare function shouldNotifyAssistantCompleted(options?: {
  permission?: string;
  visibilityState?: string;
  hasFocus?: boolean;
}): boolean;

export declare function buildAssistantCompletionNotification(
  provider?: string,
  content?: string,
  providerNameMap?: Record<string, string>
): {
  title: string;
  body: string;
};
