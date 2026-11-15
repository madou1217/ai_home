package codexdefault

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

type defaultState = sqliteaccount.HostDefaultState

func readDefaultState(ctx context.Context, store *sqliteaccount.Store, root string) (defaultState, error) {
	return store.ReadCodexHostDefaultState(ctx, root)
}

// recoverJournal never overwrites later user edits. The account selection and
// compatibility metadata commit in the same business DB; native files still need
// a recovery journal because filesystem publication is a separate boundary.
func recoverJournal(ctx context.Context, path, configPath, authPath string, store *sqliteaccount.Store, root string) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4*maxHostFileBytes || !privateFile(path, info) {
		return fmt.Errorf("codex_default_recovery_required")
	}
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("codex_default_recovery_required")
	}
	opened, statErr := file.Stat()
	if statErr != nil || !os.SameFile(info, opened) {
		file.Close()
		return fmt.Errorf("codex_default_recovery_required")
	}
	data, err := io.ReadAll(io.LimitReader(file, 4*maxHostFileBytes+1))
	file.Close()
	if err != nil || len(data) > 4*maxHostFileBytes {
		return fmt.Errorf("codex_default_recovery_required")
	}

	var prior journal
	if json.Unmarshal(data, &prior) != nil || prior.Version != 2 || len(prior.Files) == 0 || len(prior.Files) > 2 {
		return fmt.Errorf("codex_default_recovery_required")
	}
	seen := make(map[string]bool)
	for _, change := range prior.Files {
		if change.Before.Path != configPath && change.Before.Path != authPath {
			return fmt.Errorf("codex_default_recovery_scope_mismatch")
		}
		if seen[change.Before.Path] || change.Before.Mode & ^os.FileMode(0o777) != 0 || change.Mode & ^os.FileMode(0o777) != 0 || len(change.Before.Data) > maxHostFileBytes || len(change.After) > maxHostFileBytes {
			return fmt.Errorf("codex_default_recovery_invalid_journal")
		}
		if !stagePathValid(change) {
			return fmt.Errorf("codex_default_recovery_invalid_stage")
		}
		seen[change.Before.Path] = true
	}
	if err := verifyStages(prior.Files); err != nil {
		return err
	}
	current, err := readDefaultState(ctx, store, root)
	if err != nil {
		return err
	}
	switch {
	case current == prior.Before:
		if err := rollbackFiles(prior.Files); err != nil {
			return err
		}
	case current == prior.After:
		if err := verifyPublished(prior.Files); err != nil {
			return fmt.Errorf("codex_default_recovery_external_edit")
		}

	default:
		return fmt.Errorf("codex_default_recovery_required: default state changed during interrupted operation")
	}
	if err := cleanupStages(prior.Files); err != nil {
		return err
	}
	if err := removeJournal(path); err != nil {
		return fmt.Errorf("codex_default_journal_cleanup_failed")
	}
	return nil
}

func journalPath(home string) string { return filepath.Join(home, ".aih-default-change.json") }
