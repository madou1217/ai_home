package codexenvironments

import (
	"os"
	"path/filepath"
)

// FileName 是 Codex 读取远端执行环境定义的固定文件名。
const FileName = "environments.toml"

// SyncOutcome 是一次落盘的结果。
type SyncOutcome struct {
	Path string
	// Written 为 false 表示内容无变化，未触碰文件。
	Written bool
	// Entries 是实际写入的受管条目数。
	Entries int
	// Rejections 是按连接透出的不可渲染原因；顺序与输入一致。
	Rejections []Rejection
	// DefaultKept 非空表示保留的是用户自己指定的默认环境。
	DefaultKept string
}

// SyncFile 读取 codexHome 下的 environments.toml，并入受管条目后按需原子写回。
//
// 只有内容确实变化时才写盘，且沿用既有文件权限；文件不存在时按 0600 创建。
func SyncFile(codexHome string, entries []Entry, includeLocal bool) (SyncOutcome, error) {
	outcome := SyncOutcome{}
	root := codexHome
	if root == "" {
		return outcome, nil
	}
	path := filepath.Join(root, FileName)
	outcome.Path = path
	existing, err := readExisting(path)
	if err != nil {
		return outcome, err
	}
	merged := Merge(existing, entries, includeLocal)
	outcome.Entries = len(entries)
	outcome.DefaultKept = merged.DefaultKept
	if !merged.Changed {
		return outcome, nil
	}
	if err := writeAtomic(path, merged.Config); err != nil {
		return outcome, err
	}
	outcome.Written = true
	return outcome, nil
}

// Render 是不落盘的版本，供预览与测试使用。
func Render(existing string, entries []Entry, includeLocal bool) string {
	return Merge(existing, entries, includeLocal).Config
}

func readExisting(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return string(raw), nil
}

func writeAtomic(path, content string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	mode := os.FileMode(0o600)
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
	}
	temporary, err := os.CreateTemp(dir, ".aih-codex-environments-*")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer func() { _ = os.Remove(name) }()
	if _, err := temporary.WriteString(content); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Chmod(mode); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
