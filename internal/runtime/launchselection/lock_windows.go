//go:build windows

package launchselection

import "os"

// lockUsage 在 Windows 上不加锁：选号仍可用，只是并发启动可能挑到同一个账号。
func lockUsage(aiHomeDir string) (*usageState, *os.File, error) {
	path := usagePath(aiHomeDir)
	if err := os.MkdirAll(dirOf(path), 0o755); err != nil {
		return nil, nil, err
	}
	raw, _ := os.ReadFile(path)
	return parseUsage(raw), nil, nil
}

func releaseUsage(_ *os.File) {}
