package artifactstore

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// SessionEntryMerge 是"把投影里的真实内容并进宿主存储"的机械动作声明。
//
// Node 仍决定数据语义（哪些条目算会话存储、provider 专有的 JSON 合并、空壳替换
// 策略）；Go 只执行：整条目 move、递归目录合并、同内容文件丢弃、空目录收尾。
// 跨设备 rename（EXDEV）不复制，留给调用方按 unresolved 处理。
type SessionEntryMerge struct {
	SourcePath         string `json:"sourcePath"`
	TargetPath         string `json:"targetPath"`
	ReplaceEmptyTarget bool   `json:"replaceEmptyTarget,omitempty"`
}

type SessionEntryMergeResult struct {
	Status   string `json:"status"`
	Migrated int    `json:"migrated,omitempty"`
	Error    string `json:"error,omitempty"`
}

const (
	mergeStatusMoved      = "moved"
	mergeStatusMerged     = "merged"
	mergeStatusDeduped    = "deduped"
	mergeStatusDiscarded  = "discarded"
	mergeStatusUnresolved = "unresolved"
	mergeStatusSkipped    = "skipped"
)

const mergeSameContentLimit = 16 * 1024 * 1024

func applySessionEntryMerges(request Request) []SessionEntryMergeResult {
	results := make([]SessionEntryMergeResult, 0, len(request.SessionEntryMerges))
	for _, entry := range request.SessionEntryMerges {
		results = append(results, applySessionEntryMerge(entry))
	}
	return results
}

func applySessionEntryMerge(entry SessionEntryMerge) SessionEntryMergeResult {
	sourcePath := strings.TrimSpace(entry.SourcePath)
	targetPath := strings.TrimSpace(entry.TargetPath)
	result := SessionEntryMergeResult{Status: mergeStatusSkipped}
	if sourcePath == "" || targetPath == "" {
		return result
	}
	sourceInfo, err := lstatOrNil(sourcePath)
	if err != nil {
		result.Status = mergeStatusUnresolved
		result.Error = errnoName(err)
		return result
	}
	if sourceInfo == nil {
		return result
	}
	targetInfo, err := lstatOrNil(targetPath)
	if err != nil {
		result.Status = mergeStatusUnresolved
		result.Error = errnoName(err)
		return result
	}

	if targetInfo == nil {
		return moveWholeEntry(sourcePath, targetPath, result)
	}

	// 宿主那份是空壳、投影这份有内容：删掉空壳再移动（不复制）。
	if entry.ReplaceEmptyTarget && !sourceInfo.IsDir() {
		if replaced, ok, err := replaceEmptyTarget(sourcePath, targetPath); err != nil {
			result.Status = mergeStatusUnresolved
			result.Error = errnoName(err)
			return result
		} else if replaced {
			result.Migrated = 1
			if !ok {
				result.Status = mergeStatusUnresolved
				return result
			}
			result.Status = mergeStatusMoved
			result.Migrated = 2
			return result
		}
	}

	if sourceInfo.IsDir() {
		storeInfo, err := statOrNil(targetPath)
		if err != nil {
			result.Status = mergeStatusUnresolved
			result.Error = errnoName(err)
			return result
		}
		if storeInfo == nil || !storeInfo.IsDir() {
			if err := os.RemoveAll(sourcePath); err != nil {
				result.Status = mergeStatusUnresolved
				result.Error = errnoName(err)
				return result
			}
			result.Status = mergeStatusDiscarded
			result.Migrated = 1
			return result
		}
		migrated, err := mergeDirectoryInto(sourcePath, targetPath)
		if err != nil {
			result.Status = mergeStatusUnresolved
			result.Error = errnoName(err)
			return result
		}
		// 合并完只剩空壳的源目录收掉。
		if removed, err := removeDirIfEmpty(sourcePath); err != nil {
			result.Status = mergeStatusUnresolved
			result.Error = errnoName(err)
			return result
		} else {
			migrated += removed
		}
		result.Status = mergeStatusMerged
		result.Migrated = migrated
		return result
	}

	if sameContent(sourcePath, targetPath) {
		if err := os.RemoveAll(sourcePath); err != nil {
			result.Status = mergeStatusUnresolved
			result.Error = errnoName(err)
			return result
		}
		result.Status = mergeStatusDeduped
		result.Migrated = 1
		return result
	}
	if err := os.RemoveAll(sourcePath); err != nil {
		result.Status = mergeStatusUnresolved
		result.Error = errnoName(err)
		return result
	}
	result.Status = mergeStatusDiscarded
	result.Migrated = 1
	return result
}

func moveWholeEntry(sourcePath, targetPath string, result SessionEntryMergeResult) SessionEntryMergeResult {
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		result.Status = mergeStatusUnresolved
		result.Error = errnoName(err)
		return result
	}
	if err := os.Rename(sourcePath, targetPath); err != nil {
		if errors.Is(err, syscall.EXDEV) {
			result.Status = mergeStatusUnresolved
			return result
		}
		result.Status = mergeStatusUnresolved
		result.Error = errnoName(err)
		return result
	}
	result.Status = mergeStatusMoved
	result.Migrated = 1
	return result
}

// replaceEmptyTarget 只在宿主是 0 字节文件、投影有内容时替换；返回 (是否适用, 是否移动成功, err)。
func replaceEmptyTarget(sourcePath, targetPath string) (bool, bool, error) {
	sourceInfo, err := os.Stat(sourcePath)
	if err != nil {
		return false, false, err
	}
	targetInfo, err := os.Stat(targetPath)
	if err != nil {
		// 目标 lstat 存在但 stat 失败（悬挂链接等）按错误上报，与 Node 的
		// fs.statSync 同口径，不静默丢弃投影内容。
		return false, false, err
	}
	if targetInfo.Size() != 0 || sourceInfo.Size() <= 0 {
		return false, false, nil
	}
	targetLinkInfo, err := lstatOrNil(targetPath)
	if err != nil {
		return true, false, err
	}
	if targetLinkInfo != nil && targetLinkInfo.IsDir() {
		if err := os.RemoveAll(targetPath); err != nil {
			return true, false, err
		}
	} else if err := os.Remove(targetPath); err != nil && !os.IsNotExist(err) {
		return true, false, err
	}
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return true, false, err
	}
	if err := os.Rename(sourcePath, targetPath); err != nil {
		if errors.Is(err, syscall.EXDEV) {
			return true, false, nil
		}
		return true, false, err
	}
	return true, true, nil
}

// mergeDirectoryInto 复制/搬移语义与 Node 的 mergeDirectoryIntoStore 一致：
// 已存在且同内容的文件丢弃源；内容不同则丢弃源；目录递归合并；悬挂链接丢弃，
// 活链接原样保留（由调用方按 unresolved 处理）。
func mergeDirectoryInto(sourceDir, targetDir string) (int, error) {
	entries, err := os.ReadDir(sourceDir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		return 0, err
	}
	migrated := 0
	for _, entry := range entries {
		sourcePath := filepath.Join(sourceDir, entry.Name())
		targetPath := filepath.Join(targetDir, entry.Name())
		info, err := os.Lstat(sourcePath)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return migrated, err
		}

		if info.IsDir() {
			targetInfo, err := statOrNil(targetPath)
			if err != nil {
				return migrated, err
			}
			if targetInfo != nil && !targetInfo.IsDir() {
				if err := os.RemoveAll(sourcePath); err != nil {
					return migrated, err
				}
				migrated++
				continue
			}
			nested, err := mergeDirectoryInto(sourcePath, targetPath)
			if err != nil {
				return migrated, err
			}
			migrated += nested
			if removed, err := removeDirIfEmpty(sourcePath); err != nil {
				return migrated, err
			} else {
				migrated += removed
			}
			continue
		}

		if info.Mode()&os.ModeSymlink != 0 {
			if _, err := os.Stat(sourcePath); err != nil {
				if os.IsNotExist(err) {
					if err := os.RemoveAll(sourcePath); err != nil {
						return migrated, err
					}
					migrated++
					continue
				}
				return migrated, err
			}
			// 活链接可能指向投影外的状态：不递归、不复制，留给上层 unresolved。
			continue
		}

		// 目标不存在 → 搬过去；EXDEV 留给上层，不复制。
		if targetMissing(targetPath) {
			if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
				return migrated, err
			}
			if err := os.Rename(sourcePath, targetPath); err != nil {
				if errors.Is(err, syscall.EXDEV) {
					continue
				}
				return migrated, err
			}
			migrated++
			continue
		}

		if sameContent(sourcePath, targetPath) {
			if err := os.RemoveAll(sourcePath); err != nil {
				return migrated, err
			}
			migrated++
			continue
		}
		if err := os.RemoveAll(sourcePath); err != nil {
			return migrated, err
		}
		migrated++
	}
	return migrated, nil
}

func targetMissing(targetPath string) bool {
	info, err := lstatOrNil(targetPath)
	return err == nil && info == nil
}

func removeDirIfEmpty(dirPath string) (int, error) {
	children, err := os.ReadDir(dirPath)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	if len(children) > 0 {
		return 0, nil
	}
	if err := os.Remove(dirPath); err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	return 1, nil
}

// sameContent 与 Node 的 filesHaveSameContent 同口径：普通文件、大小一致、
// 不超过 16MB 且逐字节相同。
func sameContent(leftPath, rightPath string) bool {
	left, err := os.Stat(leftPath)
	if err != nil {
		return false
	}
	right, err := os.Stat(rightPath)
	if err != nil {
		return false
	}
	if !left.Mode().IsRegular() || !right.Mode().IsRegular() || left.Size() != right.Size() {
		return false
	}
	if left.Size() > mergeSameContentLimit {
		return false
	}
	leftBytes, err := os.ReadFile(leftPath)
	if err != nil {
		return false
	}
	rightBytes, err := os.ReadFile(rightPath)
	if err != nil {
		return false
	}
	return bytes.Equal(leftBytes, rightBytes)
}
