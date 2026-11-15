package codexdefault

import (
	"errors"
	"fmt"
	"github.com/madou1217/ai_home/internal/runtime/fileexchange"
	"os"
	"path/filepath"
)

var errExternalFilePreserved = errors.New("codex_default_external_edit_preserved_recovery_required")

// A noncooperating editor can race publication. Preserve its displaced file and
// keep the journal; automatic recovery must not substitute the older preimage.
// The marker contains paths only, not credentials. Operators can reconcile the
// preserved native version explicitly rather than lose its rotated credential.
func preserveConflict(target, displaced string) error {
	marker := target + ".aih-default-conflict"
	file, err := os.OpenFile(marker, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err == nil {
		if securePrivateFile(file) == nil {
			_, _ = fmt.Fprintln(file, filepath.Base(displaced))
			_ = file.Sync()
		}
		_ = file.Close()
		_ = syncDirectory(filepath.Dir(marker))
	}
	return errExternalFilePreserved
}

func requireNoPreservedConflict(target string) error {
	_, err := os.Lstat(target + ".aih-default-conflict")
	if os.IsNotExist(err) {
		return nil
	}
	return errExternalFilePreserved
}

// removePublished moves the candidate out of the pathname before inspecting it.
// If an external writer won the race, keep that exact inode rather than unlink it.
func removePublished(current fileSnapshot) error {
	temp, err := os.CreateTemp(filepath.Dir(current.Path), ".aih-default-remove-*")
	if err != nil {
		return fmt.Errorf("codex_host_recovery_remove_failed")
	}
	name := temp.Name()
	_ = temp.Close()
	if err := os.Remove(name); err != nil {
		return err
	}
	if err := fileexchange.MoveAside(current.Path, name); err != nil {
		return fmt.Errorf("codex_host_recovery_remove_failed")
	}
	moved, err := readHostFile(name)
	if err != nil || !sameFileContents(current, moved) {
		// Restore only if the pathname is still absent. Never replace a newer edit.
		if restoreErr := fileexchange.MoveAside(name, current.Path); restoreErr != nil {
			return preserveConflict(current.Path, name)
		}
		return fmt.Errorf("codex_host_recovery_external_edit")
	}
	if err := os.Remove(name); err != nil {
		return fmt.Errorf("codex_host_recovery_remove_failed")
	}
	return syncDirectory(filepath.Dir(current.Path))
}
