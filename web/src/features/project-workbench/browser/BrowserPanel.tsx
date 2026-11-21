import BrowserView from '@/features/account-browser/BrowserView';

interface Props {
  initialUrl?: string;
  requiredServerId?: string;
  embedded?: boolean;
  active?: boolean;
}

// Project Studio's browser icon is the same server-owned stable browser surface
// used by OAuth and the virtual computer. It must never fall back to an iframe
// or open a second browser window on the operator device.
export default function BrowserPanel({ initialUrl, requiredServerId, embedded = true, active = true }: Props) {
  return (
    <BrowserView
      initialUrl={initialUrl}
      requiredServerId={requiredServerId}
      embedded={embedded}
      active={active}
    />
  );
}
