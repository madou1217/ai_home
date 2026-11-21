package artifactstore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// FamilyLink 是 CodeBuddy 家族共享条目的"纯建链"声明。
//
// 只覆盖不需要搬迁/合并的分支：链接已正确、链接指向别处、缺失但目标存在、
// 空目录、空 models.json 外壳、真实内容（unresolved）。需要 union 合并/配置合并的
// 条目由 Node 先处理，不会出现在这里。
type FamilyLink struct {
	LinkPath   string `json:"linkPath"`
	TargetPath string `json:"targetPath"`
}

type FamilyLinkFailure struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

type FamilyLinkResult struct {
	Linked     []string            `json:"linked,omitempty"`
	Unchanged  []string            `json:"unchanged,omitempty"`
	Unresolved []string            `json:"unresolved,omitempty"`
	Failed     []FamilyLinkFailure `json:"failed,omitempty"`
}

func applyFamilyLinks(request Request) FamilyLinkResult {
	result := FamilyLinkResult{}
	for _, link := range request.FamilyLinks {
		applyFamilyLink(link, request.Platform, &result)
	}
	return result
}

func applyFamilyLink(link FamilyLink, platform string, result *FamilyLinkResult) {
	linkPath := strings.TrimSpace(link.LinkPath)
	targetPath := strings.TrimSpace(link.TargetPath)
	if linkPath == "" || targetPath == "" {
		return
	}
	fail := func(err error) {
		result.Failed = append(result.Failed, FamilyLinkFailure{Path: linkPath, Error: errnoName(err)})
	}
	info, err := lstatOrNil(linkPath)
	if err != nil {
		fail(err)
		return
	}
	targetInfo, err := lstatOrNil(targetPath)
	if err != nil {
		fail(err)
		return
	}
	// 已存在链接：指向正确目标算 unchanged，指向别处一律 unresolved（不替换）。
	if info != nil && isLinkEntry(info, linkPath) {
		if linkTargetEquals(linkPath, targetPath) {
			result.Unchanged = append(result.Unchanged, linkPath)
			return
		}
		result.Unresolved = append(result.Unresolved, linkPath)
		return
	}
	// 链接位置还不存在：规范存储里也没有这份条目就不凭空造。
	if info == nil {
		if targetInfo == nil {
			return
		}
		if err := createAtomicLink(linkPath, targetPath, targetInfo.IsDir(), platform); err != nil {
			fail(err)
			return
		}
		result.Linked = append(result.Linked, linkPath)
		return
	}
	// 空目录：删掉空壳，目标缺失时建目录，再建链。
	if info.IsDir() && isDisposableEmptyDir(linkPath, info) {
		if err := os.Remove(linkPath); err != nil {
			fail(err)
			return
		}
		if targetInfo == nil {
			if err := os.MkdirAll(targetPath, 0o755); err != nil {
				fail(err)
				return
			}
		}
		if err := createAtomicLink(linkPath, targetPath, true, platform); err != nil {
			fail(err)
			return
		}
		result.Linked = append(result.Linked, linkPath)
		return
	}
	// 空 models.json（CLI 自建的空壳）且规范存储有实物：换链接。
	if targetInfo != nil && isEmptyModelCatalogFile(linkPath) {
		if err := os.Remove(linkPath); err != nil {
			fail(err)
			return
		}
		if err := createAtomicLink(linkPath, targetPath, targetInfo.IsDir(), platform); err != nil {
			fail(err)
			return
		}
		result.Linked = append(result.Linked, linkPath)
		return
	}
	// 真实目录/文件且里面有东西：不搬、不删、不复制。
	result.Unresolved = append(result.Unresolved, linkPath)
}

// linkTargetEquals 与 Node 的 isSymbolicLinkTo 同口径：解析相对目标后逐字比较。
func linkTargetEquals(linkPath, targetPath string) bool {
	link, err := os.Readlink(linkPath)
	if err != nil {
		return false
	}
	if !filepath.IsAbs(link) {
		link = filepath.Join(filepath.Dir(linkPath), link)
	}
	return filepath.Clean(link) == filepath.Clean(targetPath)
}

// createAtomicLink 先建同目录临时链接再 rename 到位：并发启动时最多互相覆盖同一个
// 链接，不会留下半成品。
func createAtomicLink(linkPath, targetPath string, isDir bool, platform string) error {
	if err := os.MkdirAll(filepath.Dir(linkPath), 0o755); err != nil {
		return err
	}
	temporary := linkPath + ".aih-link-" + processSuffix()
	if err := os.Remove(temporary); err != nil && !os.IsNotExist(err) {
		return err
	}
	if isDir && isWindowsPlatform(normalizePlatform(platform)) {
		if err := createJunction(targetPath, temporary); err != nil {
			return err
		}
	} else {
		if err := os.Symlink(targetPath, temporary); err != nil {
			return err
		}
	}
	return os.Rename(temporary, linkPath)
}

// processSuffix 给临时链接名加进程内唯一后缀（与 Node 的 pid-Date.now() 同类）。
func processSuffix() string {
	return strconv.Itoa(os.Getpid()) + "-" + strconv.FormatInt(time.Now().UnixNano(), 10)
}

// isEmptyModelCatalogFile 只认 models.json 的空壳（[] / {"models":[]} / {}），
// 有内容一律不动。
func isEmptyModelCatalogFile(filePath string) bool {
	if filepath.Base(filePath) != "models.json" {
		return false
	}
	info, err := os.Lstat(filePath)
	if err != nil || info.IsDir() || info.Size() > 4096 {
		return false
	}
	raw, err := os.ReadFile(filePath)
	if err != nil {
		return false
	}
	text := strings.TrimSpace(string(raw))
	if text == "" {
		return true
	}
	var parsed interface{}
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		return false
	}
	switch value := parsed.(type) {
	case []interface{}:
		return len(value) == 0
	case map[string]interface{}:
		if models, ok := value["models"].([]interface{}); ok {
			return len(models) == 0
		}
		return len(value) == 0
	default:
		return false
	}
}
