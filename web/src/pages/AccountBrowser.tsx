import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import BrowserView from '@/features/account-browser/BrowserView';

const authStoragePrefix = 'aih:account-browser:oauth:';

export default function AccountBrowserPage() {
  const [params] = useSearchParams();
  const provider = String(params.get('provider') || '').trim();
  const accountRef = String(params.get('accountRef') || '').trim();
  const authJob = String(params.get('authJob') || '').trim();
  const initialUrl = useMemo(() => {
    if (!authJob || typeof window === 'undefined') return undefined;
    const key = `${authStoragePrefix}${authJob}`;
    const url = String(window.sessionStorage.getItem(key) || '').trim();
    return url || undefined;
  }, [authJob]);
  const accountScope = provider && accountRef
    ? { scope: 'account' as const, provider, accountRef }
    : undefined;
  return <BrowserView scope={accountScope} initialUrl={initialUrl} />;
}
