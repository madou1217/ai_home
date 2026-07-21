export const ACCOUNT_LIST_LOAD_MESSAGE_KEY = 'accounts-load-failed';
export const CHAT_ACCOUNT_LIST_LOAD_MESSAGE_KEY = 'chat-accounts-load-failed';
export const CHAT_PROJECT_LIST_LOAD_MESSAGE_KEY = 'chat-project-load-failed';
export const CHAT_PROJECT_SESSIONS_LOAD_MESSAGE_KEY = 'chat-project-sessions-load-failed';
export const CHAT_SESSION_HISTORY_LOAD_MESSAGE_KEY = 'chat-session-history-load-failed';

export function showLoadFailureMessage(messageApi, key, content) {
  messageApi.error({ key, content });
}

export function clearLoadFailureMessage(messageApi, key) {
  messageApi.destroy(key);
}
