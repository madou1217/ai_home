package configsnapshot

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/madou1217/ai_home/internal/runtime/fileexchange"
	"os"
	"path/filepath"
)

func finishPublication(target string, j Journal, before Snapshot) error {
	current, err := readAt(target)
	if err != nil {
		return ErrRecovery
	}
	if j.Remove {
		if current.Exists {
			return ErrRecovery
		}
	} else if !current.Exists || digest(current.Content) != j.After {
		return ErrRecovery
	}
	displaced := j.Stage
	if _, err = os.Lstat(j.Stage + ".displaced"); err == nil {
		displaced = j.Stage + ".displaced"
	}
	if j.Existed {
		prior, err := readAt(displaced)
		if err != nil || !prior.Exists || digest(prior.Content) != j.Before {
			return ErrRecovery
		}
		if before.info != nil && !os.SameFile(before.info, prior.info) {
			return ErrRecovery
		}
	}
	// Archive the verified completion before any cleanup. An interrupted cleanup
	// can leave private evidence, but never a blocking ownerless transaction.
	completed := j.Stage + ".committed"
	if err = fileexchange.MoveAside(target+".aih-config-transaction.json", completed); err != nil {
		return ErrRecovery
	}
	if j.Existed {
		if err = os.Remove(displaced); err != nil {
			return errors.New("native_config_cleanup_required")
		}
	}
	if err = os.Remove(completed); err != nil {
		return errors.New("native_config_cleanup_required")
	}
	return nil
}

func recoverPublication(target string) error {
	marker := target + ".aih-config-transaction.json"
	record, err := readAt(marker)
	if err != nil {
		return err
	}
	if !record.Exists {
		return nil
	}
	var j Journal
	if json.Unmarshal(record.Content, &j) != nil || len(j.Before) != 64 || len(j.After) != 64 || j.Version != 1 || j.Target != target || filepath.Dir(j.Stage) != filepath.Dir(target) || !bytes.HasPrefix([]byte(filepath.Base(j.Stage)), []byte(".aih-config-stage-")) {
		return ErrRecovery
	}
	if _, err := hex.DecodeString(j.Before); err != nil {
		return ErrRecovery
	}
	if _, err := hex.DecodeString(j.After); err != nil {
		return ErrRecovery
	}
	current, err := readAt(target)
	if err != nil {
		return ErrRecovery
	}
	if (!j.Remove && current.Exists && digest(current.Content) == j.After) || (j.Remove && !current.Exists) {
		return finishPublication(target, j, Snapshot{})
	}
	// Windows may stop between moving the original aside and publishing new.
	// Restore only the exact saved preimage to an absent target, never over a
	// later file; the next invocation can then retry from a fresh snapshot.
	if !current.Exists && j.Existed && !j.Remove {
		prior, e := readAt(j.Stage + ".displaced")
		if e == nil && prior.Exists && digest(prior.Content) == j.Before {
			if e = fileexchange.MoveAside(j.Stage+".displaced", target); e != nil {
				return ErrRecovery
			}
			current = prior
		}
	}
	staged, err := readAt(j.Stage)
	if err != nil {
		return ErrRecovery
	}
	if j.Remove && current.Exists && digest(current.Content) == j.Before && !staged.Exists {
		completed := j.Stage + ".cancelled"
		if err = fileexchange.MoveAside(marker, completed); err != nil {
			return ErrRecovery
		}
		return os.Remove(completed)
	}
	if current.Exists == j.Existed && digest(current.Content) == j.Before && staged.Exists && digest(staged.Content) == j.After {
		// Journal committed but publication never occurred; retry from a fresh snapshot.
		completed := j.Stage + ".cancelled"
		if err = fileexchange.MoveAside(marker, completed); err != nil {
			return ErrRecovery
		}
		if err = os.Remove(j.Stage); err != nil {
			return errors.New("native_config_cleanup_required")
		}
		return os.Remove(completed)
	}
	return ErrRecovery
}
