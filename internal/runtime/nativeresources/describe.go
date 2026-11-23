package nativeresources

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// InstallCandidate 描述分发包内可用于安装的原生资源源。
type InstallCandidate struct {
	Kind        string `json:"kind"`
	ID          string `json:"id"`
	Source      string `json:"source"`
	Description string `json:"description,omitempty"`
	Version     string `json:"version,omitempty"`
}

// skillCandidatesRoots 是分发包内相对 package root 的 Skill 源目录。
var skillCandidatesRoots = []string{
	filepath.Join("assets", "provider-skills"),
}

// pluginCandidatesRoots 是分发包内相对 package root 的插件源目录。
var pluginCandidatesRoots = []string{
	filepath.Join("assets", "native-plugins"),
	filepath.Join("assets", "plugins"),
}

// describeAll 为报告副本补齐人类可读描述。同一摘要会在多个 Provider 间重复，
// 因此按摘要缓存一次读取；读取失败只留空描述，不影响生命周期接口。
func (m *skillManager) describeAll(records []ManagedRecord) []ManagedRecord {
	out := make([]ManagedRecord, len(records))
	cache := make(map[string]string, len(records))
	for i, rec := range records {
		description, cached := cache[rec.Digest]
		if !cached {
			description = m.describe(rec)
			cache[rec.Digest] = description
		}
		rec.Description = description
		out[i] = rec
	}
	return out
}

func (m *skillManager) describe(rec ManagedRecord) string {
	if pkg, err := m.packageFor(rec); err == nil {
		return pkg.Description
	}
	// 快照缺失时退回读取当前投影目录，只对目录投影成立。
	if rec.Mode != "native" {
		return ""
	}
	pkg, err := readSkillPackage(rec.Target)
	if err != nil {
		return ""
	}
	return pkg.Description
}

// describeAll 为插件报告副本补齐 package.json 描述。
func (m *nativePluginManager) describeAll(records []ManagedRecord) []ManagedRecord {
	out := make([]ManagedRecord, len(records))
	cache := make(map[string]string, len(records))
	for i, rec := range records {
		key := rec.ID + "@" + rec.Version
		description, cached := cache[key]
		if !cached {
			description = m.describe(rec)
			cache[key] = description
		}
		rec.Description = description
		out[i] = rec
	}
	return out
}

func (m *nativePluginManager) describe(rec ManagedRecord) string {
	snapshot := filepath.Join(m.snapshotRoot, rec.ID, rec.Version)
	if pkg, err := verifyPluginSnapshot(snapshot, rec); err == nil {
		return packageDescription(pkg)
	}
	pkg, err := readPluginPackage(rec.Target)
	if err != nil {
		return ""
	}
	return packageDescription(pkg)
}

func packageDescription(pkg PluginPackage) string {
	description, _ := pkg.PackageJSON["description"].(string)
	return strings.TrimSpace(description)
}

// installCandidates 扫描分发包内随包交付的 Skill/Plugin 源，回答“从哪里安装”。
func (s *Service) installCandidates() []InstallCandidate {
	out := make([]InstallCandidate, 0)
	for _, root := range skillCandidatesRoots {
		dir := filepath.Join(s.sourceRoot, root)
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			pkg, readErr := readSkillPackage(filepath.Join(dir, entry.Name()))
			if readErr != nil {
				continue
			}
			out = append(out, InstallCandidate{
				Kind:        "skill",
				ID:          pkg.ID,
				Source:      filepath.ToSlash(filepath.Join(root, entry.Name())),
				Description: pkg.Description,
			})
		}
	}
	for _, root := range pluginCandidatesRoots {
		dir := filepath.Join(s.sourceRoot, root)
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			pkg, readErr := readPluginPackage(filepath.Join(dir, entry.Name()))
			if readErr != nil {
				continue
			}
			out = append(out, InstallCandidate{
				Kind:        "plugin",
				ID:          pkg.ID,
				Source:      filepath.ToSlash(filepath.Join(root, entry.Name())),
				Description: packageDescription(pkg),
				Version:     pkg.Version,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		if out[i].ID != out[j].ID {
			return out[i].ID < out[j].ID
		}
		return out[i].Source < out[j].Source
	})
	return out
}
