export type PersistedChatSelection = {
  projectPath?: string;
  sessionId?: string;
  provider?: string;
  projectDirName?: string;
};

export declare const CHAT_SELECTION_STORAGE_KEY = "web-chat-selection-v1";

export declare function readSelectionFromSearch(search?: string): PersistedChatSelection;

export declare function readPersistedSelection(options?: {
  storageKey?: string;
  search?: string;
  localStorage?: {
    getItem?: (key: string) => string | null;
  } | null;
}): PersistedChatSelection;

export declare function writePersistedSelection(
  selection: PersistedChatSelection,
  options?: {
    storageKey?: string;
    location?: {
      pathname?: string;
      search?: string;
      hash?: string;
    } | null;
    history?: {
      replaceState?: (data: unknown, unused: string, url?: string | URL | null) => void;
    } | null;
    localStorage?: {
      setItem?: (key: string, value: string) => void;
      removeItem?: (key: string) => void;
    } | null;
  }
): PersistedChatSelection;
