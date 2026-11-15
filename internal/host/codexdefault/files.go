package codexdefault

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/madou1217/ai_home/internal/runtime/fileexchange"
	"io"
	"os"
	"path/filepath"
)

const maxHostFileBytes = 4 << 20

type fileSnapshot struct {
	Path     string      `json:"path"`
	Existed  bool        `json:"existed"`
	Data     []byte      `json:"data"`
	Mode     os.FileMode `json:"mode"`
	identity os.FileInfo
}

type fileChange struct {
	Staged string       `json:"staged"`
	Before fileSnapshot `json:"before"`
	After  []byte       `json:"after"`
	Mode   os.FileMode  `json:"mode"`
}

func readHostFile(path string) (fileSnapshot, error) {
	result := fileSnapshot{Path: path, Mode: 0o600}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil || !info.Mode().IsRegular() {
		return result, fmt.Errorf("codex_host_file_not_regular")
	}
	if info.Size() > maxHostFileBytes {
		return result, fmt.Errorf("codex_host_file_too_large")
	}
	file, err := os.Open(path)
	if err != nil {
		return result, fmt.Errorf("codex_host_file_read_failed")
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return result, fmt.Errorf("codex_host_file_changed")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxHostFileBytes+1))
	if err != nil || len(data) > maxHostFileBytes {
		return result, fmt.Errorf("codex_host_file_read_failed")
	}
	after, err := os.Lstat(path)
	if err != nil || !os.SameFile(info, after) || info.Size() != after.Size() || !info.ModTime().Equal(after.ModTime()) {
		return result, fmt.Errorf("codex_host_file_changed")
	}
	result.Existed, result.Data, result.Mode, result.identity = true, data, info.Mode().Perm(), info
	return result, nil
}

func sameFileContents(left, right fileSnapshot) bool {
	return left.Existed == right.Existed && sameMode(left.Mode, right.Mode) && bytes.Equal(left.Data, right.Data) && (left.identity == nil || right.identity == nil || os.SameFile(left.identity, right.identity))
}

func publishFile(before fileSnapshot, data []byte, mode os.FileMode) error {
	current, err := readHostFile(before.Path)
	if err != nil || !sameFileContents(before, current) {
		return fmt.Errorf("codex_host_file_changed")
	}
	temp, err := os.CreateTemp(filepath.Dir(before.Path), ".aih-default-*")
	if err != nil {
		return fmt.Errorf("codex_host_file_stage_failed")
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(temp.Name())
		}
	}()
	defer temp.Close()
	if err := temp.Chmod(mode); err != nil {
		return fmt.Errorf("codex_host_file_mode_failed")
	}
	if mode == 0o600 || filepath.Base(before.Path) == "auth.json" {
		if err := securePrivateFile(temp); err != nil {
			return fmt.Errorf("codex_host_file_acl_failed")
		}
	}

	if _, err := temp.Write(data); err != nil {
		return fmt.Errorf("codex_host_file_stage_failed")
	}
	if err := temp.Sync(); err != nil {
		return fmt.Errorf("codex_host_file_sync_failed")
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("codex_host_file_stage_failed")
	}
	current, err = readHostFile(before.Path)
	if err != nil || !sameFileContents(before, current) {
		return fmt.Errorf("codex_host_file_changed")
	}
	if before.Existed {
		displaced, swapErr := fileexchange.Exchange(temp.Name(), before.Path)
		if displaced != "" {
			old, readErr := readHostFile(displaced)
			if swapErr != nil || readErr != nil || !sameFileContents(before, old) {
				if displaced == temp.Name() {
					cleanup = false
				}
				return preserveConflict(before.Path, displaced)
			}
			if displaced != temp.Name() {
				if err := os.Remove(displaced); err != nil {
					return preserveConflict(before.Path, displaced)
				}
			}
		} else if swapErr != nil {
			return fmt.Errorf("codex_host_file_publish_failed")
		}
	} else if err := publishRename(temp.Name(), before.Path, false); err != nil {
		return fmt.Errorf("codex_host_file_publish_failed")
	}
	if err := syncDirectory(filepath.Dir(before.Path)); err != nil {
		return fmt.Errorf("codex_host_directory_sync_failed")
	}
	return nil
}

func rollbackFiles(changes []fileChange) error {
	var failures []error
	for index := len(changes) - 1; index >= 0; index-- {
		change := changes[index]
		current, err := readHostFile(change.Before.Path)
		if err != nil {
			failures = append(failures, err)
			continue
		}
		if rollbackPreimageMatches(change.Before, current) {
			continue
		}
		if !current.Existed && change.Before.Existed {
			if err := restoreInterruptedPublication(change, current); err != nil {
				failures = append(failures, err)
			}
			continue
		}
		if !current.Existed || !bytes.Equal(current.Data, change.After) || !sameMode(current.Mode, change.Mode) {
			failures = append(failures, fmt.Errorf("codex_host_recovery_external_edit"))
			continue
		}
		if !change.Before.Existed {
			if err := removePublished(current); err != nil {
				failures = append(failures, err)
			}
		} else if err := publishFile(current, change.Before.Data, change.Before.Mode); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

type journal struct {
	Version int          `json:"version"`
	Before  defaultState `json:"before"`
	After   defaultState `json:"after"`
	Files   []fileChange `json:"files"`
}

func writeJournal(path string, entry journal) error {
	encoded, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("codex_default_journal_invalid")
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".aih-default-journal-*")
	if err != nil {
		return fmt.Errorf("codex_default_journal_write_failed")
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err := securePrivateFile(file); err != nil {
		return fmt.Errorf("codex_default_journal_acl_failed")
	}
	if _, err := file.Write(encoded); err != nil {
		return fmt.Errorf("codex_default_journal_write_failed")
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("codex_default_journal_write_failed")
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("codex_default_journal_write_failed")
	}
	// Atomic create-if-absent; never replace another operation's journal.
	if err := publishRename(file.Name(), path, false); err != nil {
		return fmt.Errorf("codex_default_journal_busy")
	}
	if err := syncDirectory(filepath.Dir(path)); err != nil {
		return fmt.Errorf("codex_default_journal_sync_failed")
	}
	return nil
}

func removeJournal(path string) error {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("codex_default_journal_cleanup_failed")
	}
	if err := syncDirectory(filepath.Dir(path)); err != nil {
		return fmt.Errorf("codex_default_journal_cleanup_failed")
	}
	return nil
}

// Verify the whole after-image, not only each individual write. This catches a
// non-cooperating edit to an earlier file while later files are being published.
func verifyPublished(changes []fileChange) error {
	for _, change := range changes {
		current, err := readHostFile(change.Before.Path)
		if err != nil || !current.Existed || !bytes.Equal(current.Data, change.After) || !sameMode(current.Mode, change.Mode) {
			return fmt.Errorf("codex_host_file_changed")
		}
		if change.Mode == 0o600 && !privateFile(current.Path, current.identity) {
			return fmt.Errorf("codex_host_private_file_changed")
		}
	}
	return nil
}
