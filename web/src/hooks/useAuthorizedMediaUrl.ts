import { useEffect, useState } from 'react';
import { fetchAuthorizedWebUiBlob } from '@/services/webui-auth-transport';

interface AuthorizedMediaState {
  url: string;
  loading: boolean;
  error: string;
}

function requiresAuthorizedFetch(source: string) {
  return String(source || '').startsWith('/v0/webui/');
}

function initialState(source: string): AuthorizedMediaState {
  const value = String(source || '').trim();
  return {
    url: requiresAuthorizedFetch(value) ? '' : value,
    loading: Boolean(value && requiresAuthorizedFetch(value)),
    error: ''
  };
}

export function useAuthorizedMediaUrl(source: string): AuthorizedMediaState {
  const value = String(source || '').trim();
  const [state, setState] = useState<AuthorizedMediaState>(() => initialState(value));

  useEffect(() => {
    if (!value || !requiresAuthorizedFetch(value)) {
      setState(initialState(value));
      return;
    }

    const controller = new AbortController();
    let objectUrl = '';
    setState({ url: '', loading: true, error: '' });

    fetchAuthorizedWebUiBlob(value, { signal: controller.signal })
      .then(async (blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, loading: false, error: '' });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setState({
          url: '',
          loading: false,
          error: String((error as Error)?.message || error || 'authorized_media_failed')
        });
      });

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [value]);

  return state;
}
