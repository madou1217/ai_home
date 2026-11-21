package artifactstore

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// LegacyLibraryLink 是旧版 macOS 投影的迁移声明：旧版本把宿主的整个
// Library/Preferences 链进每个账号投影；新版要求把快照复制到账号私有 runtime home，
// 再把投影改成指向这份私有快照。
//
// 复制语义与 Node 的 fse.copySync({overwrite:false, errorOnExist:false,
// dereference:false}) 一致：已存在的条目不覆盖，符号链接按链接复制（不跟随）。
// Detach 只摘链接（Keychains 这类不复制快照的条目）。
type LegacyLibraryLink struct {
	LinkPath         string `json:"linkPath"`
	TargetPath       string `json:"targetPath"`
	LegacyTargetPath string `json:"legacyTargetPath"`
	Detach           bool   `json:"detach,omitempty"`
}

type LegacyLibraryLinkResult struct {
	LinkPath string `json:"linkPath"`
	Status   string `json:"status"`
	Migrated int    `json:"migrated,omitempty"`
	Linked   int    `json:"linked,omitempty"`
	Error    string `json:"error,omitempty"`
}

const (
	legacyLibraryLinked     = "linked"
	legacyLibraryDetached   = "detached"
	legacyLibraryUnchanged  = "unchanged"
	legacyLibraryUnresolved = "unresolved"
	legacyLibrarySkipped    = "skipped"
)

func applyLegacyLibraryLinks(request Request) []LegacyLibraryLinkResult {
	results := make([]LegacyLibraryLinkResult, 0, len(request.LegacyLibraryLinks))
	for _, entry := range request.LegacyLibraryLinks {
		results = append(results, applyLegacyLibraryLink(entry, normalizePlatform(request.Platform)))
	}
	return results
}

func applyLegacyLibraryLink(entry LegacyLibraryLink, platform string) LegacyLibraryLinkResult {
	linkPath := strings.TrimSpace(entry.LinkPath)
	result := LegacyLibraryLinkResult{LinkPath: linkPath, Status: legacyLibrarySkipped}
	targetPath := strings.TrimSpace(entry.TargetPath)
	legacyTargetPath := strings.TrimSpace(entry.LegacyTargetPath)
	if linkPath == "" || (!entry.Detach && targetPath == "") || legacyTargetPath == "" {
		return result
	}
	fail := func(err error) LegacyLibraryLinkResult {
		result.Status = legacyLibraryUnresolved
		result.Error = errnoName(err)
		return result
	}

	info, err := lstatOrNil(linkPath)
	if err != nil {
		return fail(err)
	}
	if info == nil {
		return result
	}
	if !isLinkEntry(info, linkPath) {
		// 真实目录/文件不是旧版链接，原样不动（调用方会另行对账）。
		result.Status = legacyLibraryUnresolved
		return result
	}
	if linkTargetEquals(linkPath, targetPath) {
		result.Status = legacyLibraryUnchanged
		return result
	}
	// 只处理"恰好指向宿主旧路径"的链接；指向别处说明不是 aih 建的旧链接。
	legacyLink, err := os.Readlink(linkPath)
	if err != nil {
		return fail(err)
	}
	if !filepath.IsAbs(legacyLink) {
		legacyLink = filepath.Join(filepath.Dir(linkPath), legacyLink)
	}
	if !sameLinkTarget(legacyLink, legacyTargetPath, platform) {
		result.Status = legacyLibraryUnresolved
		return result
	}

	if entry.Detach {
		if err := os.Remove(linkPath); err != nil {
			return fail(err)
		}
		result.Status = legacyLibraryDetached
		result.Migrated = 1
		return result
	}

	if err := os.MkdirAll(targetPath, 0o755); err != nil {
		return fail(err)
	}
	if legacyInfo, statErr := os.Stat(legacyTargetPath); statErr == nil && legacyInfo.IsDir() {
		if err := copyTreeNoOverwrite(legacyTargetPath, targetPath); err != nil {
			return fail(err)
		}
		result.Migrated = 1
	} else if statErr != nil && !os.IsNotExist(statErr) {
		return fail(statErr)
	}
	if err := os.Remove(linkPath); err != nil {
		return fail(err)
	}
	if err := createBridgeLink(targetPath, linkPath, true, platform); err != nil {
		return fail(err)
	}
	result.Status = legacyLibraryLinked
	result.Linked = 1
	return result
}

// sameLinkTarget 与 Node 的 normalizePathForLinkCompare 同口径：
// Windows 上路径大小写不敏感。
func sameLinkTarget(left, right, platform string) bool {
	if isWindowsPlatform(platform) {
		return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
	}
	return filepath.Clean(left) == filepath.Clean(right)
}

// copyTreeNoOverwrite 复制目录树：已存在的条目不覆盖，符号链接按链接复制。
func copyTreeNoOverwrite(source, destination string) error {
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	existing, err := lstatOrNil(destination)
	if err != nil {
		return err
	}
	switch {
	case info.Mode()&os.ModeSymlink != 0:
		if existing != nil {
			return nil
		}
		link, err := os.Readlink(source)
		if err != nil {
			return err
		}
		return os.Symlink(link, destination)
	case info.IsDir():
		// 目标目录已存在时继续往下合并（与 fse.copySync 一致），只跳过冲突条目。
		if existing != nil && !existing.IsDir() {
			return nil
		}
		if existing == nil {
			if err := os.MkdirAll(destination, info.Mode().Perm()); err != nil {
				return err
			}
		}
		children, err := os.ReadDir(source)
		if err != nil {
			return err
		}
		for _, child := range children {
			if err := copyTreeNoOverwrite(
				filepath.Join(source, child.Name()),
				filepath.Join(destination, child.Name()),
			); err != nil {
				return err
			}
		}
		return nil
	case info.Mode().IsRegular():
		if existing != nil {
			return nil
		}
		return copyFileNoOverwrite(source, destination, info.Mode().Perm())
	default:
		return fmt.Errorf("unsupported file type: %s", source)
	}
}

func copyFileNoOverwrite(source, destination string, mode os.FileMode) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		if os.IsExist(err) {
			return nil
		}
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		_ = os.Remove(destination)
		return err
	}
	return out.Close()
}
