package codexpreferences

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"

	"github.com/madou1217/ai_home/internal/runtime/fileexchange"
)

// replaceExistingConfig retains the inode displaced by publication. A late
// native/editor update is preserved and reported instead of destroyed by rename.
// preserve=true tells the caller not to delete its now-displaced staging path.
func replaceExistingConfig(staged, target string, before document, next []byte) (preserve bool, err error) {
	displaced, err := fileexchange.Exchange(staged, target)
	if displaced == "" {
		return false, err
	}
	preserve = displaced == staged
	conflict := func() (bool, error) {
		markConfigConflict(target, displaced)
		return preserve, fmt.Errorf("codex_config_external_edit_preserved_recovery_required")
	}
	if err != nil {
		return conflict()
	}
	previous, err := readDocument(displaced)
	if err != nil || !bytes.Equal(previous.content, before.content) || !sameDocument(previous, before) {
		return conflict()
	}
	written, err := readDocument(target)
	if err != nil || !bytes.Equal(written.content, next) {
		return conflict()
	}
	// Move the verified old inode to a unique name before inspecting and deleting
	// it. A pathname replacement after verification must not be unlinked blindly.
	removed, err := os.CreateTemp(filepath.Dir(target), ".codex-preference-remove-*")
	if err != nil {
		return conflict()
	}
	removePath := removed.Name()
	_ = removed.Close()
	if err := os.Remove(removePath); err != nil {
		return conflict()
	}
	if err := fileexchange.MoveAside(displaced, removePath); err != nil {
		return conflict()
	}
	moved, err := readDocument(removePath)
	if err != nil || !bytes.Equal(moved.content, before.content) || !sameDocument(moved, before) {
		markConfigConflict(target, removePath)
		return preserve, fmt.Errorf("codex_config_external_edit_preserved_recovery_required")
	}
	if err := os.Remove(removePath); err != nil {
		markConfigConflict(target, removePath)
		return preserve, fmt.Errorf("codex_config_cleanup_required")
	}
	return false, nil
}

func markConfigConflict(target, displaced string) {
	marker, err := os.OpenFile(target+".aih-default-conflict", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	_, _ = fmt.Fprintln(marker, filepath.Base(displaced))
	_ = marker.Sync()
	_ = marker.Close()
}
