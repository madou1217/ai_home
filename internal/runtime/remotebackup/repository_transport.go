package remotebackup

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path"
	"strings"
	"time"
)

// RepositoryTransport never reconnects while holding a repository lock. All
// cooperating v2 readers/writers use this scope; legacy paths are not modified.
type RepositoryTransport interface {
	BeginRepository(context.Context) (RepositoryScope, error)
}
type RepositoryScope interface {
	Read(context.Context, string, int) ([]byte, bool, error)
	PutImmutable(context.Context, string, []byte, ...bool) (bool, error)
	Publish(context.Context, string, []byte) error
	Journal(context.Context, []byte) error
	Retain()
	Release(context.Context) error
}
type repositorySSHScope struct {
	owner              *SSHBackupStrategy
	conn               *sshBackupConnection
	lock, token        string
	uncertain, applied bool
	journal            []byte
}

type RepositoryError struct {
	Code, RecoveryPath string
	Applied            *bool
	cause              error
}

func (e *RepositoryError) Error() string {
	return fmt.Sprintf("%s: recovery=%s", e.Code, e.RecoveryPath)
}
func (e *RepositoryError) Unwrap() error { return e.cause }
func (s *SSHBackupStrategy) BeginRepository(ctx context.Context) (RepositoryScope, error) {
	conn, err := s.connectionFor(ctx)
	if err != nil {
		return nil, err
	}
	lock, _ := JoinRemote(conn.baseDir, repositoryLayout.LockPath)
	scope := &repositorySSHScope{owner: s, conn: conn, lock: lock}
	err = scope.run(ctx, func() error { return ensureRemoteDir(conn.sftp, path.Dir(lock)) })
	if err != nil {
		return nil, err
	}
	checkRecovery := func() error {
		var exists bool
		e := scope.run(ctx, func() error {
			_, e := conn.sftp.Lstat(path.Dir(lock) + "/.recovery-lock")
			if e == nil {
				exists = true
				return nil
			}
			if IsNoSuchFile(e) && completeSFTPStatus(e) {
				return nil
			}
			return e
		})
		if e != nil {
			return e
		}
		if exists {
			return &RepositoryError{Code: "backup_repository_busy", RecoveryPath: lock}
		}
		return nil
	}
	if err = checkRecovery(); err != nil {
		return nil, err
	}
	var nonce [24]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	scope.token = hex.EncodeToString(nonce[:]) + "\n"
	stage := path.Dir(lock) + "/.lock-stage-" + strings.TrimSpace(scope.token)
	err = scope.run(ctx, func() error {
		if e := conn.sftp.mkdir(stage, 0700); e != nil {
			return e
		}
		if _, e := conn.sftp.WriteExclusive(stage+"/owner", []byte(scope.token), 0600); e != nil {
			return e
		}
		// A complete owner record becomes visible with the lock in one step.
		e := conn.sftp.Rename(stage, lock)
		if e != nil && completeSFTPStatus(e) {
			e = errors.Join(e, conn.sftp.Remove(stage+"/owner"), conn.sftp.rmdir(stage))
		}
		return e
	})
	if err != nil {
		code := "backup_repository_busy"
		if scope.uncertain {
			code = "backup_repository_recovery_required"
		}
		return nil, &RepositoryError{Code: code, RecoveryPath: lock, cause: err}
	}
	if err = checkRecovery(); err != nil {
		return nil, err
	}
	return scope, nil
}
func (scope *repositorySSHScope) run(ctx context.Context, fn func() error) error {
	if scope.conn.closed.Load() || scope.uncertain {
		return &RepositoryError{Code: "backup_repository_recovery_required", RecoveryPath: scope.lock}
	}
	timeout := scope.owner.deps.OperationTimeout
	if timeout <= 0 {
		timeout = defaultOperationTimeout
	}
	op, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if err := op.Err(); err != nil {
		return err
	}
	done := make(chan struct{})
	stop := context.AfterFunc(op, func() { scope.owner.invalidate(scope.conn); close(done) })
	err := fn()
	if !stop() {
		<-done
	}
	if op.Err() != nil {
		err = errors.Join(op.Err(), err)
	}
	if err != nil && !completeSFTPStatus(err) {
		scope.uncertain = true
		scope.owner.invalidate(scope.conn)
	}
	return err
}
func (scope *repositorySSHScope) Read(ctx context.Context, relative string, limit int) (data []byte, found bool, err error) {
	remote, err := JoinRemote(scope.conn.baseDir, relative)
	if err != nil {
		return nil, false, err
	}
	err = scope.run(ctx, func() error {
		var e error
		data, e = scope.conn.sftp.ReadFileLimit(remote, limit)
		if IsNoSuchFile(e) && completeSFTPStatus(e) {
			return nil
		}
		if e == nil {
			found = true
		}
		return e
	})
	return
}
func (scope *repositorySSHScope) checkOwner(ctx context.Context) error {
	data, found, err := scope.Read(ctx, repositoryLayout.LockPath+"/owner", 1024)
	if err != nil {
		return err
	}
	if !found || string(data) != scope.token {
		scope.uncertain = true
		return &RepositoryError{Code: "backup_repository_recovery_required", RecoveryPath: scope.lock}
	}
	return nil
}
func (scope *repositorySSHScope) PutImmutable(ctx context.Context, relative string, data []byte, refresh ...bool) (bool, error) {
	if err := scope.checkOwner(ctx); err != nil {
		return false, err
	}
	existing, found, err := scope.Read(ctx, relative, len(data)+1)
	if err != nil {
		return false, err
	}
	if found {
		if string(existing) != string(data) {
			return false, errors.New("backup_immutable_conflict")
		}
		if len(refresh) == 0 || !refresh[0] {
			return false, nil
		}
		// --full still transmits every object to a fresh owned stage; an
		// existing content-addressed object is verified, never overwritten.
	}
	remote, err := JoinRemote(scope.conn.baseDir, relative)
	if err != nil {
		return false, err
	}
	temp := remote + ".stage-" + scope.token[:24]
	err = scope.run(ctx, func() error {
		if e := ensureRemoteDir(scope.conn.sftp, path.Dir(remote)); e != nil {
			return e
		}
		created, e := scope.conn.sftp.WriteExclusive(temp, data, 0600)
		if e != nil {
			if created && completeSFTPStatus(e) {
				e = errors.Join(e, scope.conn.sftp.Remove(temp))
			}
			return e
		}
		if found {
			return scope.conn.sftp.Remove(temp)
		}
		e = scope.conn.sftp.Rename(temp, remote) // v3 no-overwrite, never POSIX replace.
		if e != nil && completeSFTPStatus(e) {
			e = errors.Join(e, scope.conn.sftp.Remove(temp))
		}
		return e
	})
	if err == nil {
		return !found, nil
	}
	if !scope.uncertain {
		existing, found, readErr := scope.Read(ctx, relative, len(data)+1)
		if readErr == nil && found && string(existing) == string(data) {
			return false, nil
		}
	}
	return false, err
}
func (scope *repositorySSHScope) Publish(ctx context.Context, relative string, data []byte) error {
	if err := scope.checkOwner(ctx); err != nil {
		return err
	}
	remote, err := JoinRemote(scope.conn.baseDir, relative)
	if err != nil {
		return err
	}
	temp := remote + ".publish-" + scope.token[:24]
	err = scope.run(ctx, func() error {
		if e := ensureRemoteDir(scope.conn.sftp, path.Dir(remote)); e != nil {
			return e
		}
		created, e := scope.conn.sftp.WriteExclusive(temp, data, os.FileMode(0600))
		if e != nil {
			if created && completeSFTPStatus(e) {
				e = errors.Join(e, scope.conn.sftp.Remove(temp))
			}
			return e
		}
		return scope.conn.sftp.ReplaceFile(temp, remote)
	})
	if err != nil {
		scope.uncertain = true
		var replacement *SFTPReplacementError
		if errors.As(err, &replacement) && replacement.Code == "sftp_replace_cleanup_required" && replacement.Applied {
			scope.applied = true
		}
		var applied *bool
		if scope.applied {
			v := true
			applied = &v
		}
		return &RepositoryError{Code: "backup_repository_recovery_required", RecoveryPath: scope.lock, Applied: applied, cause: err}
	}
	scope.applied = true
	return nil
}
func (scope *repositorySSHScope) Retain() { scope.uncertain = true }
func (scope *repositorySSHScope) Journal(ctx context.Context, data []byte) error {
	relative := repositoryLayout.LockPath + "/intent.json"
	if _, err := scope.PutImmutable(ctx, relative, data); err != nil {
		scope.uncertain = true
		return err
	}
	scope.journal = append([]byte(nil), data...)
	return nil
}
func (scope *repositorySSHScope) Release(ctx context.Context) error {
	fail := func(err error) error {
		var applied *bool
		if scope.applied {
			v := true
			applied = &v
		}
		return &RepositoryError{Code: "backup_repository_cleanup_required", RecoveryPath: scope.lock, Applied: applied, cause: err}
	}
	if scope.uncertain || scope.conn.closed.Load() {
		var applied *bool
		if scope.applied {
			v := true
			applied = &v
		}
		return &RepositoryError{Code: "backup_repository_recovery_required", RecoveryPath: scope.lock, Applied: applied}
	}
	if ctx == nil {
		ctx = context.Background()
	}
	cleanup, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var token []byte
	if err := scope.run(cleanup, func() error {
		var e error
		token, e = scope.conn.sftp.ReadFileLimit(scope.lock+"/owner", 1024)
		return e
	}); err != nil {
		return fail(err)
	}
	if string(token) != scope.token {
		return fail(errors.New("backup_lock_ownership_changed"))
	}
	if len(scope.journal) > 0 {
		data, found, err := scope.Read(cleanup, repositoryLayout.LockPath+"/intent.json", 4096)
		if err != nil || !found || string(data) != string(scope.journal) {
			return fail(errors.Join(errors.New("backup_journal_changed"), err))
		}
	}
	// Atomic namespace handoff preserves ownership evidence across a crash.
	completed, _ := JoinRemote(scope.conn.baseDir, "v2/.completed-"+strings.TrimSpace(scope.token))
	if err := scope.run(cleanup, func() error { return scope.conn.sftp.Rename(scope.lock, completed) }); err != nil {
		return fail(err)
	}

	return nil
}
