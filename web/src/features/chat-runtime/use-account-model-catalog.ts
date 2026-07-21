import { useCallback, useEffect, useState } from 'react';
import {
  getAccountDefaultModel,
  listAccountEnabledModels,
} from '@/components/chat/account-model-selection.js';
import { modelsAPI } from '@/services/api';

interface ModelCatalogEntry {
  readonly models: readonly string[];
  readonly defaultModel: string;
}

export interface AccountModelCatalog extends ModelCatalogEntry {
  readonly loading: boolean;
  readonly error?: string;
  readonly retry: () => void;
}

const catalogCache = new Map<string, ModelCatalogEntry>();

export function useAccountModelCatalog(accountRef?: string): AccountModelCatalog {
  const key = String(accountRef || '').trim();
  const cached = key ? catalogCache.get(key) : undefined;
  const [state, setState] = useState<Omit<AccountModelCatalog, 'retry'>>(() => initialState(cached));
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    if (!key) {
      setState({ models: [], defaultModel: '', loading: false });
      return;
    }
    let disposed = false;
    const existing = catalogCache.get(key);
    setState({ ...(existing || emptyEntry()), loading: true });
    void modelsAPI.listCatalog({ accountRef: key }).then(
      (catalog) => {
        const entry = {
          models: listAccountEnabledModels(catalog, key),
          defaultModel: getAccountDefaultModel(catalog, key),
        };
        const retained = entry.models.length > 0 ? entry : existing || entry;
        catalogCache.set(key, retained);
        if (!disposed) setState({ ...retained, loading: false });
      },
      (error: unknown) => {
        if (disposed) return;
        setState({
          ...(existing || emptyEntry()), loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => { disposed = true; };
  }, [attempt, key]);

  return { ...state, retry };
}

function initialState(entry?: ModelCatalogEntry): Omit<AccountModelCatalog, 'retry'> {
  return { ...(entry || emptyEntry()), loading: Boolean(!entry) };
}

function emptyEntry(): ModelCatalogEntry {
  return { models: [], defaultModel: '' };
}
