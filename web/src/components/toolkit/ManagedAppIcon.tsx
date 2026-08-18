import type { ManagedAppItem } from '@/types';
import ManagedClientIcon from './ManagedClientIcon';

interface Props {
  app: ManagedAppItem;
}

export default function ManagedAppIcon({ app }: Props) {
  return <ManagedClientIcon
    clientType={app.type}
    clientName={app.clientName || app.name}
    provider={app.provider}
    integrationProviders={app.integrationProviders}
  />;
}
