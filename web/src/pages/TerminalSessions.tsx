import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import SessionOffice from '@/features/session-office/SessionOffice';

export default function TerminalSessions() {
  const [searchParams] = useSearchParams();

  const officeProps = useMemo(() => {
    const room = (searchParams.get('room') || '').trim() || undefined;
    const session = (searchParams.get('session') || '').trim() || undefined;

    return {
      defaultRoomKey: room,
      defaultSessionKey: session,
    };
  }, [searchParams]);

  return <SessionOffice {...officeProps} />;
}