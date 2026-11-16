package claudedesktopconfig

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/configsnapshot"
	"github.com/madou1217/ai_home/internal/runtime/fileexchange"
	"github.com/madou1217/ai_home/internal/runtime/jsondocument"
)

func allowedRelative(rel string) bool {
	if rel == stateName || rel == "developer_settings.json" || rel == "claude_desktop_config.json" || rel == filepath.Join("configLibrary", "_meta.json") {
		return true
	}
	return filepath.Dir(rel) == "configLibrary" && idPattern.MatchString(strings.TrimSuffix(filepath.Base(rel), ".json")) && strings.HasSuffix(rel, ".json")
}
func validateTransaction(t transaction, profile string) error {
	if t.Version != 1 || t.Profile != profile || (t.Mode != "api" && t.Mode != "web") || !idPattern.MatchString(t.ConfigID) || len(t.RequestSHA256) != 64 {
		return fail("desktop_transaction_invalid")
	}
	if _, err := hex.DecodeString(t.RequestSHA256); err != nil {
		return fail("desktop_transaction_invalid")
	}
	if len(t.Changes) < 1 || len(t.Changes) > 5 || len(t.Guards) > 5 {
		return fail("desktop_transaction_invalid")
	}
	seen := map[string]bool{}
	for _, c := range t.Changes {
		if !allowedRelative(c.Relative) || seen[c.Relative] || !filepath.IsAbs(c.Resolved) || len(c.Before) > configsnapshot.MaxBytes || len(c.After) > configsnapshot.MaxBytes || c.Mode > 0777 || (!c.Existed && len(c.Before) != 0) {
			return fail("desktop_transaction_invalid")
		}
		seen[c.Relative] = true
		if _, err := jsondocument.Object(c.After); err != nil {
			return fail("desktop_transaction_invalid")
		}
		if c.Existed {
			if _, err := jsondocument.Object(c.Before); err != nil {
				return fail("desktop_transaction_invalid")
			}
		}
	}
	for _, g := range t.Guards {
		if !allowedRelative(g.Relative) || seen[g.Relative] || !filepath.IsAbs(g.Resolved) || len(g.Before) > configsnapshot.MaxBytes || len(g.After) != 0 || g.Mode > 0777 {
			return fail("desktop_transaction_invalid")
		}
		seen[g.Relative] = true
	}
	return nil
}
func readTransaction(marker, profile string) (transaction, bool, error) {
	var t transaction
	info, err := os.Lstat(marker)
	if errors.Is(err, os.ErrNotExist) {
		return t, false, nil
	}
	if err != nil {
		return t, false, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxJournalBytes || info.Mode().Perm()&0077 != 0 {
		return t, true, fail("desktop_transaction_invalid")
	}
	file, err := os.Open(marker)
	if err != nil {
		return t, true, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return t, true, fail("desktop_transaction_changed")
	}
	raw, err := io.ReadAll(io.LimitReader(file, maxJournalBytes+1))
	if err != nil || len(raw) > maxJournalBytes {
		return t, true, fail("desktop_transaction_invalid")
	}
	if _, err = jsondocument.Object(raw); err != nil {
		return t, true, fail("desktop_transaction_invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&t); err != nil {
		return t, true, fail("desktop_transaction_invalid")
	}
	if err = validateTransaction(t, profile); err != nil {
		return t, true, err
	}
	return t, true, nil
}
func writeTransaction(marker string, t transaction) error {
	if err := validateTransaction(t, t.Profile); err != nil {
		return err
	}
	raw, err := json.Marshal(t)
	if err != nil || len(raw) > maxJournalBytes {
		return fail("desktop_transaction_too_large")
	}
	file, err := os.CreateTemp(filepath.Dir(marker), ".aih-desktop-journal-")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	defer file.Close()
	if err = file.Chmod(0600); err != nil {
		return err
	}
	if _, err = file.Write(raw); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	if err = fileexchange.MoveAside(name, marker); err != nil {
		return fail("desktop_transaction_changed")
	}
	return nil
}
func publish(ctx context.Context, t transaction) error {
	// Validate every observed file before the first write and again before each
	// publication. Earlier completed steps may equal After; all other edits stop.
	verify := func() error {
		if ctx.Err() != nil {
			return fail("desktop_preparation_cancelled")
		}
		for _, g := range t.Guards {
			snapshot, err := configsnapshot.Read(filepath.Join(t.Profile, g.Relative))
			if err != nil {
				return err
			}
			if !beforeMatches(snapshot, g) {
				return fail("desktop_configuration_changed")
			}
		}
		for _, c := range t.Changes {
			file := filepath.Join(t.Profile, c.Relative)
			resolved, err := configsnapshot.Resolve(file)
			if err != nil || resolved != c.Resolved {
				return fail("desktop_configuration_path_changed")
			}
			snapshot, err := configsnapshot.Read(file)
			if errors.Is(err, configsnapshot.ErrRecovery) {
				continue
			} // Update validates/reconciles its own durable file journal.
			if err != nil {
				return err
			}
			if !beforeMatches(snapshot, c) && !afterMatches(snapshot, c) {
				return fail("desktop_configuration_changed")
			}
		}
		return nil
	}
	if err := verify(); err != nil {
		return err
	}
	for _, c := range t.Changes {
		if ctx.Err() != nil {
			return fail("desktop_preparation_cancelled")
		}
		if err := verify(); err != nil {
			return err
		}
		_, err := configsnapshot.Update(filepath.Join(t.Profile, c.Relative), func(snapshot configsnapshot.Snapshot) ([]byte, bool, error) {
			if ctx.Err() != nil {
				return nil, false, fail("desktop_preparation_cancelled")
			}
			if afterMatches(snapshot, c) {
				return nil, false, nil
			}
			if !beforeMatches(snapshot, c) {
				return nil, false, fail("desktop_configuration_changed")
			}
			return c.After, false, nil
		})
		if err != nil {
			return err
		}
	}
	if err := verify(); err != nil {
		return err
	}
	// Completion requires every write to still equal its committed postimage.
	// A reverted preimage is retryable pending work, not successful preparation.
	for _, c := range t.Changes {
		snapshot, err := configsnapshot.Read(filepath.Join(t.Profile, c.Relative))
		if err != nil {
			return err
		}
		if !afterMatches(snapshot, c) {
			return fail("desktop_configuration_changed")
		}
	}
	if ctx.Err() != nil {
		return fail("desktop_preparation_cancelled")
	}
	return nil
}
func finishTransaction(marker string, t transaction) error {
	latest, found, err := readTransaction(marker, t.Profile)
	if err != nil || !found {
		return fail("desktop_transaction_changed")
	}
	a, _ := json.Marshal(t)
	b, _ := json.Marshal(latest)
	if !bytes.Equal(a, b) {
		return fail("desktop_transaction_changed")
	}
	archive := marker + ".completed-" + t.RequestSHA256[:16] + "-" + t.ConfigID
	if err = fileexchange.MoveAside(marker, archive); err != nil {
		return fail("desktop_transaction_cleanup_required")
	}
	if err = os.Remove(archive); err != nil {
		return fail("desktop_transaction_cleanup_required")
	}
	return nil
}
