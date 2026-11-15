package codexdefault

import (
	"bytes"
	"os"
	"path/filepath"
)

// Rollback paths derive only from the journal's validated stage path; pending
// version-2 journals therefore gain recoverable rollback without a journal rewrite.
func rollbackStagePath(change fileChange) string { return change.Staged + ".rollback" }

func recoveryStagePaths(change fileChange) []string {
	return []string{change.Staged, change.Staged + ".displaced", rollbackStagePath(change), rollbackStagePath(change) + ".displaced"}
}

func rollbackMode(change fileChange) os.FileMode {
	if filepath.Base(change.Before.Path) == "auth.json" {
		return 0o600
	}
	return change.Before.Mode
}

func matchesAfterImage(change fileChange, file fileSnapshot) bool {
	return file.Existed && bytes.Equal(file.Data, change.After) && sameMode(file.Mode, change.Mode) &&
		(change.Mode != 0o600 || file.identity != nil && privateFile(file.Path, file.identity))
}

func matchesRollbackImage(change fileChange, file fileSnapshot) bool {
	mode := rollbackMode(change)
	return change.Before.Existed && file.Existed && bytes.Equal(file.Data, change.Before.Data) && sameMode(file.Mode, mode) &&
		(mode != 0o600 || file.identity != nil && privateFile(file.Path, file.identity))
}

// Each path has a narrow role. Unix exchange leaves After at the rollback stage;
// Windows leaves After at rollback.displaced. Neither permits arbitrary bytes.
func validRecoveryStage(change fileChange, file fileSnapshot) bool {
	switch file.Path {
	case change.Staged:
		return matchesAfterImage(change, file) || change.Before.Existed && sameFileContents(change.Before, file)
	case change.Staged + ".displaced":
		return change.Before.Existed && sameFileContents(change.Before, file)
	case rollbackStagePath(change):
		return matchesRollbackImage(change, file) || matchesAfterImage(change, file)
	case rollbackStagePath(change) + ".displaced":
		return matchesAfterImage(change, file)
	default:
		return false
	}
}

func rollbackInterrupted(change fileChange) bool {
	staged, err := readHostFile(rollbackStagePath(change))
	if err != nil || !matchesRollbackImage(change, staged) {
		return false
	}
	displaced, err := readHostFile(rollbackStagePath(change) + ".displaced")
	return err == nil && matchesAfterImage(change, displaced)
}
