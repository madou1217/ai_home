package nativeresources

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// InstallCandidate 描述分发包内可用于安装的原生资源源。
type InstallCandidate struct {
	Kind        string   `json:"kind"`
	ID          string   `json:"id"`
	Source      string   `json:"source"`
	Description string   `json:"description,omitempty"`
	Version     string   `json:"version,omitempty"`
	Targets     []string `json:"targets,omitempty"`
	// Origin distinguishes packaged skills from the user's own repository.
	Origin string `json:"origin,omitempty"`
}

type skillCandidateRoot struct {
	dir    string
	source string // relative source prefix; empty means absolute dir
	origin string
}

func (s *Service) skillCandidateRoots() []skillCandidateRoot {
	roots := []skillCandidateRoot{{
		dir:    filepath.Join(s.sourceRoot, "assets", "provider-skills"),
		source: filepath.ToSlash(filepath.Join("assets", "provider-skills")),
		origin: "builtin",
	}}
	if strings.TrimSpace(s.aiHomeDir) != "" {
		roots = append(roots, skillCandidateRoot{
			dir:    filepath.Join(s.aiHomeDir, "skills"),
			origin: "user",
		})
	}
	return roots
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

// describeAll 为插件报告副本补齐 package.json 描述与声明摘要。
func (m *nativePluginManager) describeAll(records []ManagedRecord) []ManagedRecord {
	out := make([]ManagedRecord, len(records))
	cache := make(map[string]pluginMetadata, len(records))
	for i, rec := range records {
		key := rec.ID + "@" + rec.Version
		meta, cached := cache[key]
		if !cached {
			meta = m.metadata(rec)
			cache[key] = meta
		}
		rec.Description = meta.description
		rec.Declaration = meta.declaration
		out[i] = rec
	}
	return out
}

type pluginMetadata struct {
	description string
	declaration []string
}

func (m *nativePluginManager) metadata(rec ManagedRecord) pluginMetadata {
	snapshot := filepath.Join(m.snapshotRoot, rec.ID, rec.Version)
	if pkg, err := verifyPluginSnapshot(snapshot, rec); err == nil {
		return pluginMetadata{description: packageDescription(pkg), declaration: packageDeclaration(pkg)}
	}
	pkg, err := readPluginPackage(rec.Target)
	if err != nil {
		return pluginMetadata{}
	}
	return pluginMetadata{description: packageDescription(pkg), declaration: packageDeclaration(pkg)}
}

func packageDescription(pkg PluginPackage) string {
	description, _ := pkg.PackageJSON["description"].(string)
	return strings.TrimSpace(description)
}

// packageDeclaration 把插件自己的清单折叠成可读声明：引擎/宿主目标、能力、
// 权限与导出入口。它只描述插件声明了什么，不代表宿主已经执行过。
func packageDeclaration(pkg PluginPackage) []string {
	declared := map[string]bool{"kind harness": true}
	if agentPlugin, ok := pkg.PackageJSON["agentPlugin"].(map[string]any); ok {
		if engines, ok := agentPlugin["engines"].(map[string]any); ok {
			for name, versionRange := range engines {
				declared["engine "+name+" "+fmt.Sprint(versionRange)] = true
			}
		}
		if hosts, ok := agentPlugin["hosts"].(map[string]any); ok {
			for name := range hosts {
				declared["host "+name] = true
			}
		}
		if capabilities, ok := agentPlugin["capabilities"].([]any); ok {
			for _, item := range capabilities {
				capability, ok := item.(map[string]any)
				if !ok {
					continue
				}
				id, _ := capability["id"].(string)
				declared[fmt.Sprintf("capability %s@%v", id, capability["version"])] = true
			}
		}
		if permissions, ok := agentPlugin["permissions"].(map[string]any); ok {
			declared[permissionSummary(permissions)] = true
		}
	}
	if exports, ok := pkg.PackageJSON["exports"].(map[string]any); ok {
		for key := range exports {
			declared["export "+key] = true
		}
	}
	if dshMap, ok := pkg.PackageJSON["dsh"].(map[string]any); ok {
		if bundle, ok := dshMap["bundle"].(map[string]any); ok {
			if patch, _ := bundle["patch"].(string); patch != "" {
				declared["dsh patch "+patch] = true
			}
		}
	}
	for _, file := range []string{"gemini-extension.json", ".claude-plugin/plugin.json"} {
		if findPackageFile(pkg.Files, file) != nil {
			declared["manifest "+file] = true
		}
	}
	out := make([]string, 0, len(declared))
	for item := range declared {
		out = append(out, item)
	}
	sort.Strings(out)
	return out
}

// pluginDeclaredTargets 读取 agentPlugin 声明的 Harness / Host 目标，用于安装前过滤。
func pluginDeclaredTargets(pkg PluginPackage) []string {
	declared := map[string]bool{}
	if agentPlugin, ok := pkg.PackageJSON["agentPlugin"].(map[string]any); ok {
		if engines, ok := agentPlugin["engines"].(map[string]any); ok {
			for name := range engines {
				declared[name] = true
			}
		}
		if hosts, ok := agentPlugin["hosts"].(map[string]any); ok {
			for name := range hosts {
				declared[name] = true
			}
		}
	}
	out := make([]string, 0, len(declared))
	for name := range declared {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

func permissionSummary(permissions map[string]any) string {
	parts := make([]string, 0, 3)
	for _, name := range []string{"network", "filesystem", "secrets"} {
		if list, ok := permissions[name].([]any); ok && len(list) > 0 {
			parts = append(parts, fmt.Sprintf("%s:%d", name, len(list)))
		}
	}
	if len(parts) == 0 {
		return "permissions none"
	}
	return "permissions " + strings.Join(parts, ",")
}

// installCandidates 扫描随包交付与用户 Skill 仓，回答“从哪里安装”。
// 同一 ID 以内置包为先，用户仓不能覆盖随包资源。
func (s *Service) installCandidates() []InstallCandidate {
	out := make([]InstallCandidate, 0)
	seenSkills := map[string]bool{}
	for _, root := range s.skillCandidateRoots() {
		entries, err := os.ReadDir(root.dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			pkg, readErr := readSkillPackage(filepath.Join(root.dir, entry.Name()))
			if readErr != nil {
				continue
			}
			if seenSkills[pkg.ID] {
				continue
			}
			seenSkills[pkg.ID] = true
			source := filepath.ToSlash(filepath.Join(root.dir, entry.Name()))
			if root.source != "" {
				source = filepath.ToSlash(filepath.Join(root.source, entry.Name()))
			}
			out = append(out, InstallCandidate{
				Kind:        "skill",
				ID:          pkg.ID,
				Source:      source,
				Description: pkg.Description,
				Origin:      root.origin,
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
				Targets:     pluginDeclaredTargets(pkg),
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
