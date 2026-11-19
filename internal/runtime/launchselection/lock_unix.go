//go:build !windows

package launchselection

import (
	"os"
	"syscall"
)

// lockUsage 对选号状态加进程间排他锁并读出当前内容。
// 并发启动时后到者会等前一个写回"刚刚用过"，从而挑到不同的账号。
func lockUsage(aiHomeDir string) (*usageState, *os.File, error) {
	path := usagePath(aiHomeDir)
	if err := os.MkdirAll(dirOf(path), 0o755); err != nil {
		return nil, nil, err
	}
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, nil, err
	}
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		_ = lock.Close()
		return nil, nil, err
	}
	raw, _ := os.ReadFile(path)
	return parseUsage(raw), lock, nil
}

func releaseUsage(lock *os.File) {
	if lock == nil {
		return
	}
	_ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	_ = lock.Close()
}
