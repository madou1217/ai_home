package remotebackup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"strings"

	"github.com/madou1217/ai_home/contracts/backuprepository"
)

// RecoveryOptions 是受管仓库中断恢复的输入。
type RecoveryOptions struct {
	DryRun         bool
	ConfirmStopped bool
	Owner          string
	RecoveryToken  string
	AttemptToken   string
}

// RecoveryResult 是恢复的公开结果。
type RecoveryResult struct {
	OK            bool           `json:"ok"`
	DryRun        bool           `json:"dryRun,omitempty"`
	TargetID      string         `json:"targetId"`
	Owner         string         `json:"owner,omitempty"`
	Action        string         `json:"action"`
	Revision      int            `json:"revision,omitempty"`
	Intent        map[string]any `json:"intent,omitempty"`
	RecoveryToken string         `json:"recoveryToken,omitempty"`
	AttemptToken  string         `json:"attemptToken,omitempty"`
}

// RecoverRemoteBackup 校验并释放一次中断发布留下的 writer lock。
//
// Go 的 v2 仓库用原子 rename 发布 manifest；崩溃只会留下 v2/.writer-lock。
// 恢复前必须确认 lock owner 未被替换，并验证已发布 manifest 的对象完整性；
// 通过后把 lock 原子改名为 completed 证据目录，下一次备份可重新获取锁。
func RecoverRemoteBackup(ctx context.Context, strategy Strategy, targetID string, options RecoveryOptions) (RecoveryResult, error) {
	layout := backuprepository.Contract
	result := RecoveryResult{TargetID: targetID, DryRun: options.DryRun}
	owner, found, err := strategy.ReadFile(ctx, layout.LockPath+"/owner")
	if err != nil {
		return result, err
	}
	if !found {
		result.OK = true
		result.Action = "no_lock"
		return result, nil
	}
	result.Owner = strings.TrimSpace(owner)
	intentText, intentFound, intentErr := strategy.ReadFile(ctx, layout.LockPath+"/intent.json")
	if intentErr != nil {
		return result, intentErr
	}
	if intentFound {
		var intent map[string]any
		if jsonErr := json.Unmarshal([]byte(intentText), &intent); jsonErr != nil {
			return result, errors.New("backup_recovery_intent_invalid")
		}
		result.Intent = intent
	}
	if options.DryRun || !options.ConfirmStopped {
		result.OK = true
		result.Action = "confirm_all_original_and_recovery_writers_stopped_before_recovery"
		return result, nil
	}
	if requested := strings.TrimSpace(options.Owner); requested != "" && requested != result.Owner {
		return result, errors.New("backup_lock_ownership_changed")
	}
	snapshot, snapshotErr := ReadRemoteSnapshot(ctx, strategy)
	if snapshotErr != nil && !strings.Contains(snapshotErr.Error(), "backup_manifest_missing") {
		return result, snapshotErr
	}
	if snapshotErr == nil {
		if len(snapshot.Missing) > 0 || len(snapshot.Corrupt) > 0 {
			return result, errors.New("backup_recovery_snapshot_incomplete")
		}
		result.Revision = snapshot.Revision
	}
	connection, err := strategy.(*SSHBackupStrategy).connectionFor(ctx)
	if err != nil {
		return result, err
	}
	lockPath, err := JoinRemote(connection.baseDir, layout.LockPath)
	if err != nil {
		return result, err
	}
	completedPath := path.Join(path.Dir(lockPath), ".completed-"+strings.TrimSpace(result.Owner))
	if err := connection.sftp.Rename(lockPath, completedPath); err != nil {
		return result, fmt.Errorf("backup_recovery_release_failed: %w", err)
	}
	result.OK = true
	result.Action = "released_verified_lock"
	return result, nil
}
