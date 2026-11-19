package harnessrun

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	privateDirMode  os.FileMode = 0o700
	privateFileMode os.FileMode = 0o600
)

var projectionIDUnsafe = regexp.MustCompile(`[^a-z0-9._-]+`)

// normalizeProjectionID 与 Node projection.normalizeId 同语义。
func normalizeProjectionID(value string) string {
	text := strings.ToLower(strings.TrimSpace(value))
	text = projectionIDUnsafe.ReplaceAllString(text, "-")
	text = strings.Trim(text, "-")
	if text == "" {
		return "pool"
	}
	return text
}

// resolveProjectionRoot 返回 <aiHome>/run/harness/<id>/<ref> 并创建目录。
func resolveProjectionRoot(aiHomeDir string, harnessID string, accountRef string) (string, error) {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return "", errors.New("ai_home_dir_missing")
	}
	ref := strings.TrimSpace(accountRef)
	if ref == "" {
		ref = "pool"
	}
	projection := filepath.Join(
		root,
		"run",
		"harness",
		normalizeProjectionID(harnessID),
		normalizeProjectionID(ref),
	)
	if err := os.MkdirAll(projection, privateDirMode); err != nil {
		return "", err
	}
	return projection, nil
}

// writePrivateJSON 复刻 writePrivateJson：JSON.stringify(value, null, 2) + '\n'。
func writePrivateJSON(filePath string, value any) error {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return err
	}
	return writePrivateText(filePath, buffer.String())
}

// writePrivateText 以同目录临时文件 + rename 原子写入，权限 0600。
func writePrivateText(filePath string, text string) error {
	if err := os.MkdirAll(filepath.Dir(filePath), privateDirMode); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(filePath), "."+filepath.Base(filePath)+".*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}
	if err := temporary.Chmod(privateFileMode); err != nil {
		cleanup()
		return err
	}
	if _, err := temporary.WriteString(text); err != nil {
		cleanup()
		return err
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryPath)
		return err
	}
	if err := os.Rename(temporaryPath, filePath); err != nil {
		_ = os.Remove(temporaryPath)
		return err
	}
	return nil
}

// sessionSummary 只保留写链接时可观察的结果（Node sessionSummary 子集）。
type sessionSummary struct {
	Linked     int
	Unresolved []string
	Errors     []string
}

// linkHostSessions 把投影里的 sessions 目录链回宿主那一份。
//
// 只实现 pi / dsh / dsh-tui 需要的「目录条目」路径，语义对齐
// lib/runtime/shared-store-linker.js 的 ensureSharedStoreEntries：
// fail-closed（投影等于共享根 / 共享根落在投影内部都不建链）、幂等、
// 真实非空目录不静默丢弃。
func linkHostSessions(projectionRoot string, hostHomeDir string, hostSegments []string) sessionSummary {
	summary := sessionSummary{}
	if strings.TrimSpace(hostHomeDir) == "" {
		summary.Errors = append(summary.Errors, "host_home_missing")
		return summary
	}
	sharedRoot := filepath.Join(append([]string{hostHomeDir}, hostSegments...)...)
	if samePath(projectionRoot, sharedRoot) {
		return summary
	}
	if isInsidePath(sharedRoot, projectionRoot) {
		return summary
	}
	segments := []string{"sessions"}
	src := filepath.Join(append([]string{projectionRoot}, segments...)...)
	dst := filepath.Join(append([]string{sharedRoot}, segments...)...)
	label := strings.Join(segments, "/")
	if err := ensureDirLink(src, dst); err != nil {
		if errors.Is(err, errRealEntryPresent) {
			summary.Unresolved = append(summary.Unresolved, label)
		} else {
			summary.Errors = append(summary.Errors, label+":"+err.Error())
		}
		return summary
	}
	summary.Linked++
	return summary
}

var errRealEntryPresent = errors.New("real_entry_present")

func ensureDirLink(src string, dst string) error {
	info, err := os.Lstat(src)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			target, readErr := os.Readlink(src)
			if readErr == nil {
				resolved := target
				if !filepath.IsAbs(resolved) {
					resolved = filepath.Join(filepath.Dir(src), resolved)
				}
				if samePath(resolved, dst) {
					return nil
				}
			}
			if removeErr := os.Remove(src); removeErr != nil {
				return removeErr
			}
		} else if info.IsDir() && isDisposableEmptyDir(src) {
			if removeErr := os.RemoveAll(src); removeErr != nil {
				return removeErr
			}
		} else {
			// 真实数据不静默丢弃（Node discardRealEntries=false 口径）。
			return errRealEntryPresent
		}
	}
	if err := os.MkdirAll(dst, 0o777); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(src), privateDirMode); err != nil {
		return err
	}
	return os.Symlink(dst, src)
}

func isDisposableEmptyDir(path string) bool {
	entries, err := os.ReadDir(path)
	return err == nil && len(entries) == 0
}

func normalizeForCompare(value string) string {
	return strings.ToLower(strings.TrimRight(strings.ReplaceAll(value, "\\", "/"), "/"))
}

func samePath(left string, right string) bool {
	return normalizeForCompare(left) == normalizeForCompare(right)
}

func isInsidePath(child string, parent string) bool {
	childNorm := normalizeForCompare(child)
	parentNorm := normalizeForCompare(parent)
	if childNorm == "" || parentNorm == "" {
		return false
	}
	return childNorm == parentNorm || strings.HasPrefix(childNorm, parentNorm+"/")
}
