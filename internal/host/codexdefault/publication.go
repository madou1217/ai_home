package codexdefault

import (
	"bytes"
	"fmt"
	"path/filepath"
)

// A completed auth rollback can have a stricter mode than the journal preimage:
// publishFile always makes auth.json private. Recognize that exact result after
// a crash, without relaxing ordinary snapshot/identity or permission checks.
func rollbackPreimageMatches(before, current fileSnapshot) bool {
	if sameFileContents(before, current) {
		return true
	}
	return before.Existed && current.Existed && filepath.Base(before.Path) == "auth.json" &&
		!sameMode(before.Mode, 0o600) && sameMode(current.Mode, 0o600) &&
		bytes.Equal(before.Data, current.Data) && current.identity != nil &&
		privateFile(current.Path, current.identity)
}

// Only the interrupted Windows two-rename publication leaves the after-image
// at Staged and the preimage at Staged.displaced while the target is absent.
// Missing targets without BOTH witnesses remain external deletions. Keep both
// witnesses until cleanupStages revalidates them; publishFile creates the
// restored preimage privately and without replacing a concurrent native file.
func restoreInterruptedPublication(change fileChange, current fileSnapshot) error {
	if current.Existed || !change.Before.Existed || !stagePathValid(change) {
		return fmt.Errorf("codex_host_recovery_external_edit")
	}
	staged, err := readHostFile(change.Staged)
	if err != nil || !staged.Existed || !bytes.Equal(staged.Data, change.After) || !sameMode(staged.Mode, change.Mode) {
		return fmt.Errorf("codex_host_recovery_external_edit")
	}
	if change.Mode == 0o600 && !privateFile(staged.Path, staged.identity) {
		return fmt.Errorf("codex_host_recovery_external_edit")
	}
	displaced, err := readHostFile(change.Staged + ".displaced")
	if err != nil || !sameFileContents(change.Before, displaced) {
		return fmt.Errorf("codex_host_recovery_external_edit")
	}
	return publishFile(current, displaced.Data, change.Before.Mode)
}
