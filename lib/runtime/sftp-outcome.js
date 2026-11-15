'use strict';

const OUTCOME_CODES = new Set([
  'backup_repository_busy', 'backup_repository_recovery_required', 'backup_repository_cleanup_required',
  'sftp_replace_busy', 'sftp_replace_target_changed',
  'sftp_replace_recovery_required', 'sftp_replace_cleanup_required', 'write_outcome_unknown'
]);

// Public errors may contain remote-controlled text. Expose only explicit,
// bounded recovery metadata, never arbitrary causes/configuration/credentials.
function sftpOutcomeDetails(error) {
  if (!OUTCOME_CODES.has(error?.code)) return null;
  const source = error.details || error;
  const result = { code: error.code };
  if (typeof source.applied === 'boolean') result.applied = source.applied;
  if (typeof source.recoveryPath === 'string' && source.recoveryPath.length <= 4096
    && !/[\x00-\x1f\x7f]/.test(source.recoveryPath)) result.recoveryPath = source.recoveryPath;
  return result;
}

module.exports = { sftpOutcomeDetails };
