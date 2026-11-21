package artifactstore

import (
	"os"
	"path/filepath"
	"strings"
)

// BridgeLink 是 opencode 这类"按条目桥接"的声明：把账号目录里的条目链到宿主共享目录，
// 并把宿主已有的条目补链回账号目录。
//
// 与 familyLinks 的差异（刻意不复用）：
//   - 指向别处的链接是"摘掉重建"（migrated），不是 unresolved；
//   - 文件条目允许悬挂（opencode.db-wal 之类启动时可能还不存在）；
//   - 失败要带错误码，调用方按原样抛出。
type BridgeLink struct {
	LinkPath   string `json:"linkPath"`
	TargetPath string `json:"targetPath"`
	Kind       string `json:"kind"` // "dir" | "file"
	Label      string `json:"label,omitempty"`
}

type BridgeLinkError struct {
	Code       string `json:"code"`
	LinkPath   string `json:"linkPath"`
	TargetPath string `json:"targetPath"`
}

type BridgeLinkResult struct {
	Migrated   int              `json:"migrated"`
	Linked     int              `json:"linked"`
	Unresolved []string         `json:"unresolved,omitempty"`
	Error      *BridgeLinkError `json:"error,omitempty"`
}

const bridgeLinkErrorCode = "opencode_shared_bridge_failed"

type BridgeLinks struct {
	EnsureDirs []string     `json:"ensureDirs,omitempty"`
	Links      []BridgeLink `json:"links"`
}

func applyBridgeLinks(input BridgeLinks, platform string) BridgeLinkResult {
	result := BridgeLinkResult{}
	for _, dir := range input.EnsureDirs {
		trimmed := strings.TrimSpace(dir)
		if trimmed == "" {
			continue
		}
		if err := os.MkdirAll(trimmed, 0o755); err != nil {
			result.Error = &BridgeLinkError{Code: errnoName(err), LinkPath: trimmed}
			return result
		}
	}
	for _, link := range input.Links {
		migrated, linked, label, err := applyBridgeLink(link, platform)
		if err != nil {
			result.Error = &BridgeLinkError{
				Code:       bridgeLinkErrorCode,
				LinkPath:   strings.TrimSpace(link.LinkPath),
				TargetPath: strings.TrimSpace(link.TargetPath),
			}
			return result
		}
		if migrated {
			result.Migrated++
		}
		if linked {
			result.Linked++
		}
		if label != "" {
			result.Unresolved = append(result.Unresolved, label)
		}
	}
	return result
}

// applyBridgeLink 返回 (migrated, linked, unresolvedLabel, err)。
func applyBridgeLink(link BridgeLink, platform string) (bool, bool, string, error) {
	linkPath := strings.TrimSpace(link.LinkPath)
	targetPath := strings.TrimSpace(link.TargetPath)
	if linkPath == "" || targetPath == "" {
		return false, false, "", nil
	}
	label := strings.TrimSpace(link.Label)
	if label == "" {
		label = linkPath
	}
	// 已经是指向目标的链接：不动。
	if bridgeLinkCanonical(linkPath, targetPath) {
		return false, false, "", nil
	}
	info, err := lstatOrNil(linkPath)
	if err != nil {
		return false, false, "", err
	}
	migrated := false
	if info != nil {
		switch {
		case isLinkEntry(info, linkPath):
			// 替换链接本身不会删到目标数据。
			if err := os.Remove(linkPath); err != nil {
				return false, false, "", err
			}
			migrated = true
		case info.IsDir() && isDisposableEmptyDir(linkPath, info):
			if err := os.Remove(linkPath); err != nil {
				return false, false, "", err
			}
			migrated = true
		default:
			// 真实目录或文件里有内容：原样不动。
			return false, false, label, nil
		}
	}
	if strings.EqualFold(strings.TrimSpace(link.Kind), "dir") {
		if err := os.MkdirAll(targetPath, 0o755); err != nil {
			return migrated, false, "", err
		}
	}
	if err := createBridgeLink(targetPath, linkPath, strings.EqualFold(strings.TrimSpace(link.Kind), "dir"), platform); err != nil {
		return migrated, false, "", err
	}
	return migrated, true, "", nil
}

// bridgeLinkCanonical 判断链接是否已指向目标（解析相对目标后逐字比较）。
func bridgeLinkCanonical(linkPath, targetPath string) bool {
	link, err := os.Readlink(linkPath)
	if err != nil {
		return false
	}
	if !filepath.IsAbs(link) {
		link = filepath.Join(filepath.Dir(linkPath), link)
	}
	return filepath.Clean(link) == filepath.Clean(targetPath)
}

func createBridgeLink(targetPath, linkPath string, isDir bool, platform string) error {
	if isDir && isWindowsPlatform(normalizePlatform(platform)) {
		return createJunction(targetPath, linkPath)
	}
	return os.Symlink(targetPath, linkPath)
}
