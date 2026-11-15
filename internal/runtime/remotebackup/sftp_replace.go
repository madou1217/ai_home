package remotebackup

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// SFTPReplacementError is a non-retryable transaction outcome. RecoveryPath
// contains the previous version/claim and must not be removed automatically.
type SFTPReplacementError struct {
	Code         string
	RecoveryPath string
	Applied      bool
	cause        error
}

func (e *SFTPReplacementError) Error() string {
	if e.Code == "sftp_replace_recovery_required" || e.Code == "write_outcome_unknown" {
		return fmt.Sprintf("%s: recovery=%s applied=unknown", e.Code, e.RecoveryPath)
	}
	return fmt.Sprintf("%s: recovery=%s applied=%t", e.Code, e.RecoveryPath, e.Applied)
}
func (e *SFTPReplacementError) Unwrap() error { return e.cause }

func (a sftpFileAttr) regular() bool { return a.HasPermissions && a.Permissions&0o170000 == 0o100000 }

func (c *sftpClient) recoverableReplace(temporary, target string) error {
	var err error
	lock := target + ".aih-replace-lock"
	var nonce [12]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return err
	}
	backup := lock + "/previous-" + hex.EncodeToString(nonce[:])
	outcome := func(code, path string, applied bool, cause error) error {
		return &SFTPReplacementError{Code: code, RecoveryPath: path, Applied: applied, cause: cause}
	}
	if err = c.mkdir(lock, 0700); err != nil {
		return outcome("sftp_replace_busy", lock, false, err)
	}
	// All v3 writers acquire the claim before creation/rename; none can enter
	// the temporary missing-destination interval of another AIH writer.
	err = c.Rename(temporary, target)
	if err == nil {
		if cleanup := c.rmdir(lock); cleanup != nil {
			return outcome("sftp_replace_cleanup_required", lock, true, cleanup)
		}
		return nil
	}
	var status *SFTPStatusError
	if !errors.As(err, &status) || status.malformed || status.Code != 4 {
		if !completeSFTPStatus(err) {
			return outcome("sftp_replace_recovery_required", lock, false, err)
		}
		if cleanup := c.rmdir(lock); cleanup != nil {
			return outcome("sftp_replace_recovery_required", lock, false, errors.Join(err, cleanup))
		}
		return err
	}
	current, err := c.Lstat(target)
	if err != nil && !completeSFTPStatus(err) {
		return outcome("sftp_replace_recovery_required", lock, false, err)
	}
	if err != nil || !current.regular() {
		cleanup := c.rmdir(lock)
		if cleanup != nil {
			return outcome("sftp_replace_recovery_required", lock, false, errors.Join(err, cleanup))
		}
		if err != nil {
			return err
		}
		return outcome("sftp_replace_target_changed", lock, false, nil)
	}
	if err = c.Rename(target, backup); err != nil {
		if !completeSFTPStatus(err) {
			return outcome("sftp_replace_recovery_required", lock, false, err)
		}
		if cleanup := c.rmdir(lock); cleanup != nil {
			return outcome("sftp_replace_recovery_required", lock, false, errors.Join(err, cleanup))
		}
		return err
	}
	if err = c.Rename(temporary, target); err != nil {
		if !completeSFTPStatus(err) {
			return outcome("sftp_replace_recovery_required", backup, false, err)
		}
		_, check := c.Lstat(target)
		if !IsNoSuchFile(check) {
			return outcome("sftp_replace_recovery_required", backup, false, errors.Join(err, check))
		}
		if restore := c.Rename(backup, target); restore != nil {
			return outcome("sftp_replace_recovery_required", backup, false, errors.Join(err, restore))
		}
		if cleanup := c.rmdir(lock); cleanup != nil {
			return outcome("sftp_replace_recovery_required", lock, false, errors.Join(err, cleanup))
		}
		return err
	}
	if err = c.Remove(backup); err != nil {
		return outcome("sftp_replace_cleanup_required", backup, true, err)
	}
	if err = c.rmdir(lock); err != nil {
		return outcome("sftp_replace_cleanup_required", lock, true, err)
	}
	return nil
}

// BackupRecovery is a low-sensitivity, bounded outcome projection. nil Applied
// means publication may have happened and must be checked, not blindly retried.
type BackupRecovery struct {
	Code    string `json:"code"`
	Path    string `json:"recoveryPath,omitempty"`
	Applied *bool  `json:"applied,omitempty"`
}

func backupRecovery(err error) *BackupRecovery {
	var repository *RepositoryError
	if errors.As(err, &repository) {
		out := &BackupRecovery{Code: repository.Code, Applied: repository.Applied}
		if len(repository.RecoveryPath) <= 4096 && !strings.ContainsAny(repository.RecoveryPath, "\x00\r\n") {
			out.Path = repository.RecoveryPath
		}
		return out
	}
	var replacement *SFTPReplacementError
	if !errors.As(err, &replacement) {
		return nil
	}
	out := &BackupRecovery{Code: replacement.Code}
	if len(replacement.RecoveryPath) <= 4096 && !strings.ContainsAny(replacement.RecoveryPath, "\x00\r\n") {
		out.Path = replacement.RecoveryPath
	}
	if replacement.Code != "sftp_replace_recovery_required" && replacement.Code != "write_outcome_unknown" {
		value := replacement.Applied
		out.Applied = &value
	}
	return out
}
