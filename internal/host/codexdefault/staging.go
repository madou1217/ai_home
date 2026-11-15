package codexdefault

import (
	"bytes"
	"fmt"
	"github.com/madou1217/ai_home/internal/runtime/fileexchange"
	"os"
	"path/filepath"
	"strings"
)

// Stage names are recorded before publication so recovery can distinguish an
// unused after-image from the displaced native inode after a process crash.
func stageChanges(changes []fileChange) error {
	for i := range changes {
		change := &changes[i]
		temp, err := os.CreateTemp(filepath.Dir(change.Before.Path), ".aih-default-stage-*")
		if err != nil {
			return fmt.Errorf("codex_host_file_stage_failed")
		}
		change.Staged = temp.Name()
		if err := temp.Chmod(change.Mode); err != nil {
			temp.Close()
			return err
		}
		if change.Mode == 0o600 {
			if err := securePrivateFile(temp); err != nil {
				temp.Close()
				return fmt.Errorf("codex_host_file_acl_failed")
			}
		}
		_, err = temp.Write(change.After)
		if err == nil {
			err = temp.Sync()
		}
		closeErr := temp.Close()
		if err != nil || closeErr != nil {
			return fmt.Errorf("codex_host_file_stage_failed")
		}
		if err := syncDirectory(filepath.Dir(change.Before.Path)); err != nil {
			return err
		}
	}
	return nil
}

func stagePathValid(change fileChange) bool {
	return change.Staged != "" && filepath.Dir(change.Staged) == filepath.Dir(change.Before.Path) &&
		strings.HasPrefix(filepath.Base(change.Staged), ".aih-default-stage-") &&
		!strings.ContainsAny(filepath.Base(change.Staged), `/\`)
}

// verifyStages is checked before rollback/cleanup. Never discard a displaced
// native credential merely because the committed default stayed unchanged.
func verifyStages(changes []fileChange) error {
	for _, change := range changes {
		if !stagePathValid(change) {
			return fmt.Errorf("codex_default_journal_stage_invalid")
		}
		for _, candidate := range recoveryStagePaths(change) {
			file, err := readHostFile(candidate)
			if err != nil {
				return preserveConflict(change.Before.Path, candidate)
			}
			if !file.Existed {
				continue
			}
			if !validRecoveryStage(change, file) {
				return preserveConflict(change.Before.Path, candidate)
			}
		}
	}
	return nil
}

func cleanupStages(changes []fileChange) error {
	if err := verifyStages(changes); err != nil {
		return err
	}
	for _, change := range changes {
		for _, candidate := range recoveryStagePaths(change) {
			file, err := readHostFile(candidate)
			if err != nil {
				return err
			}
			if file.Existed {
				// Revalidate the exact snapshot used for removal. A native
				// writer may have renewed the displaced inode after verifyStages.
				if !validRecoveryStage(change, file) {
					return preserveConflict(change.Before.Path, candidate)
				}
				if err := removePublished(file); err != nil {
					_ = preserveConflict(change.Before.Path, candidate)
					return err
				}
			}
		}
	}
	return nil
}

func publishStaged(change fileChange) error {
	current, err := readHostFile(change.Before.Path)
	if err != nil || !sameFileContents(change.Before, current) {
		return fmt.Errorf("codex_host_file_changed")
	}
	staged, err := readHostFile(change.Staged)
	if err != nil || !staged.Existed || !bytes.Equal(staged.Data, change.After) || !sameMode(staged.Mode, change.Mode) {
		return fmt.Errorf("codex_host_stage_changed")
	}
	if change.Mode == 0o600 && !privateFile(staged.Path, staged.identity) {
		return fmt.Errorf("codex_host_stage_acl_changed")
	}
	if !change.Before.Existed {
		if err := publishRename(change.Staged, current.Path, false); err != nil {
			return fmt.Errorf("codex_host_file_publish_failed")
		}
	} else {
		displaced, err := fileexchange.Exchange(change.Staged, current.Path)
		if displaced == "" {
			return fmt.Errorf("codex_host_file_publish_failed")
		}
		old, readErr := readHostFile(displaced)
		if err != nil || readErr != nil || !sameFileContents(change.Before, old) {
			return preserveConflict(current.Path, displaced)
		}
	}
	if err := syncDirectory(filepath.Dir(current.Path)); err != nil {
		return fmt.Errorf("codex_host_directory_sync_failed")
	}
	return nil
}
