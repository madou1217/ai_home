package spacegc

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// DedupeOptions 控制硬链接去重。
type DedupeOptions struct {
	MinSize int64
	MinAge  time.Duration
	DryRun  bool
}

// DedupeReport 是一次去重的结果。
type DedupeReport struct {
	Groups     int      `json:"groups"`
	Linked     int      `json:"linked"`
	SavedBytes int64    `json:"savedBytes"`
	Errors     []string `json:"errors"`
}

// Dedupe 在同一卷内把内容完全相同的文件合并成硬链接。
//
// 只用于**不可变证据/发布产物**：文件内容相同、大小相同、且超过 MinAge 没有修改。
// 不处理符号链接、不跨文件系统、遇到任何异常只记录不中断。
func Dedupe(roots []string, opts DedupeOptions) DedupeReport {
	report := DedupeReport{}
	if opts.MinSize <= 0 {
		opts.MinSize = 1024 * 1024
	}
	if opts.MinAge <= 0 {
		opts.MinAge = 24 * time.Hour
	}
	cutoff := time.Now().Add(-opts.MinAge)
	bySize := make(map[int64][]string)
	for _, root := range roots {
		_, _ = os.Stat(root)
		_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if entry.IsDir() {
				if entry.Name() == ".git" || entry.Name() == "node_modules" {
					return filepath.SkipDir
				}
				return nil
			}
			if entry.Type()&os.ModeSymlink != 0 {
				return nil
			}
			info, err := entry.Info()
			if err != nil || info.Size() < opts.MinSize || info.ModTime().After(cutoff) {
				return nil
			}
			bySize[info.Size()] = append(bySize[info.Size()], path)
			return nil
		})
	}
	for _, candidates := range bySize {
		if len(candidates) < 2 {
			continue
		}
		groups := make(map[string][]string)
		for _, path := range candidates {
			digest, err := fileDigest(path)
			if err != nil {
				report.Errors = append(report.Errors, path+": "+err.Error())
				continue
			}
			groups[digest] = append(groups[digest], path)
		}
		for _, paths := range groups {
			if len(paths) < 2 {
				continue
			}
			report.Groups++
			keep := paths[0]
			for _, duplicate := range paths[1:] {
				info, err := os.Stat(duplicate)
				if err != nil {
					continue
				}
				if opts.DryRun {
					report.Linked++
					report.SavedBytes += info.Size()
					continue
				}
				if err := os.Remove(duplicate); err != nil {
					report.Errors = append(report.Errors, duplicate+": "+err.Error())
					continue
				}
				if err := os.Link(keep, duplicate); err != nil {
					// 失败时尽力恢复原文件（从 keep 复制），避免留下空洞。
					_ = copyFile(keep, duplicate)
					report.Errors = append(report.Errors, duplicate+": "+err.Error())
					continue
				}
				report.Linked++
				report.SavedBytes += info.Size()
			}
		}
	}
	return report
}

func fileDigest(path string) (string, error) {
	handle, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer handle.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, handle); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func copyFile(source, target string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}
