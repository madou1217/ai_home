package codexruntime

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// Transaction serializes manual installs and scheduler updates across processes.
// Failed attempts never change the receipt or overwrite a selected executable.
type Transaction struct {
	Root      string
	Prefix    string
	lock      *os.File
	committed bool
}

func Begin(home string) (*Transaction, error) {
	root := Root(home)
	if !filepath.IsAbs(root) {
		return nil, errors.New("Codex managed root must be absolute")
	}
	if err := os.MkdirAll(filepath.Join(root, "releases"), 0o700); err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(filepath.Join(root, "mutation.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err = lockExclusive(lock); err != nil {
		_ = lock.Close()
		return nil, fmt.Errorf("Codex 正在安装或更新，请稍后重试: %w", err)
	}
	prefix, err := os.MkdirTemp(filepath.Join(root, "releases"), "runtime-")
	if err != nil {
		unlock(lock)
		_ = lock.Close()
		return nil, err
	}
	return &Transaction{Root: root, Prefix: prefix, lock: lock}, nil
}

func (tx *Transaction) Activate(binary, version string) error {
	if tx == nil || tx.lock == nil || tx.committed {
		return errors.New("Codex runtime transaction is not active")
	}
	rel, err := filepath.Rel(tx.Prefix, binary)
	if err != nil {
		return err
	}
	actual, err := confinedExecutable(tx.Prefix, rel)
	if err != nil || !NativeExecutable(actual) {
		return errors.New("Codex candidate is not a managed native executable")
	}
	f, err := os.Open(actual)
	if err != nil {
		return err
	}
	hash := sha256.New()
	size, err := io.Copy(hash, f)
	_ = f.Close()
	if err != nil {
		return err
	}
	selection := Selection{Generation: filepath.Base(tx.Prefix), Executable: rel, Version: version, SHA256: hex.EncodeToString(hash.Sum(nil)), Size: size}
	if _, err = selectionPath(tx.Root, selection); err != nil {
		return err
	}
	_, old, err := current(tx.Root)
	if err != nil {
		// A user-confirmed repair may replace an invalid receipt, but never
		// discards it or its generations. Preserve raw recovery evidence first.
		if err = tx.retainBrokenReceipt(); err != nil {
			return err
		}
		old = nil
	}
	rec := Receipt{Format: 1, Current: selection, ActivatedAt: time.Now().UTC()}
	if old != nil {
		previous := old.Current
		rec.Previous = &previous
	}
	data, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return err
	}
	if err = writeAtomic(filepath.Join(tx.Root, receiptName), append(data, '\n')); err != nil {
		return err
	}
	tx.committed = true
	return nil
}

func (tx *Transaction) Close() {
	if tx == nil || tx.lock == nil {
		return
	}
	// Only this uncommitted attempt is disposable. Never prune current/previous
	// generations or a legacy .aih-original; an old process may still use them.
	if !tx.committed {
		_ = os.RemoveAll(tx.Prefix)
	}
	unlock(tx.lock)
	_ = tx.lock.Close()
	tx.lock = nil
}

func writeAtomic(target string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(target), ".runtime-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0o600); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return replaceFile(name, target)
}

// RestoreVersion reselects a retained verified previous generation without
// network access. It is only invoked by an explicit rollback transaction.
func (tx *Transaction) RestoreVersion(version string) (bool, error) {
	if tx == nil || tx.lock == nil || tx.committed {
		return false, errors.New("Codex runtime transaction is not active")
	}
	rec, err := readReceipt(tx.Root)
	if err != nil || rec == nil {
		return false, err
	}
	if rec.Disabled {
		return false, errors.New("managed Codex runtime is disabled")
	}
	if rec.Current.Version == version {
		if _, err := selectionPath(tx.Root, rec.Current); err == nil {
			return true, nil
		}
	}
	if rec.Previous == nil || rec.Previous.Version != version {
		return false, nil
	}
	if _, err = selectionPath(tx.Root, *rec.Previous); err != nil {
		return false, err
	}
	previous := rec.Current
	rec.Current, rec.Previous, rec.ActivatedAt = *rec.Previous, &previous, time.Now().UTC()
	data, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return false, err
	}
	if err = writeAtomic(filepath.Join(tx.Root, receiptName), append(data, '\n')); err != nil {
		return false, err
	}
	return true, nil
}

func (tx *Transaction) retainBrokenReceipt() error {
	source, err := os.Open(filepath.Join(tx.Root, receiptName))
	if err != nil {
		return err
	}
	defer source.Close()
	file, err := os.CreateTemp(tx.Root, "runtime-recovery-*.json")
	if err != nil {
		return err
	}
	defer file.Close()
	if err = file.Chmod(0o600); err != nil {
		return err
	}
	if _, err = io.Copy(file, source); err != nil {
		return err
	}
	return file.Sync()
}

// Deactivate removes the managed selection, not rollback data or an executable
// still used by a running session. A tombstone prevents legacy PATH resurrection.
func (tx *Transaction) Deactivate() error {
	_, rec, err := current(tx.Root)
	if err != nil {
		return err
	}
	if rec == nil {
		return errors.New("managed Codex runtime is not installed")
	}
	rec.Disabled = true
	rec.ActivatedAt = time.Now().UTC()
	data, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(tx.Root, receiptName), append(data, '\n'))
}
