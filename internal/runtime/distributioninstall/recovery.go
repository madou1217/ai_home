package distributioninstall

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/accountwriterlease"
)

func recoverJournal(ctx context.Context, o Options, path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var j journal
	if len(raw) > 4<<20 || json.Unmarshal(raw, &j) != nil || j.Version != 1 || j.Home != o.Home || !within(transactionRoot(o.Home), path) {
		return errors.New("安装恢复记录无效")
	}
	if j.Phase == "complete" {
		var receipt Receipt
		raw, err := os.ReadFile(receiptPath(o.Home))
		if err != nil || json.Unmarshal(raw, &receipt) != nil {
			return errors.New("committed_install_receipt_unavailable")
		}
		receipt.State = "installed"
		if err = atomicJSON(receiptPath(o.Home), receipt); err != nil {
			return err
		}
	}
	if j.Phase == "complete" || j.Phase == "rolled_back" {
		return os.Remove(filepath.Join(o.Home, "run", "distribution-install-pending.json"))
	}
	fmt.Fprintln(o.Output, "[aih] 检测到中断的更新，正在恢复原版本和数据…")
	return rollback(ctx, o, &j, path)
}
func rollback(ctx context.Context, o Options, j *journal, jp string) error {
	op, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	h := platformHooks{}
	o.Service = j.ServiceRequested
	if j.Phase == "prepared" {
		// Nothing was published. Clear the transaction admission gate BEFORE
		// restoring service startup; otherwise a previous gate-aware release
		// could immediately exit while the installer reports restored.
		j.Phase = "rolled_back"
		if err := atomicJSON(jp, j); err != nil {
			return err
		}
		if err := os.Remove(filepath.Join(o.Home, "run", "distribution-install-pending.json")); err != nil && !os.IsNotExist(err) {
			return err
		}
		if o.Service {
			if err := h.Restore(op, o, j.Service); err != nil {
				return err
			}
			return verifyRestored(op, o, j.Service)
		}
		return nil
	}

	// Before the stop phase no service/data mutation has happened.
	if o.Service && j.Phase != "prepared" && j.Phase != "stopped" {
		current := j.Service
		current.Installed = true
		current.Running = true
		if err := h.Stop(op, o, current); err != nil {
			return err
		}
	}
	writer, writerErr := accountwriterlease.Acquire(o.Home)
	if writerErr != nil {
		return errors.New("恢复前无法排除数据写入者，已保留两份数据")
	}
	writerOpen := true
	defer func() {
		if writerOpen {
			_ = writer.Close()
		}
	}()
	if j.Data != nil && (len(j.Displaced) > 0 || len(j.Published) > 0) {
		displaced := filepath.Join(filepath.Dir(jp), "displaced")
		failed := filepath.Join(filepath.Dir(jp), "failed-data")
		if err := privateDir(failed); err != nil {
			return err
		}
		originallyPresent := map[string]bool{}
		for _, entry := range j.Data.SourceFingerprint.Files {
			originallyPresent[entry.Name] = entry.Exists
		}
		for _, name := range dataFiles {
			target := filepath.Join(o.Home, name)
			saved := filepath.Join(displaced, name)
			_, savedErr := os.Lstat(saved)
			if savedErr != nil && !os.IsNotExist(savedErr) {
				return savedErr
			}
			// A crash before a displacement rename leaves the ORIGINAL in place. Do
			// not move it aside or invent a missing copy merely because intent was saved.
			if os.IsNotExist(savedErr) && originallyPresent[name] {
				continue
			}
			if _, err := os.Lstat(target); err == nil {
				backup := filepath.Join(failed, name)
				if _, e := os.Lstat(backup); e == nil {
					return errors.New("恢复目标已存在，保留两份数据并停止")
				}
				if err := replaceFile(target, backup); err != nil {
					return err
				}
			} else if !os.IsNotExist(err) {
				return err
			}
			if savedErr == nil {
				if err := replaceFile(saved, target); err != nil {
					return err
				}
			}
		}
	}
	if err := restoreFile(j.PreviousLauncher); err != nil {
		return err
	}
	if j.PreviousBinding.Path != "" {
		if err := restoreFile(j.PreviousBinding); err != nil {
			return err
		}
	}
	if err := restoreFile(j.PreviousReceipt); err != nil {
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	writerOpen = false
	j.Phase = "rolled_back"
	if err := atomicJSON(jp, j); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(o.Home, "run", "distribution-install-pending.json")); err != nil && !os.IsNotExist(err) {
		return err
	}
	if o.Service {
		if err := h.Restore(op, o, j.Service); err != nil {
			return err
		}
		return verifyRestored(op, o, j.Service)
	}

	return nil
}
