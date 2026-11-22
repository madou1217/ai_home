import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import BrowserView from '@/features/account-browser/BrowserView';

const authStoragePrefix = 'aih:account-browser:oauth:';

export default function AccountBrowserPage() {
  const [params] = useSearchParams();
  const provider = String(params.get('provider') || '').trim();
  const accountRef = String(params.get('accountRef') || '').trim();
  const authJob = String(params.get('authJob') || '').trim();
  const requestedScope = String(params.get('scope') || '').trim();
  const initialUrl = useMemo(() => {
    if (!authJob || typeof window === 'undefined') return undefined;
    const key = `${authStoragePrefix}${authJob}`;
    const url = String(window.sessionStorage.getItem(key) || '').trim();
    return url || undefined;
  }, [authJob]);
  const browserScope = provider && accountRef
    ? { scope: 'account' as const, provider, accountRef }
    : requestedScope === 'job' && authJob
      ? { scope: 'job' as const, authJob }
      : undefined;
  return <BrowserView scope={browserScope} initialUrl={initialUrl} />;
}
