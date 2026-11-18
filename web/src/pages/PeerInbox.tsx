import React, { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import SessionOffice from '@/features/session-office/SessionOffice';
import type { MailboxScope } from '@/features/session-office/session-office-types';

const VALID_SCOPES: ReadonlySet<MailboxScope> = new Set(['session', 'room', 'unassigned', 'all']);

const PeerInbox: React.FC = () => {
  const [searchParams] = useSearchParams();

  const officeProps = useMemo(() => {
    const rawScope = (searchParams.get('scope') || '').trim().toLowerCase() as MailboxScope;
    const room = (searchParams.get('room') || '').trim() || undefined;
    const session = (searchParams.get('session') || '').trim() || undefined;
    const defaultMailboxScope: MailboxScope = VALID_SCOPES.has(rawScope) ? rawScope : 'unassigned';

    return {
      defaultOpenMailbox: true,
      defaultMailboxScope,
      defaultRoomKey: room,
      defaultSessionKey: session,
    };
  }, [searchParams]);

  return <SessionOffice {...officeProps} />;
};

export default PeerInbox;
