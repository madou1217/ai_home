interface LoadFailureMessageApi {
  destroy(key: string): void;
  error(options: { key: string; content: string }): void;
}

export const ACCOUNT_LIST_LOAD_MESSAGE_KEY: string;
export const CHAT_ACCOUNT_LIST_LOAD_MESSAGE_KEY: string;
export const CHAT_PROJECT_LIST_LOAD_MESSAGE_KEY: string;
export const CHAT_PROJECT_SESSIONS_LOAD_MESSAGE_KEY: string;
export const CHAT_SESSION_HISTORY_LOAD_MESSAGE_KEY: string;

export function showLoadFailureMessage(
  messageApi: LoadFailureMessageApi,
  key: string,
  content: string,
): void;

export function clearLoadFailureMessage(
  messageApi: LoadFailureMessageApi,
  key: string,
): void;
