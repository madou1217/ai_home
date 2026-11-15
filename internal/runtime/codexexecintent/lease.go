package codexexecintent

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
)

// The inode is never deleted: replacing it would let two processes lock distinct
// files for the same thread. It is not a vendor DB/rollout mutation.
func acquire(home, id string) (func(), error) {
	// Account projections may have different CODEX_HOME directories pointing
	// at one native session store. Lock beside the canonical shared store.
	root := home
	if resolved, err := filepath.EvalSymlinks(filepath.Join(home, "sessions")); err == nil {
		root = filepath.Dir(resolved)
	} else if resolved, err := filepath.EvalSymlinks(home); err == nil {
		root = resolved
	}
	dir := filepath.Join(root, ".aih-exec-intent")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("codex_exec_lease_unavailable")
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("codex_exec_lease_invalid")
	}
	sum := sha256.Sum256([]byte(id))
	p := filepath.Join(dir, hex.EncodeToString(sum[:])+".lock")
	if st, e := os.Lstat(p); e == nil && !st.Mode().IsRegular() {
		return nil, fmt.Errorf("codex_exec_lease_invalid")
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("codex_exec_lease_unavailable")
	}
	st, err := os.Lstat(p)
	opened, e := f.Stat()
	if err != nil || e != nil || !st.Mode().IsRegular() || !os.SameFile(st, opened) {
		f.Close()
		return nil, fmt.Errorf("codex_exec_lease_changed")
	}
	if err := lock(f); err != nil {
		f.Close()
		return nil, fmt.Errorf("codex_exec_thread_busy")
	}
	return func() { unlock(f); _ = f.Close() }, nil
}
