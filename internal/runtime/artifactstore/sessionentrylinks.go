package artifactstore

import (
	"os"
	"path/filepath"
	"strings"
)

// SessionEntryLink 是"工具配置目录里的条目链接"声明：把投影里的一个条目接回宿主存储。
//
// Node 仍决定语义（哪些条目算会话存储、是不是伪 HOME 里 Provider 自己的别名、
// 目标缺失时要不要预建目录）；Go 只执行文件系统动作，并在动手前重新核对当前状态：
//   - 链接已指向目标 → unchanged；
//   - 链接指向别处 → 伪 HOME 别名原样保留（alias），其余 unresolved（不替换）；
//   - 会话条目的空目录 → 补目标目录，再把空壳换成链接；
//   - 其余真实内容 → unresolved（内容合并/搬迁是 Node 的数据语义，不在执行点里）。
//
// 单独做 primitive 而不复用 familyLinks：这里的链接指向别处时要摘掉重建、
// 空目录可以替换、悬挂的伪 HOME 别名要丢弃，三处语义都不同。
type SessionEntryLink struct {
	LinkPath        string `json:"linkPath"`
	TargetPath      string `json:"targetPath"`
	Kind            string `json:"kind,omitempty"` // dir|file；缺省按目标当前类型
	SessionEntry    bool   `json:"sessionEntry,omitempty"`
	Precreated      bool   `json:"precreated,omitempty"`
	UnownedFakeHome bool   `json:"unownedFakeHome,omitempty"`
}

type SessionEntryLinkResult struct {
	LinkPath string `json:"linkPath"`
	Status   string `json:"status"`
	Migrated int    `json:"migrated,omitempty"`
	Error    string `json:"error,omitempty"`
}

const (
	sessionLinkLinked     = "linked"
	sessionLinkUnchanged  = "unchanged"
	sessionLinkAlias      = "alias"
	sessionLinkUnresolved = "unresolved"
	sessionLinkSkipped    = "skipped"
)

func applySessionEntryLinks(request Request) []SessionEntryLinkResult {
	results := make([]SessionEntryLinkResult, 0, len(request.SessionEntryLinks))
	for _, entry := range request.SessionEntryLinks {
		results = append(results, applySessionEntryLink(entry, normalizePlatform(request.Platform)))
	}
	return results
}

func applySessionEntryLink(entry SessionEntryLink, platform string) SessionEntryLinkResult {
	linkPath := strings.TrimSpace(entry.LinkPath)
	result := SessionEntryLinkResult{LinkPath: linkPath, Status: sessionLinkSkipped}
	targetPath := strings.TrimSpace(entry.TargetPath)
	if linkPath == "" || targetPath == "" {
		return result
	}
	fail := func(err error) SessionEntryLinkResult {
		result.Status = sessionLinkUnresolved
		result.Error = errnoName(err)
		return result
	}

	linkInfo, err := lstatOrNil(linkPath)
	if err != nil {
		return fail(err)
	}
	targetInfo, err := statOrNil(targetPath)
	if err != nil {
		return fail(err)
	}
	isDir := entry.Kind == "dir"
	if targetInfo != nil {
		isDir = targetInfo.IsDir()
	}

	// 已是指向目标的链接：不动（Node 侧大部分情况已在调用前判过，这里兜底）。
	if linkInfo != nil && isLinkEntry(linkInfo, linkPath) {
		if linkTargetEquals(linkPath, targetPath) {
			if kindMatchesLink(linkPath, isDir) {
				result.Status = sessionLinkUnchanged
				return result
			}
			if err := os.Remove(linkPath); err != nil {
				return fail(err)
			}
			result.Migrated++
			linkInfo = nil
		} else if !entry.UnownedFakeHome {
			result.Status = sessionLinkUnresolved
			return result
		} else if aliasInfo, aliasErr := statOrNil(linkPath); aliasErr != nil {
			return fail(aliasErr)
		} else if aliasInfo != nil {
			// 伪 HOME 里 Provider 自己的别名：目标在投影外，删投影不会丢数据，原样保留。
			result.Status = sessionLinkAlias
			return result
		} else {
			// 悬挂的伪 HOME 别名：目标本来就不在，链接保护不了任何数据。
			if err := os.Remove(linkPath); err != nil {
				return fail(err)
			}
			result.Migrated++
			linkInfo = nil
		}
	}

	if linkInfo != nil {
		// 只有会话条目的空目录可以安全替换：不搬家、不复制、不覆盖真实会话。
		if !entry.SessionEntry || !linkInfo.IsDir() || !isStrictlyEmptyDir(linkPath) {
			result.Status = sessionLinkUnresolved
			return result
		}
		if err := os.MkdirAll(targetPath, 0o755); err != nil {
			return fail(err)
		}
		targetInfo, err = statOrNil(targetPath)
		if err != nil {
			return fail(err)
		}
		isDir = targetInfo == nil || targetInfo.IsDir()
		if err := os.Remove(linkPath); err != nil {
			return fail(err)
		}
		result.Migrated++
	}

	if targetInfo == nil {
		// 全新账号 + 声明为预建目录：先建宿主目录，再建链。
		if !entry.Precreated {
			return result
		}
		if err := os.MkdirAll(targetPath, 0o755); err != nil {
			return fail(err)
		}
		isDir = true
	}
	if err := os.MkdirAll(filepath.Dir(linkPath), 0o755); err != nil {
		return fail(err)
	}
	if err := createSessionEntryLink(linkPath, targetPath, isDir, platform); err != nil {
		return fail(err)
	}
	result.Status = sessionLinkLinked
	return result
}

// statOrNil 跟随链接取目标现状；ENOENT 视为"目标不存在"（与 Node 的 statIfExists 同口径）。
func statOrNil(target string) (os.FileInfo, error) {
	info, err := os.Stat(target)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	return info, nil
}

func isStrictlyEmptyDir(target string) bool {
	children, err := os.ReadDir(target)
	if err != nil {
		return false
	}
	return len(children) == 0
}

func kindMatchesLink(linkPath string, isDir bool) bool {
	info, err := os.Stat(linkPath)
	if err != nil {
		return false
	}
	return info.IsDir() == isDir
}

// createSessionEntryLink 与 Node 的 createManagedLinkSafe 同口径：
// Windows 目录走 junction；Windows 文件先试符号链接、没有权限时退回硬链接；
// 其它平台一律符号链接。
func createSessionEntryLink(linkPath, targetPath string, isDir bool, platform string) error {
	if isWindowsPlatform(platform) {
		if isDir {
			return createJunction(targetPath, linkPath)
		}
		if err := os.Symlink(targetPath, linkPath); err == nil {
			return nil
		}
		return os.Link(targetPath, linkPath)
	}
	return os.Symlink(targetPath, linkPath)
}
