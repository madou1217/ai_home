import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import SessionOffice from '@/features/session-office/SessionOffice';
import type { MailboxScope } from '@/features/session-office/session-office-types';

const VALID_SCOPES: ReadonlySet<MailboxScope> = new Set(['session', 'room', 'unassigned', 'all']);

export default function TerminalSessions() {
  const [searchParams] = useSearchParams();

  const officeProps = useMemo(() => {
    const view = (searchParams.get('view') || '').trim().toLowerCase();
    const rawScope = (searchParams.get('scope') || '').trim().toLowerCase() as MailboxScope;
    const room = (searchParams.get('room') || '').trim() || undefined;
    const session = (searchParams.get('session') || '').trim() || undefined;
    const defaultOpenMailbox = view === 'mailbox';
    const defaultMailboxScope = VALID_SCOPES.has(rawScope)
      ? rawScope
      : (defaultOpenMailbox ? 'room' : undefined);

    return {
      defaultOpenMailbox,
      defaultMailboxScope,
      defaultRoomKey: room,
      defaultSessionKey: session,
    };
  }, [searchParams]);

  return <SessionOffice {...officeProps} />;
}
