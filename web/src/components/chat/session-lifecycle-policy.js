function providerKey(provider) {
  return String(provider || '').trim().toLowerCase();
}

export function resolveArchiveAction(capabilities, provider) {
  const key = providerKey(provider);
  const capability = capabilities && capabilities[key];
  const archive = capability && capability.operations && capability.operations.archive;
  const reason = String(
    archive && archive.reason
    || capability && capability.reason
    || 'native_archive_unsupported'
  );
  if (!archive || archive.support !== 'native') {
    return { visible: false, disabled: true, reason };
  }
  const available = capability.workflowAvailable === true && archive.available === true;
  return {
    visible: true,
    disabled: !available,
    reason: available ? '' : reason
  };
}

export function canUnarchiveSession(session) {
  return Boolean(session && session.canUnarchive === true);
}

export function archivedSessionTime(session) {
  return Number(session && (session.archivedAt || session.updatedAt)) || 0;
}
