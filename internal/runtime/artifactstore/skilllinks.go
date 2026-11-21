package artifactstore

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// SkillLinkEntry 是 CodeBuddy 家族的技能视图：公用实体在 storeSkillsDir，
// 账号目录里只放"启用了哪些"的逐技能链接。
type SkillLinkEntry struct {
	StoreSkillsDir   string   `json:"storeSkillsDir"`
	AccountSkillsDir string   `json:"accountSkillsDir"`
	ProjectionRoot   string   `json:"projectionRoot,omitempty"`
	Disabled         []string `json:"disabledSkills,omitempty"`
	Enabled          []string `json:"enabledSkills,omitempty"`
}

// SkillLinkResult 与 Node 的 summary 字段一致。
type SkillLinkResult struct {
	Linked     int      `json:"linked"`
	Removed    int      `json:"removed"`
	Kept       int      `json:"kept"`
	Skipped    []string `json:"skipped,omitempty"`
	Unresolved []string `json:"unresolved,omitempty"`
}

func applySkillLinks(request Request) []SkillLinkResult {
	results := make([]SkillLinkResult, 0, len(request.SkillLinks))
	for _, entry := range request.SkillLinks {
		results = append(results, applySkillLink(entry, request.Platform))
	}
	return results
}

func applySkillLink(entry SkillLinkEntry, platform string) SkillLinkResult {
	result := SkillLinkResult{}
	storeDir := strings.TrimSpace(entry.StoreSkillsDir)
	accountDir := strings.TrimSpace(entry.AccountSkillsDir)
	if storeDir == "" || accountDir == "" {
		return result
	}
	// 旧布局：账号 skills 目录本身是指向共享库的整目录链接。先摘链接（只删链接
	// 本身，实体不动）再重建逐技能视图。这一步要在“投影外跳过”之前做：旧链接
	// 的目标就在共享库里，按路径判定必然算投影外。
	if info, err := lstatOrNil(accountDir); err == nil && info != nil &&
		isLinkEntry(info, accountDir) && linkPointsTo(accountDir, storeDir) {
		if err := os.Remove(accountDir); err != nil {
			return result
		}
		result.Removed++
	}
	// 账号目录如果已经落在投影外（例如 workbuddy 的 `.workbuddy-ai` 整体链到宿主
	// runtime home），那份 skills 本来就是全机唯一一份；再"按账号启用"只会改写共享
	// 目录、影响所有账号。直接跳过，绝不在投影外做增删。
	if outsideProjection(entry.ProjectionRoot, accountDir) {
		result.Skipped = append(result.Skipped, "shared-external")
		return result
	}
	// 投影内的其它整目录链接：同样只摘链接本身，随后按技能重建。
	if info, err := lstatOrNil(accountDir); err == nil && info != nil && isLinkEntry(info, accountDir) {
		if err := os.Remove(accountDir); err != nil {
			return result
		}
		result.Removed++
	}
	if err := os.MkdirAll(accountDir, 0o755); err != nil {
		return result
	}

	disabled := make(map[string]bool, len(entry.Disabled))
	for _, name := range entry.Disabled {
		if trimmed := strings.TrimSpace(name); trimmed != "" {
			disabled[trimmed] = true
		}
	}
	var enabledOnly map[string]bool
	if len(entry.Enabled) > 0 {
		enabledOnly = make(map[string]bool, len(entry.Enabled))
		for _, name := range entry.Enabled {
			if trimmed := strings.TrimSpace(name); trimmed != "" {
				enabledOnly[trimmed] = true
			}
		}
	}

	wanted := map[string]string{}
	for _, name := range storeSkillNames(storeDir) {
		if disabled[name] {
			continue
		}
		if enabledOnly != nil && !enabledOnly[name] {
			continue
		}
		wanted[name] = filepath.Join(storeDir, name)
	}

	// 1) 清掉不再需要的链接：禁用的、来源已失效的（静默丢弃）。
	if children, err := os.ReadDir(accountDir); err == nil {
		for _, child := range children {
			name := child.Name()
			linkPath := filepath.Join(accountDir, name)
			info, err := lstatOrNil(linkPath)
			if err != nil || info == nil {
				continue
			}
			if !isLinkEntry(info, linkPath) {
				// 账号自己放的真实目录/文件不动，也不参与启用集合（交给用户）。
				if _, ok := wanted[name]; !ok {
					result.Unresolved = append(result.Unresolved, name)
				}
				continue
			}
			target, ok := wanted[name]
			if ok && linkPointsTo(linkPath, target) {
				if exists, _ := lstatOrNil(target); exists != nil {
					result.Kept++
					continue
				}
			}
			if err := os.Remove(linkPath); err != nil {
				result.Unresolved = append(result.Unresolved, name)
				continue
			}
			result.Removed++
		}
	}

	// 2) 补上缺失的链接。来源失效（启用但实体不在）静默跳过。
	names := make([]string, 0, len(wanted))
	for name := range wanted {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		target := wanted[name]
		linkPath := filepath.Join(accountDir, name)
		info, err := lstatOrNil(linkPath)
		if err != nil {
			result.Unresolved = append(result.Unresolved, name)
			continue
		}
		if info != nil {
			if isLinkEntry(info, linkPath) && linkPointsTo(linkPath, target) {
				// 步骤 1 已经统计过这条正确链接，这里不重复计数。
				continue
			}
			if !isLinkEntry(info, linkPath) {
				result.Unresolved = append(result.Unresolved, name)
				continue
			}
			// 指向别处的旧链接：摘掉后重建（步骤 1 通常已处理，这里兜底）。
			if err := os.Remove(linkPath); err != nil {
				result.Unresolved = append(result.Unresolved, name)
				continue
			}
		}
		if exists, _ := lstatOrNil(target); exists == nil {
			result.Skipped = append(result.Skipped, name)
			continue
		}
		if err := createSkillDirLink(target, linkPath, platform); err != nil {
			result.Unresolved = append(result.Unresolved, name)
			continue
		}
		result.Linked++
	}
	return result
}

// createSkillDirLink 建技能目录链接。Windows 优先 junction（不需要开发者模式/管理员），
// 失败再退符号链接；POSIX 直接符号链接。
func createSkillDirLink(target, link, platform string) error {
	if isWindowsPlatform(normalizePlatform(platform)) {
		if err := createJunction(target, link); err == nil {
			return nil
		}
	}
	return os.Symlink(target, link)
}

// outsideProjection 判断 target 的真实路径是否落在 projectionRoot 之外。
// 目标不存在时按父目录的真实路径判断（skills/ 常常还没建出来）。
func outsideProjection(projectionRoot, target string) bool {
	root := strings.TrimSpace(projectionRoot)
	if root == "" {
		return false
	}
	rootReal := resolveRealPath(root)
	resolved := resolveRealPath(target)
	rootClean := filepath.Clean(rootReal)
	targetClean := filepath.Clean(resolved)
	if targetClean == rootClean {
		return false
	}
	return !strings.HasPrefix(targetClean, rootClean+string(filepath.Separator))
}

// storeSkillNames 返回共享库里的技能目录名（只认目录，跳过点开头条目）。
func storeSkillNames(storeDir string) []string {
	children, err := os.ReadDir(storeDir)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(children))
	for _, child := range children {
		name := child.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		info, err := os.Stat(filepath.Join(storeDir, name))
		if err != nil || !info.IsDir() {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
