package codexdefault

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/madou1217/ai_home/internal/runtime/fileexchange"
)

// prepareRollback creates a fully durable Before image before touching target.
// The final rollback path is published no-replace: a crash while writing the
// scratch file cannot leave a partial recovery witness at that path.
func prepareRollback(change fileChange) (fileSnapshot, error) {
	path := rollbackStagePath(change)
	staged, err := readHostFile(path)
	if err != nil {
		return fileSnapshot{}, preserveConflict(change.Before.Path, path)
	}
	if staged.Existed {
		if !matchesRollbackImage(change, staged) {
			return fileSnapshot{}, preserveConflict(change.Before.Path, path)
		}
		return staged, nil
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".aih-default-rollback-prepare-*")
	if err != nil {
		return fileSnapshot{}, fmt.Errorf("codex_host_rollback_stage_failed")
	}
	defer temp.Close()
	defer os.Remove(temp.Name())
	mode := rollbackMode(change)
	if err := temp.Chmod(mode); err != nil {
		return fileSnapshot{}, fmt.Errorf("codex_host_rollback_mode_failed")
	}
	if mode == 0o600 {
		if err := securePrivateFile(temp); err != nil {
			return fileSnapshot{}, fmt.Errorf("codex_host_rollback_acl_failed")
		}
	}
	if _, err := temp.Write(change.Before.Data); err != nil {
		return fileSnapshot{}, fmt.Errorf("codex_host_rollback_stage_failed")
	}
	if err := temp.Sync(); err != nil {
		return fileSnapshot{}, fmt.Errorf("codex_host_rollback_sync_failed")
	}
	if err := temp.Close(); err != nil {
		return fileSnapshot{}, fmt.Errorf("codex_host_rollback_stage_failed")
	}
	if err := publishRename(temp.Name(), path, false); err != nil {
		return fileSnapshot{}, fmt.Errorf("codex_host_rollback_publish_failed")
	}
	if err := syncDirectory(filepath.Dir(path)); err != nil {
		return fileSnapshot{}, fmt.Errorf("codex_host_directory_sync_failed")
	}
	staged, err = readHostFile(path)
	if err != nil || !matchesRollbackImage(change, staged) {
		return fileSnapshot{}, preserveConflict(change.Before.Path, path)
	}
	return staged, nil
}

// publishRollback never calls a second anonymous exchange during recovery.
// The original journal names both the rollback stage and its displaced image
// through deterministic suffixes, including the Windows two-move interval.
func publishRollback(change fileChange, expected fileSnapshot) error {
	if !change.Before.Existed || !stagePathValid(change) {
		return fmt.Errorf("codex_default_journal_stage_invalid")
	}
	staged, err := prepareRollback(change)
	if err != nil {
		return err
	}
	current, err := readHostFile(change.Before.Path)
	if err != nil || !sameFileContents(expected, current) {
		return fmt.Errorf("codex_host_file_changed")
	}
	if !current.Existed {
		if err := publishRename(staged.Path, current.Path, false); err != nil {
			return fmt.Errorf("codex_host_file_publish_failed")
		}
	} else {
		// A displaced candidate from an earlier operation may not be replaced.
		displaced, err := readHostFile(staged.Path + ".displaced")
		if err != nil || displaced.Existed {
			return preserveConflict(current.Path, staged.Path+".displaced")
		}
		name, swapErr := fileexchange.Exchange(staged.Path, current.Path)
		if name == "" {
			return fmt.Errorf("codex_host_file_publish_failed")
		}
		old, readErr := readHostFile(name)
		if readErr != nil || !sameFileContents(current, old) {
			return preserveConflict(current.Path, name)
		}
		if swapErr != nil {
			// Exact after-image remains at the recorded displaced path. Keep the
			// journal and both witnesses for retry, not a false external-edit marker.
			return fmt.Errorf("codex_host_file_publish_failed")
		}
	}
	if err := syncDirectory(filepath.Dir(current.Path)); err != nil {
		return fmt.Errorf("codex_host_directory_sync_failed")
	}
	restored, err := readHostFile(current.Path)
	if err != nil || !matchesRollbackImage(change, restored) || !sameFileContents(staged, restored) {
		return preserveConflict(current.Path, staged.Path)
	}
	return nil
}
