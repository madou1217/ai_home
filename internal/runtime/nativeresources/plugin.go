package nativeresources

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/runtime/providerconfigs"
)

var (
	semverRe     = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$`)
	secretNameRe = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$`)
	contribIDRe  = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,127}$`)
)

// PluginPackage 表示校验通过的本地插件包元数据、文件集合及摘要。
type PluginPackage struct {
	Root        string
	ID          string
	Version     string
	PackageJSON map[string]any
	Files       []PackageFile
	Digest      string
}

func isCanonicalSemver(v string) bool {
	m := semverRe.FindStringSubmatch(v)
	if m == nil {
		return false
	}
	if m[4] != "" {
		for _, part := range strings.Split(m[4], ".") {
			isDigits := true
			for _, r := range part {
				if r < '0' || r > '9' {
					isDigits = false
					break
				}
			}
			if isDigits && len(part) > 1 && part[0] == '0' {
				return false
			}
		}
	}
	return true
}

func findPackageFile(files []PackageFile, name string) *PackageFile {
	for i := range files {
		if files[i].Name == name {
			return &files[i]
		}
	}
	return nil
}

func packageRelativeFile(files []PackageFile, rel string) *PackageFile {
	if !strings.HasPrefix(rel, "./") || hasParentSegment(rel) {
		return nil
	}
	return findPackageFile(files, strings.TrimPrefix(rel, "./"))
}

// readPluginPackage 读取并校验原生插件包（package.json + agentPlugin + semver）。
func readPluginPackage(source string) (PluginPackage, error) {
	root, err := filepath.Abs(source)
	if err != nil {
		return PluginPackage{}, fail("skill_source_missing")
	}
	files, err := readTreeFiles(root, "skill_source")
	if err != nil {
		return PluginPackage{}, err
	}
	pkgFile := findPackageFile(files, "package.json")
	if pkgFile == nil {
		return PluginPackage{}, fail("native_plugin_package_invalid")
	}
	var pkgJSON map[string]any
	if err := json.Unmarshal(pkgFile.Content, &pkgJSON); err != nil || pkgJSON == nil {
		return PluginPackage{}, fail("native_plugin_package_invalid")
	}
	ap, ok := pkgJSON["agentPlugin"].(map[string]any)
	if !ok {
		return PluginPackage{}, fail("native_plugin_id_invalid")
	}
	id, _ := ap["pluginId"].(string)
	if !resourceIDPattern.MatchString(id) {
		return PluginPackage{}, fail("native_plugin_id_invalid")
	}
	mv, ok := numberAsInt(ap["manifestVersion"])
	if !ok || mv != 1 {
		return PluginPackage{}, fail("native_plugin_manifest_invalid")
	}
	ver, _ := pkgJSON["version"].(string)
	if !isCanonicalSemver(ver) {
		return PluginPackage{}, fail("native_plugin_version_invalid")
	}
	return PluginPackage{
		Root:        root,
		ID:          id,
		Version:     ver,
		PackageJSON: pkgJSON,
		Files:       files,
		Digest:      digestFiles(files),
	}, nil
}

func numberAsInt(v any) (int, bool) {
	switch tv := v.(type) {
	case int:
		return tv, true
	case int64:
		return int(tv), true
	case float64:
		if float64(int(tv)) == tv {
			return int(tv), true
		}
	}
	return 0, false
}

func directoryStatus(target, digest string) string {
	info, err := lstatMaybe(target)
	if err != nil {
		return "modified"
	}
	if info == nil {
		return "absent"
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "modified"
	}
	files, err := readTreeFiles(target, "skill_source")
	if err != nil {
		return "modified"
	}
	if digestFiles(files) == digest {
		return "present"
	}
	return "modified"
}

func copyPluginPackage(pkg PluginPackage, target string) error {
	info, err := lstatMaybe(target)
	if err != nil {
		return err
	}
	if info != nil {
		return fail("native_plugin_target_conflict")
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	tmpDir := fmt.Sprintf("%s.%s.tmp", target, randomSuffix())
	defer func() { _ = os.RemoveAll(tmpDir) }()
	if err := writePackageFiles(tmpDir, pkg.Files); err != nil {
		return err
	}
	return os.Rename(tmpDir, target)
}

func copyPluginFiles(files []PackageFile, target string) error {
	info, err := lstatMaybe(target)
	if err != nil {
		return err
	}
	if info != nil {
		return fail("native_plugin_target_conflict")
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	tmpDir := fmt.Sprintf("%s.%s.tmp", target, randomSuffix())
	defer func() { _ = os.RemoveAll(tmpDir) }()
	if err := writePackageFiles(tmpDir, files); err != nil {
		return err
	}
	return os.Rename(tmpDir, target)
}

func removeOwnedDir(target, digest string) error {
	status := directoryStatus(target, digest)
	if status == "modified" {
		return fail("native_plugin_target_modified")
	}
	if status == "present" {
		return os.RemoveAll(target)
	}
	return nil
}

func ensureOwnedDir(pkg PluginPackage, target, digest string, previous *ManagedRecord) error {
	status := directoryStatus(target, digest)
	if status != "absent" {
		if previous == nil {
			return fail("native_plugin_target_conflict")
		}
		if directoryStatus(previous.Target, previous.Digest) != "present" {
			return fail("native_plugin_target_modified")
		}
		if previous.Digest != digest {
			return fail("native_plugin_version_conflict")
		}
		return nil
	}
	return copyPluginPackage(pkg, target)
}

func snapshotPluginPackage(root string, pkg PluginPackage) (string, error) {
	target := filepath.Join(root, pkg.ID, pkg.Version)
	info, err := lstatMaybe(target)
	if err != nil {
		return "", err
	}
	if info != nil {
		existing, readErr := readPluginPackage(target)
		if readErr != nil || existing.Digest != pkg.Digest {
			return "", fail("native_plugin_version_conflict")
		}
		return target, nil
	}
	if err := copyPluginPackage(pkg, target); err != nil {
		return "", err
	}
	return target, nil
}

func verifyPluginSnapshot(target string, rec ManagedRecord) (PluginPackage, error) {
	pkg, err := readPluginPackage(target)
	if err != nil || pkg.Digest != rec.Digest || pkg.ID != rec.ID || pkg.Version != rec.Version {
		return PluginPackage{}, fail("native_plugin_snapshot_modified")
	}
	return pkg, nil
}

// --- Cordis Patch 投影 ---

func readCordisPatchEntry(pkg PluginPackage, exportKey string) (map[string]any, string, error) {
	dshMap, _ := pkg.PackageJSON["dsh"].(map[string]any)
	bundleMap, _ := dshMap["bundle"].(map[string]any)
	patchRel, _ := bundleMap["patch"].(string)
	patchFile := packageRelativeFile(pkg.Files, patchRel)
	if patchFile == nil {
		return nil, "", fail("native_plugin_patch_missing")
	}
	parsed, err := providerconfigs.ParseYAML(string(patchFile.Content))
	if err != nil {
		return nil, "", fail("native_plugin_patch_invalid")
	}
	rows, ok := parsed.([]any)
	if !ok || len(rows) != 1 {
		return nil, "", fail("native_plugin_patch_unsupported")
	}
	firstRow, ok := rows[0].(map[string]any)
	if !ok || len(firstRow) != 1 {
		return nil, "", fail("native_plugin_patch_unsupported")
	}
	inserts, ok := firstRow["insert"].([]any)
	if !ok || len(inserts) != 1 {
		return nil, "", fail("native_plugin_patch_unsupported")
	}
	entry, ok := inserts[0].(map[string]any)
	if !ok {
		return nil, "", fail("native_plugin_patch_unsupported")
	}
	pkgName, _ := pkg.PackageJSON["name"].(string)
	expectedName := pkgName + strings.TrimPrefix(exportKey, ".")
	if entry["name"] != expectedName {
		return nil, "", fail("native_plugin_patch_unsupported")
	}
	for k := range entry {
		switch k {
		case "id", "name", "config", "disabled":
		default:
			return nil, "", fail("native_plugin_patch_unsupported")
		}
	}
	if d, hasDisabled := entry["disabled"]; hasDisabled && d != nil {
		db, ok := d.(bool)
		if !ok || db {
			return nil, "", fail("native_plugin_patch_unsupported")
		}
	}
	exportsMap, _ := pkg.PackageJSON["exports"].(map[string]any)
	exportedFile, _ := exportsMap[exportKey].(string)
	if packageRelativeFile(pkg.Files, exportedFile) == nil {
		return nil, "", fail("native_plugin_host_projection_invalid")
	}
	return entry, exportedFile, nil
}

func projectCordisPatch(pkg PluginPackage, target, exportKey string) (string, error) {
	entry, exportedFile, err := readCordisPatchEntry(pkg, exportKey)
	if err != nil {
		return "", err
	}
	cloned := make(map[string]any, len(entry))
	for k, v := range entry {
		cloned[k] = v
	}
	resolved := filepath.Join(target, filepath.FromSlash(strings.TrimPrefix(exportedFile, "./")))
	cloned["name"] = (&url.URL{Scheme: "file", Path: filepath.ToSlash(resolved)}).String()
	doc := []any{
		map[string]any{
			"insert": []any{cloned},
		},
	}
	return providerconfigs.StringifyYAML(doc), nil
}

// --- Portable Plugin 一致性检查 ---

type portableHostReport struct {
	State  string
	Entry  string
	Reason string
}

type portablePluginSpec struct {
	ExportKey string
	Engine    string
	Validate  func(pkg PluginPackage, entry string) string
}

var portablePluginSpecs = map[string]portablePluginSpec{
	"deepseek": {ExportKey: "./deepseek", Engine: "deepseek", Validate: func(pkg PluginPackage, _ string) string {
		if _, _, err := readCordisPatchEntry(pkg, "./deepseek"); err != nil {
			return err.Error()
		}
		return ""
	}},
	"opencode": {ExportKey: "./opencode/server", Engine: "opencode", Validate: func(pkg PluginPackage, entry string) string {
		exportsMap, _ := pkg.PackageJSON["exports"].(map[string]any)
		nativeEntry, _ := exportsMap["./server"].(string)
		if nativeEntry == "" {
			nativeEntry, _ = pkg.PackageJSON["main"].(string)
		}
		if nativeEntry != entry {
			return "opencode.server_entry_mismatch"
		}
		return ""
	}},
	"pi": {ExportKey: "./pi", Engine: "pi", Validate: func(pkg PluginPackage, entry string) string {
		piMap, _ := pkg.PackageJSON["pi"].(map[string]any)
		extRaw, ok := piMap["extensions"].([]any)
		if !ok {
			return "pi.extensions_entry_mismatch"
		}
		found := false
		for _, item := range extRaw {
			s, ok := item.(string)
			if !ok || packageRelativeFile(pkg.Files, s) == nil {
				return "pi.extensions_entry_mismatch"
			}
			if s == entry {
				found = true
			}
		}
		if !found {
			return "pi.extensions_entry_mismatch"
		}
		return ""
	}},
	"aih": {ExportKey: "./aih", Engine: "aih", Validate: validatePortableAih},
}

func validatePortableAih(pkg PluginPackage, _ string) string {
	if findPackageFile(pkg.Files, "plugin.json") != nil {
		return "plugin_manifest_source_conflict"
	}
	ap, _ := pkg.PackageJSON["agentPlugin"].(map[string]any)
	mv, _ := numberAsInt(ap["manifestVersion"])
	pv, _ := numberAsInt(ap["portableApiVersion"])
	if mv != 1 || pv != 1 {
		return "plugin_portable_api_incompatible"
	}
	hostsMap, _ := ap["hosts"].(map[string]any)
	aihHost, ok := hostsMap["aih"].(map[string]any)
	if !ok {
		return "plugin_adapter_incompatible"
	}
	hav, _ := numberAsInt(aihHost["hostAdapterApiVersion"])
	tpv, _ := numberAsInt(aihHost["transportProtocolVersion"])
	if hav != 1 || tpv != 2 {
		return "plugin_adapter_incompatible"
	}
	for k := range aihHost {
		switch k {
		case "hostAdapterApiVersion", "transportProtocolVersion", "contributes":
		default:
			return "plugin_adapter_projection_unsupported"
		}
	}
	capsRaw, ok := ap["capabilities"].([]any)
	if !ok {
		return "plugin_portable_capabilities_invalid"
	}
	seen := make(map[string]bool)
	hasLifecycle := false
	hasToolReg := false
	for _, raw := range capsRaw {
		c, ok := raw.(map[string]any)
		if !ok {
			return "plugin_portable_capabilities_invalid"
		}
		cid, okID := c["id"].(string)
		ver, okVer := numberAsInt(c["version"])
		req, okReq := c["required"].(bool)
		if !okID || !okVer || !okReq {
			return "plugin_portable_capabilities_invalid"
		}
		if req && ((cid != "lifecycle" && cid != "tool.register") || ver != 1) {
			return "plugin_capability_incompatible"
		}
		if seen[cid] {
			return "plugin_capability_duplicate"
		}
		seen[cid] = true
		if cid == "lifecycle" && ver == 1 {
			hasLifecycle = true
		}
		if cid == "tool.register" && ver == 1 {
			hasToolReg = true
		}
	}
	if !hasLifecycle || !hasToolReg {
		return "plugin_capability_missing"
	}
	exportsMap, _ := pkg.PackageJSON["exports"].(map[string]any)
	exported, _ := exportsMap["./aih"].(string)
	if packageRelativeFile(pkg.Files, exported) == nil {
		return "plugin_entry_missing"
	}
	contribs, ok := aihHost["contributes"].([]any)
	if !ok || len(contribs) == 0 {
		return "plugin_adapter_projection_unsupported"
	}
	contribIDs := make(map[string]bool)
	for _, raw := range contribs {
		c, ok := raw.(map[string]any)
		if !ok {
			return "plugin_adapter_projection_unsupported"
		}
		capName, _ := c["capability"].(string)
		ver, okVer := numberAsInt(c["version"])
		if capName != "command" || !okVer || ver != 1 {
			return "plugin_adapter_projection_unsupported"
		}
		cid, _ := c["id"].(string)
		if !contribIDRe.MatchString(cid) {
			return "plugin_manifest_invalid"
		}
		if contribIDs[cid] {
			return "plugin_contribution_duplicate"
		}
		contribIDs[cid] = true
	}
	perms, ok := ap["permissions"].(map[string]any)
	if !ok {
		return "plugin_permissions_invalid"
	}
	for k := range perms {
		if k != "network" && k != "filesystem" && k != "secrets" {
			return "plugin_permissions_invalid"
		}
	}
	nets, okN := perms["network"].([]any)
	fss, okF := perms["filesystem"].([]any)
	secs, okS := perms["secrets"].([]any)
	if !okN || !okF || !okS {
		return "plugin_permissions_invalid"
	}
	for _, n := range nets {
		ns, ok := n.(string)
		u, err := url.Parse(ns)
		if !ok || err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
			return "plugin_permission_network_invalid"
		}
	}
	for _, f := range fss {
		fsVal, ok := f.(string)
		if !ok || fsVal != "private-state" {
			return "plugin_permission_filesystem_invalid"
		}
	}
	for _, s := range secs {
		ss, ok := s.(string)
		if !ok || !secretNameRe.MatchString(ss) {
			return "plugin_manifest_invalid"
		}
	}
	return ""
}

func inspectPortablePlugin(pkg PluginPackage) map[string]portableHostReport {
	out := make(map[string]portableHostReport, len(portablePluginSpecs))
	ap, _ := pkg.PackageJSON["agentPlugin"].(map[string]any)
	enginesMap, _ := ap["engines"].(map[string]any)
	exportsMap, _ := pkg.PackageJSON["exports"].(map[string]any)

	for host, spec := range portablePluginSpecs {
		entry, _ := exportsMap[spec.ExportKey].(string)
		engine := enginesMap[spec.Engine]
		state := "projection-ready"
		reason := ""
		if engine == nil || engine == "" || engine == false {
			state = "engine-missing"
			reason = "agentPlugin.engines." + spec.Engine
		} else if !strings.HasPrefix(entry, "./") || strings.Contains(entry, "..") {
			state = "projection-missing"
			reason = "exports." + spec.ExportKey
		} else if packageRelativeFile(pkg.Files, entry) == nil {
			state = "projection-missing"
			reason = "entry_file_missing:" + entry
		}
		if state == "projection-ready" && spec.Validate != nil {
			if mismatch := spec.Validate(pkg, entry); mismatch != "" {
				state = "projection-invalid"
				reason = mismatch
			}
		}
		out[host] = portableHostReport{State: state, Entry: entry, Reason: reason}
	}
	return out
}

// --- 原生插件适配器实现 ---

type pluginAdapterContext struct {
	provider    string
	host        string
	capability  ResourceCapability
	aiHomeDir   string
	hostHomeDir string
	binary      string
	catalog     *providers.Catalog
	env         map[string]string
	runner      CommandRunner
}

type pluginAdapter interface {
	target(ctx pluginAdapterContext, id, version string) (string, error)
	validate(pkg PluginPackage) error
	install(ctx pluginAdapterContext, pkg PluginPackage, rec *ManagedRecord, prev *ManagedRecord) (map[string]any, error)
	disable(ctx pluginAdapterContext, pkg PluginPackage, rec *ManagedRecord) error
	remove(ctx pluginAdapterContext, pkg PluginPackage, rec *ManagedRecord) error
	inspect(ctx pluginAdapterContext, rec ManagedRecord) string
	hasReplace() bool
	replace(ctx pluginAdapterContext, pkg PluginPackage, rec *ManagedRecord, prev *ManagedRecord) (map[string]any, error)
}

// directoryAdapter 实现 native-directory 与 claude-skills-dir 基础目录映射。
type directoryPluginAdapter struct {
	skillsSubdir bool
}

func (a directoryPluginAdapter) target(ctx pluginAdapterContext, id, _ string) (string, error) {
	if a.skillsSubdir {
		root := resolveProviderNativeRoot(ctx.hostHomeDir, ctx.provider)
		if root == "" {
			return "", fail("native_plugin_path_invalid")
		}
		return filepath.Join(root, "skills", id), nil
	}
	root := resolveProjectionRoot(ctx.hostHomeDir, ctx.provider, ctx.capability.PathBase)
	var rel string
	if len(ctx.capability.Paths) > 0 {
		rel = ctx.capability.Paths[0]
	}
	if root == "" || rel == "" || filepath.IsAbs(rel) || hasParentSegment(rel) {
		return "", fail("native_plugin_path_invalid")
	}
	return filepath.Join(root, filepath.FromSlash(rel), id), nil
}

func (directoryPluginAdapter) validate(_ PluginPackage) error { return nil }
func (directoryPluginAdapter) hasReplace() bool             { return false }
func (directoryPluginAdapter) replace(_ pluginAdapterContext, _ PluginPackage, _ *ManagedRecord, _ *ManagedRecord) (map[string]any, error) {
	return nil, nil
}

func (directoryPluginAdapter) install(_ pluginAdapterContext, pkg PluginPackage, rec *ManagedRecord, prev *ManagedRecord) (map[string]any, error) {
	if err := ensureOwnedDir(pkg, rec.Target, rec.Digest, prev); err != nil {
		return nil, err
	}
	return map[string]any{"status": "projected"}, nil
}

func (directoryPluginAdapter) disable(_ pluginAdapterContext, _ PluginPackage, rec *ManagedRecord) error {
	return removeOwnedDir(rec.Target, rec.Digest)
}

func (directoryPluginAdapter) remove(ctx pluginAdapterContext, pkg PluginPackage, rec *ManagedRecord) error {
	return removeOwnedDir(rec.Target, rec.Digest)
}

func (directoryPluginAdapter) inspect(_ pluginAdapterContext, rec ManagedRecord) string {
	return directoryStatus(rec.Target, rec.Digest)
}

// geminiExtensionAdapter 验证 gemini-extension.json。
type geminiExtensionAdapter struct {
	directoryPluginAdapter
}

func (geminiExtensionAdapter) validate(pkg PluginPackage) error {
	f := findPackageFile(pkg.Files, "gemini-extension.json")
	if f == nil {
		return fail("native_plugin_manifest_invalid")
	}
	var manifest map[string]any
	if err := json.Unmarshal(f.Content, &manifest); err != nil || manifest == nil {
		return fail("native_plugin_manifest_invalid")
	}
	if manifest["name"] != pkg.ID || manifest["version"] != pkg.Version {
		return fail("native_plugin_manifest_mismatch")
	}
	return nil
}

func (a geminiExtensionAdapter) hasReplace() bool { return true }

func (a geminiExtensionAdapter) install(ctx pluginAdapterContext, pkg PluginPackage, rec *ManagedRecord, prev *ManagedRecord) (map[string]any, error) {
	if err := a.validate(pkg); err != nil {
		return nil, err
	}
	return a.directoryPluginAdapter.install(ctx, pkg, rec, prev)
}

func (a geminiExtensionAdapter) replace(ctx pluginAdapterContext, pkg PluginPackage, rec *ManagedRecord, prev *ManagedRecord) (map[string]any, error) {
	if err := a.validate(pkg); err != nil {
		return nil, err
	}
	if err := a.directoryPluginAdapter.disable(ctx, pkg, prev); err != nil {
		return nil, err
	}
	return a.directoryPluginAdapter.install(ctx, pkg, rec, nil)
}

// opencodeAdapter 管理 ~/.config/opencode/plugins 与 opencode.json[c]。
type opencodePluginAdapter struct{}

func (opencodePluginAdapter) target(ctx pluginAdapterContext, id, _ string) (string, error) {
	return filepath.Join(ctx.hostHomeDir, ".config", "opencode", "plugins", id), nil
}

func (opencodePluginAdapter) validate(_ PluginPackage) error { return nil }
func (opencodePluginAdapter) hasReplace() bool             { return false }
func (opencodePluginAdapter) replace(_ pluginAdapterContext, _ PluginPackage, _ *ManagedRecord, _ *ManagedRecord) (map[string]any, error) {
	return nil, nil
}

type opencodeConfigState struct {
	file   string
	doc    map[string]any
	values []string
}

func readOpencodeConfig(ctx pluginAdapterContext, rec *ManagedRecord) (*opencodeConfigState, error) {
	root := filepath.Join(ctx.hostHomeDir, ".config", "opencode")
	file := ""
	if rec != nil && rec.ConfigFile != "" {
		file = rec.ConfigFile
	} else {
		for _, cand := range []string{filepath.Join(root, "opencode.jsonc"), filepath.Join(root, "opencode.json")} {
			info, _ := lstatMaybe(cand)
			if info != nil {
				file = cand
				break
			}
		}
		if file == "" {
			file = filepath.Join(root, "opencode.json")
		}
	}
	info, err := lstatMaybe(file)
	if err != nil {
		return nil, err
	}
	if info != nil && (!info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 4*1024*1024) {
		return nil, fail("native_plugin_config_conflict")
	}
	text := "{}"
	if info != nil {
		raw, readErr := os.ReadFile(file)
		if readErr != nil {
			return nil, fail("native_plugin_config_invalid")
		}
		text = string(raw)
	}
	cleaned := stripJSONCommentsAndTrailingCommas(text)
	var doc map[string]any
	if err := json.Unmarshal([]byte(cleaned), &doc); err != nil || doc == nil {
		return nil, fail("native_plugin_config_invalid")
	}
	var values []string
	if rawPlugin, ok := doc["plugin"]; ok && rawPlugin != nil {
		slice, ok := rawPlugin.([]any)
		if !ok {
			return nil, fail("native_plugin_config_invalid")
		}
		for _, item := range slice {
			s, ok := item.(string)
			if !ok {
				return nil, fail("native_plugin_config_invalid")
			}
			values = append(values, s)
		}
	}
	return &opencodeConfigState{file: file, doc: doc, values: values}, nil
}

func writeOpencodeConfig(cfg *opencodeConfigState, values []string) error {
	if slicesEqual(cfg.values, values) {
		return nil
	}
	cfg.doc["plugin"] = values
	raw, err := json.MarshalIndent(cfg.doc, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteFile(cfg.file, append(raw, '\n'), 0o600)
}

func slicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func containsString(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

func (opencodePluginAdapter) install(ctx pluginAdapterContext, pkg PluginPackage, rec *ManagedRecord, prev *ManagedRecord) (map[string]any, error) {
	cfg, err := readOpencodeConfig(ctx, prev)
	if err != nil {
		return nil, err
	}
	if prev == nil && containsString(cfg.values, rec.Target) {
		return nil, fail("native_plugin_target_conflict")
	}
	if err := ensureOwnedDir(pkg, rec.Target, rec.Digest, prev); err != nil {
		return nil, err
	}
	if !containsString(cfg.values, rec.Target) {
		nextVals := append(append([]string{}, cfg.values...), rec.Target)
		if err := writeOpencodeConfig(cfg, nextVals); err != nil {
			return nil, err
		}
	}
	rec.ConfigFile = cfg.file
	return map[string]any{"status": "projected"}, nil
}

func (opencodePluginAdapter) disable(ctx pluginAdapterContext, _ PluginPackage, rec *ManagedRecord) error {
	cfg, err := readOpencodeConfig(ctx, rec)
	if err != nil {
		return err
	}
	if directoryStatus(rec.Target, rec.Digest) == "modified" {
		return fail("native_plugin_target_modified")
	}
	next := make([]string, 0, len(cfg.values))
	for _, v := range cfg.values {
		if v != rec.Target {
			next = append(next, v)
		}
	}
	if err := writeOpencodeConfig(cfg, next); err != nil {
		return err
	}
	return removeOwnedDir(rec.Target, rec.Digest)
}

func (a opencodePluginAdapter) remove(ctx pluginAdapterContext, pkg PluginPackage, rec *ManagedRecord) error {
	return a.disable(ctx, pkg, rec)
}

func (opencodePluginAdapter) inspect(ctx pluginAdapterContext, rec ManagedRecord) string {
	cfg, err := readOpencodeConfig(ctx, &rec)
	if err != nil {
		return "modified"
	}
	status := directoryStatus(rec.Target, rec.Digest)
	configured := containsString(cfg.values, rec.Target)
	if status == "present" && configured {
		return "present"
	}
	if status == "absent" && !configured {
		return "absent"
	}
	return "modified"
}

// cordisPatchAdapter 管理 DeepSeek Harness 的插件目录与 .yml patch 投影。
type cordisPatchAdapter struct {
	directoryPluginAdapter
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func cordisPatchFilePath(ctx pluginAdapterContext, id string) string {
	return filepath.Join(ctx.aiHomeDir, "managed-resources", "native-plugin-patches", ctx.host, id+".yml")
}

func cordisPatchStatus(rec *ManagedRecord) string {
	if rec == nil || rec.NativeInstall == nil {
		return "absent"
	}
	launchPath, _ := rec.NativeInstall["launchPath"].(string)
	patchDigest, _ := rec.NativeInstall["patchDigest"].(string)
	if launchPath == "" {
		return "absent"
	}
	info, err := lstatMaybe(launchPath)
	if err != nil {
		return "modified"
	}
	if info == nil {
		return "absent"
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 65536 {
		return "modified"
	}
	data, err := os.ReadFile(launchPath)
	if err != nil {
		return "modified"
	}
	if sha256Hex(data) == patchDigest {
		return "present"
	}
	return "modified"
}

func (cordisPatchAdapter) validate(_ PluginPackage) error { return nil }
func (cordisPatchAdapter) hasReplace() bool             { return false }

func (cordisPatchAdapter) install(ctx pluginAdapterContext, pkg PluginPackage, rec *ManagedRecord, prev *ManagedRecord) (map[string]any, error) {
	file := cordisPatchFilePath(ctx, pkg.ID)
	info, err := lstatMaybe(file)
	if err != nil {
		return nil, err
	}
	if info != nil {
		if prev == nil {
			return nil, fail("native_plugin_target_conflict")
		}
		prevPath, _ := prev.NativeInstall["launchPath"].(string)
		if prevPath != file {
			return nil, fail("native_plugin_target_conflict")
		}
		if cordisPatchStatus(prev) != "present" {
			return nil, fail("native_plugin_target_modified")
		}
	}
	exportsMap, _ := pkg.PackageJSON["exports"].(map[string]any)
	entry, _ := exportsMap[ctx.capability.EntryExport].(string)
	text, err := projectCordisPatch(pkg, rec.Target, ctx.capability.EntryExport)
	if err != nil {
		return nil, err
	}
	if err := ensureOwnedDir(pkg, rec.Target, rec.Digest, prev); err != nil {
		return nil, err
	}
	if err := atomicWriteFile(file, []byte(text), 0o600); err != nil {
		return nil, err
	}
	return map[string]any{
		"status":      "projected",
		"launchPath":  file,
		"patchDigest": sha256Hex([]byte(text)),
		"entry":       entry,
	}, nil
}

func (cordisPatchAdapter) disable(_ pluginAdapterContext, _ PluginPackage, rec *ManagedRecord) error {
	projected := directoryStatus(rec.Target, rec.Digest)
	patch := cordisPatchStatus(rec)
	if projected == "modified" || patch == "modified" {
		return fail("native_plugin_target_modified")
	}
	if patch == "present" {
		if launchPath, _ := rec.NativeInstall["launchPath"].(string); launchPath != "" {
			if err := os.Remove(launchPath); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
	}
	return removeOwnedDir(rec.Target, rec.Digest)
}

func (a cordisPatchAdapter) remove(ctx pluginAdapterContext, pkg PluginPackage, rec *ManagedRecord) error {
	return a.disable(ctx, pkg, rec)
}

func (cordisPatchAdapter) inspect(_ pluginAdapterContext, rec ManagedRecord) string {
	projected := directoryStatus(rec.Target, rec.Digest)
	patch := cordisPatchStatus(&rec)
	if projected == patch {
		return projected
	}
	return "modified"
}

// --- Native Marketplace 适配器 (Claude / WorkBuddy) ---

type nativeMarketplaceAdapter struct{}

func safeMarketplacePath(base, target string) (string, error) {
	absBase, err := filepath.Abs(base)
	if err != nil {
		return "", fail("native_plugin_path_invalid")
	}
	absTarget, err := filepath.Abs(target)
	if err != nil {
		return "", fail("native_plugin_path_invalid")
	}
	rel, err := filepath.Rel(absBase, absTarget)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", fail("native_plugin_path_invalid")
	}
	current := absBase
	if info, _ := lstatMaybe(current); info != nil && info.Mode()&os.ModeSymlink != 0 {
		return "", fail("native_plugin_path_symlink")
	}
	if rel != "." {
		for _, seg := range strings.Split(rel, string(filepath.Separator)) {
			if seg == "" || seg == "." {
				continue
			}
			current = filepath.Join(current, seg)
			if info, _ := lstatMaybe(current); info != nil && info.Mode()&os.ModeSymlink != 0 {
				return "", fail("native_plugin_path_symlink")
			}
		}
	}
	return absTarget, nil
}

func marketplaceNameFor(ctx pluginAdapterContext, id string) string {
	absAIHome, _ := filepath.Abs(ctx.aiHomeDir)
	payload, _ := json.Marshal([]string{absAIHome, ctx.provider, id})
	return "aih-" + sha256Hex(payload)[:24]
}

type marketplaceBundle struct {
	target string
	files  []PackageFile
	digest string
	name   string
}

func buildOwnedMarketplace(ctx pluginAdapterContext, pkg PluginPackage) (*marketplaceBundle, error) {
	target, err := safeMarketplacePath(ctx.aiHomeDir, filepath.Join(ctx.aiHomeDir, "managed-resources", "native-plugin-marketplaces", ctx.provider, pkg.ID))
	if err != nil {
		return nil, err
	}
	desc, _ := pkg.PackageJSON["description"].(string)
	mName := marketplaceNameFor(ctx, pkg.ID)
	manifest := map[string]any{
		"name":  mName,
		"owner": map[string]any{"name": "AIH"},
		"plugins": []map[string]any{
			{
				"name":        pkg.ID,
				"source":      "./plugins/" + pkg.ID,
				"description": desc,
			},
		},
	}
	manifestBytes, _ := json.MarshalIndent(manifest, "", "  ")
	manifestBytes = append(manifestBytes, '\n')
	files := make([]PackageFile, 0, len(pkg.Files)+1)
	files = append(files, PackageFile{
		Name:       ".claude-plugin/marketplace.json",
		Content:    manifestBytes,
		Executable: false,
	})
	for _, f := range pkg.Files {
		files = append(files, PackageFile{
			Name:       "plugins/" + pkg.ID + "/" + f.Name,
			Content:    f.Content,
			Executable: f.Executable,
		})
	}
	return &marketplaceBundle{
		target: target,
		files:  files,
		digest: digestFiles(files),
		name:   mName,
	}, nil
}

func readRegistryJSON(ctx pluginAdapterContext, rel string) (map[string]any, error) {
	root := resolveProviderNativeRoot(ctx.hostHomeDir, ctx.provider)
	file, err := safeMarketplacePath(ctx.hostHomeDir, filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		return nil, err
	}
	info, err := lstatMaybe(file)
	if err != nil {
		return nil, err
	}
	if info == nil {
		return nil, nil
	}
	if !info.Mode().IsRegular() || info.Size() > 1024*1024 {
		return nil, fail("native_plugin_registry_invalid")
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return nil, fail("native_plugin_registry_invalid")
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil || doc == nil {
		return nil, fail("native_plugin_registry_invalid")
	}
	return doc, nil
}

func validateNativeMarketplaceState(ctx pluginAdapterContext) error {
	installed, err := readRegistryJSON(ctx, "plugins/installed_plugins.json")
	if err != nil {
		return err
	}
	if installed != nil {
		ver, ok := numberAsInt(installed["version"])
		pluginsMap, okMap := installed["plugins"].(map[string]any)
		if !ok || ver != 2 || !okMap {
			return fail("native_plugin_registry_invalid")
		}
		for _, entriesRaw := range pluginsMap {
			entries, ok := entriesRaw.([]any)
			if !ok {
				return fail("native_plugin_registry_invalid")
			}
			for _, item := range entries {
				row, ok := item.(map[string]any)
				if !ok {
					return fail("native_plugin_registry_invalid")
				}
				scope, _ := row["scope"].(string)
				ip, _ := row["installPath"].(string)
				_, okVer := row["version"].(string)
				if (scope != "user" && scope != "project" && scope != "local") || ip == "" || !filepath.IsAbs(ip) || !okVer {
					return fail("native_plugin_registry_invalid")
				}
			}
		}
	}
	settings, err := readRegistryJSON(ctx, "settings.json")
	if err != nil {
		return err
	}
	if settings != nil {
		if rawEP, has := settings["enabledPlugins"]; has {
			ep, ok := rawEP.(map[string]any)
			if !ok {
				return fail("native_plugin_registry_invalid")
			}
			for _, v := range ep {
				if _, ok := v.(bool); !ok {
					return fail("native_plugin_registry_invalid")
				}
			}
		}
	}
	if _, err := readRegistryJSON(ctx, "plugins/known_marketplaces.json"); err != nil {
		return err
	}
	return nil
}

func knownMarketplaceRow(ctx pluginAdapterContext, marketName string) (map[string]any, error) {
	doc, err := readRegistryJSON(ctx, "plugins/known_marketplaces.json")
	if err != nil || doc == nil {
		return nil, err
	}
	raw, exists := doc[marketName]
	if !exists {
		return nil, nil
	}
	row, ok := raw.(map[string]any)
	if !ok {
		return nil, fail("native_plugin_registry_invalid")
	}
	return row, nil
}

func verifyOwnedMarketplace(ctx pluginAdapterContext, pkg PluginPackage, allowMissing bool) (*marketplaceBundle, map[string]any, error) {
	owned, err := buildOwnedMarketplace(ctx, pkg)
	if err != nil {
		return nil, nil, err
	}
	row, err := knownMarketplaceRow(ctx, owned.name)
	if err != nil {
		return nil, nil, err
	}
	if row != nil {
		src, _ := row["source"].(map[string]any)
		srcPath, _ := src["path"].(string)
		installLoc, _ := row["installLocation"].(string)
		if row["type"] != "directory" || src["source"] != "directory" || srcPath == "" || installLoc == "" {
			return nil, nil, fail("native_plugin_marketplace_conflict")
		}
		absOwned := canonicalPath(owned.target)
		absSrc := canonicalPath(srcPath)
		absInstall := canonicalPath(installLoc)
		if absSrc != absOwned || absInstall != absOwned {
			return nil, nil, fail("native_plugin_marketplace_conflict")
		}
	}
	status := directoryStatus(owned.target, owned.digest)
	if status != "present" && !(allowMissing && status == "absent" && row == nil) {
		return nil, nil, fail("native_plugin_marketplace_modified")
	}
	return owned, row, nil
}

func buildProviderCommandEnv(ctx pluginAdapterContext, runtimeEnv map[string]string) map[string]string {
	env := copyEnvMap(ctx.env)
	for k, v := range runtimeEnv {
		env[k] = v
	}
	env["HOME"] = ctx.hostHomeDir
	env["USERPROFILE"] = ctx.hostHomeDir
	root := resolveProviderNativeRoot(ctx.hostHomeDir, ctx.provider)
	if ctx.catalog != nil {
		if def, ok := ctx.catalog.Get(ctx.provider); ok {
			if def.NativeBoundary != nil {
				for _, key := range def.NativeBoundary.Config.EnvHomeKeys {
					env[key] = root
				}
			}
			if def.CLI != nil && def.CLI.DesktopClient != nil && def.CLI.DesktopClient.UserDataEnvKey != "" {
				env[def.CLI.DesktopClient.UserDataEnvKey] = filepath.Join(root, "electron-user-data")
			}
		}
	}
	return env
}

func (nativeMarketplaceAdapter) runCommand(ctx pluginAdapterContext, args []string) (string, error) {
	if err := validateNativeMarketplaceState(ctx); err != nil {
		return "", err
	}
	nodeBin := ""
	if ctx.runner != nil {
		nodeBin = ctx.runner.FindNode()
	}
	spec := resolveProviderRuntime(ctx.catalog, ctx.provider, ctx.hostHomeDir, ctx.env, nodeBin)
	if spec == nil {
		return "", fail("native_plugin_runtime_unavailable")
	}
	env := buildProviderCommandEnv(ctx, spec.Env)
	fullArgs := append(append([]string(nil), spec.Args...), args...)
	res := ctx.runner.Run(context.Background(), spec.Command, fullArgs, ctx.hostHomeDir, env, 30*time.Second)
	if res.ExitCode != 0 {
		return "", fail("native_plugin_command_failed")
	}
	return res.Stdout, nil
}

type nativeInstalledRow struct {
	id          string
	installPath string
	enabled     bool
	scope       string
}

func (a nativeMarketplaceAdapter) installed(ctx pluginAdapterContext, id string) (*nativeInstalledRow, error) {
	out, err := a.runCommand(ctx, []string{"plugin", "list", "--json"})
	if err != nil {
		return nil, err
	}
	var rows []map[string]any
	if err := json.Unmarshal([]byte(out), &rows); err != nil || rows == nil {
		return nil, fail("native_plugin_response_invalid")
	}
	targetID := id + "@" + marketplaceNameFor(ctx, id)
	var matches []nativeInstalledRow
	for _, r := range rows {
		rid, ok1 := r["id"].(string)
		ip, ok2 := r["installPath"].(string)
		en, ok3 := r["enabled"].(bool)
		if !ok1 || !ok2 || !ok3 {
			return nil, fail("native_plugin_response_invalid")
		}
		sc, _ := r["scope"].(string)
		if rid == targetID {
			if sc != "user" {
				return nil, fail("native_plugin_scope_conflict")
			}
			matches = append(matches, nativeInstalledRow{id: rid, installPath: ip, enabled: en, scope: sc})
		}
	}
	if len(matches) > 1 {
		return nil, fail("native_plugin_scope_conflict")
	}
	if len(matches) == 0 {
		return nil, nil
	}
	return &matches[0], nil
}

func (nativeMarketplaceAdapter) target(ctx pluginAdapterContext, id, version string) (string, error) {
	v := version
	if v == "" {
		v = "current"
	}
	root := resolveProviderNativeRoot(ctx.hostHomeDir, ctx.provider)
	return safeMarketplacePath(ctx.hostHomeDir, filepath.Join(root, "plugins", "cache", marketplaceNameFor(ctx, id), id, v))
}

func (nativeMarketplaceAdapter) isLegacy(ctx pluginAdapterContext, rec ManagedRecord) bool {
	status, _ := rec.NativeInstall["status"].(string)
	if status != "projected" {
		return false
	}
	absTarget, _ := filepath.Abs(rec.Target)
	expected := filepath.Join(resolveProviderNativeRoot(ctx.hostHomeDir, ctx.provider), "plugins", rec.ID)
	absExpected, _ := filepath.Abs(expected)
	return absTarget == absExpected
}

func (nativeMarketplaceAdapter) validate(pkg PluginPackage) error {
	f := findPackageFile(pkg.Files, ".claude-plugin/plugin.json")
	if f == nil {
		return fail("native_plugin_manifest_invalid")
	}
	var manifest map[string]any
	if err := json.Unmarshal(f.Content, &manifest); err != nil || manifest == nil {
		return fail("native_plugin_manifest_invalid")
	}
	if manifest["name"] != pkg.ID || manifest["version"] != pkg.Version {
		return fail("native_plugin_manifest_mismatch")
	}
	return nil
}

func (a nativeMarketplaceAdapter) checkTarget(ctx pluginAdapterContext, rec ManagedRecord, current *nativeInstalledRow) error {
	expected, err := a.target(ctx, rec.ID, rec.Version)
	if err != nil {
		return err
	}
	absTarget, _ := filepath.Abs(rec.Target)
	if absTarget != expected {
		return fail("native_plugin_legacy_projection_migration_required")
	}
	if current != nil {
		absCurrent, _ := filepath.Abs(current.installPath)
		if absCurrent != absTarget {
			return fail("native_plugin_install_path_mismatch")
		}
	}
	st := directoryStatus(rec.Target, rec.Digest)
	if st == "modified" {
		return fail("native_plugin_target_modified")
	}
	if current != nil && st != "present" {
		return fail("native_plugin_target_modified")
	}
	return nil
}

func (a nativeMarketplaceAdapter) install(ctx pluginAdapterContext, pkg PluginPackage, rec *ManagedRecord, prev *ManagedRecord) (map[string]any, error) {
	if err := a.validate(pkg); err != nil {
		return nil, err
	}
	expected, err := a.target(ctx, rec.ID, rec.Version)
	if err != nil {
		return nil, err
	}
	absRecTarget, _ := filepath.Abs(rec.Target)
	if absRecTarget != expected {
		return nil, fail("native_plugin_legacy_projection_migration_required")
	}
	oldDirectory := prev != nil && a.isLegacy(ctx, *prev)
	if oldDirectory {
		if _, err := safeMarketplacePath(ctx.hostHomeDir, prev.Target); err != nil {
			return nil, err
		}
		if directoryStatus(prev.Target, prev.Digest) == "modified" {
			return nil, fail("native_plugin_target_modified")
		}
	} else if prev != nil {
		if err := a.checkTarget(ctx, *prev, nil); err != nil {
			return nil, err
		}
	}
	current, err := a.installed(ctx, pkg.ID)
	if err != nil {
		return nil, err
	}
	targetStat, _ := lstatMaybe(rec.Target)
	if !((current == nil && targetStat == nil) || (prev != nil && !oldDirectory)) {
		return nil, fail("native_plugin_target_conflict")
	}
	if err := a.checkTarget(ctx, *rec, current); err != nil {
		return nil, err
	}
	owned, row, err := verifyOwnedMarketplace(ctx, pkg, true)
	if err != nil {
		return nil, err
	}
	if owned != nil && directoryStatus(owned.target, owned.digest) == "absent" {
		if err := copyPluginFiles(owned.files, owned.target); err != nil {
			return nil, err
		}
	}
	if row == nil {
		if _, err := a.runCommand(ctx, []string{"plugin", "marketplace", "add", owned.target}); err != nil {
			return nil, err
		}
	}
	_, verifyRow, err := verifyOwnedMarketplace(ctx, pkg, false)
	if err != nil {
		return nil, err
	}
	if verifyRow == nil {
		return nil, fail("native_plugin_marketplace_registration_failed")
	}
	ref := pkg.ID + "@" + owned.name
	if current == nil {
		if _, err := a.runCommand(ctx, []string{"plugin", "install", ref, "--scope", "user"}); err != nil {
			return nil, err
		}
	} else if !current.enabled {
		if _, err := a.runCommand(ctx, []string{"plugin", "enable", ref, "--scope", "user"}); err != nil {
			return nil, err
		}
	}
	after, err := a.installed(ctx, pkg.ID)
	if err != nil {
		return nil, err
	}
	if err := a.checkTarget(ctx, *rec, after); err != nil {
		return nil, err
	}
	if after == nil || !after.enabled {
		return nil, fail("native_plugin_enable_failed")
	}
	if oldDirectory {
		if err := removeOwnedDir(prev.Target, prev.Digest); err != nil {
			return nil, err
		}
	}
	return map[string]any{
		"status":      "installed",
		"marketplace": owned.name,
		"marketRoot":  owned.target,
	}, nil
}

func (a nativeMarketplaceAdapter) disable(ctx pluginAdapterContext, pkg PluginPackage, rec *ManagedRecord) error {
	if a.isLegacy(ctx, *rec) {
		if _, err := safeMarketplacePath(ctx.hostHomeDir, rec.Target); err != nil {
			return err
		}
		return removeOwnedDir(rec.Target, rec.Digest)
	}
	if _, _, err := verifyOwnedMarketplace(ctx, pkg, false); err != nil {
		return err
	}
	current, err := a.installed(ctx, rec.ID)
	if err != nil {
		return err
	}
	if err := a.checkTarget(ctx, *rec, current); err != nil {
		return err
	}
	if current != nil && current.enabled {
		ref := rec.ID + "@" + marketplaceNameFor(ctx, rec.ID)
		if _, err := a.runCommand(ctx, []string{"plugin", "disable", ref, "--scope", "user"}); err != nil {
			return err
		}
	}
	after, err := a.installed(ctx, rec.ID)
	if err != nil {
		return err
	}
	if after != nil && after.enabled {
		return fail("native_plugin_disable_failed")
	}
	return nil
}

var orphanedAtRe = regexp.MustCompile(`^\d{13}$`)

func removableCacheDigest(rec ManagedRecord) (string, error) {
	if directoryStatus(rec.Target, rec.Digest) != "modified" {
		return rec.Digest, nil
	}
	files, err := readTreeFiles(rec.Target, "skill_source")
	if err != nil {
		return "", fail("native_plugin_target_modified")
	}
	var marker *PackageFile
	without := make([]PackageFile, 0, len(files))
	for i := range files {
		if files[i].Name == ".orphaned_at" {
			marker = &files[i]
		} else {
			without = append(without, files[i])
		}
	}
	if marker == nil || marker.Executable || !orphanedAtRe.Match(marker.Content) || digestFiles(without) != rec.Digest {
		return "", fail("native_plugin_target_modified")
	}
	return digestFiles(files), nil
}

func (a nativeMarketplaceAdapter) remove(ctx pluginAdapterContext, pkg PluginPackage, rec *ManagedRecord) error {
	if a.isLegacy(ctx, *rec) {
		if _, err := safeMarketplacePath(ctx.hostHomeDir, rec.Target); err != nil {
			return err
		}
		return removeOwnedDir(rec.Target, rec.Digest)
	}
	owned, row, err := verifyOwnedMarketplace(ctx, pkg, true)
	if err != nil {
		return err
	}
	current, err := a.installed(ctx, rec.ID)
	if err != nil {
		return err
	}
	checkRec := *rec
	if current == nil {
		d, err := removableCacheDigest(*rec)
		if err != nil {
			return err
		}
		checkRec.Digest = d
	}
	if err := a.checkTarget(ctx, checkRec, current); err != nil {
		return err
	}
	if current != nil {
		ref := rec.ID + "@" + owned.name
		if _, err := a.runCommand(ctx, []string{"plugin", "uninstall", ref, "--scope", "user", "--yes", "--keep-data"}); err != nil {
			return err
		}
	}
	if rem, err := a.installed(ctx, rec.ID); err != nil {
		return err
	} else if rem != nil {
		return fail("native_plugin_remove_failed")
	}
	if row != nil {
		if _, err := a.runCommand(ctx, []string{"plugin", "marketplace", "remove", owned.name}); err != nil {
			return err
		}
	}
	if _, afterRow, err := verifyOwnedMarketplace(ctx, pkg, true); err != nil {
		return err
	} else if afterRow != nil {
		return fail("native_plugin_marketplace_remove_failed")
	}
	finalDigest, err := removableCacheDigest(*rec)
	if err != nil {
		return err
	}
	if err := removeOwnedDir(rec.Target, finalDigest); err != nil {
		return err
	}
	return removeOwnedDir(owned.target, owned.digest)
}

func (a nativeMarketplaceAdapter) inspect(ctx pluginAdapterContext, rec ManagedRecord) string {
	if a.isLegacy(ctx, rec) {
		info, _ := lstatMaybe(rec.Target)
		if info != nil {
			return "legacy"
		}
		return "absent"
	}
	snapshotDir := filepath.Join(ctx.aiHomeDir, "managed-resources", "native-plugins", rec.ID, rec.Version)
	pkg, err := verifyPluginSnapshot(snapshotDir, rec)
	if err != nil {
		return "modified"
	}
	if _, _, err := verifyOwnedMarketplace(ctx, pkg, false); err != nil {
		return "modified"
	}
	current, err := a.installed(ctx, rec.ID)
	if err != nil {
		return "modified"
	}
	if err := a.checkTarget(ctx, rec, current); err != nil {
		return "modified"
	}
	if current == nil {
		info, _ := lstatMaybe(rec.Target)
		if info != nil {
			return "modified"
		}
		return "absent"
	}
	if current.enabled {
		return "present"
	}
	return "absent"
}

func (nativeMarketplaceAdapter) hasReplace() bool { return true }

func (a nativeMarketplaceAdapter) replace(ctx pluginAdapterContext, pkg PluginPackage, rec *ManagedRecord, prev *ManagedRecord) (map[string]any, error) {
	if err := a.validate(pkg); err != nil {
		return nil, err
	}
	oldSnap := filepath.Join(ctx.aiHomeDir, "managed-resources", "native-plugins", prev.ID, prev.Version)
	oldPkg, err := verifyPluginSnapshot(oldSnap, *prev)
	if err != nil {
		return nil, err
	}
	expected, err := a.target(ctx, rec.ID, rec.Version)
	if err != nil {
		return nil, err
	}
	info, _ := lstatMaybe(rec.Target)
	if rec.Target != expected || info != nil {
		return nil, fail("native_plugin_target_conflict")
	}
	if err := a.remove(ctx, oldPkg, prev); err != nil {
		return nil, err
	}
	res, err := a.install(ctx, pkg, rec, nil)
	if err != nil {
		// 尽力恢复先前已托管状态。
		_ = a.remove(ctx, pkg, rec)
		if _, recErr := a.install(ctx, oldPkg, prev, nil); recErr == nil && !prev.Enabled {
			_ = a.disable(ctx, oldPkg, prev)
		}
		return nil, err
	}
	return res, nil
}

// --- Codex Marketplace 适配器 ---

type codexMarketplaceAdapter struct{}

const codexMarketplaceName = "aih-local"

func (codexMarketplaceAdapter) runCommand(ctx pluginAdapterContext, args []string) (map[string]any, error) {
	env := copyEnvMap(ctx.env)
	env["HOME"] = ctx.hostHomeDir
	env["USERPROFILE"] = ctx.hostHomeDir
	env["CODEX_HOME"] = filepath.Join(ctx.hostHomeDir, ".codex")
	res := ctx.runner.Run(context.Background(), ctx.binary, args, ctx.hostHomeDir, env, 30*time.Second)
	if res.ExitCode != 0 {
		return nil, fail("native_plugin_command_failed")
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(res.Stdout), &out); err != nil || out == nil {
		return nil, fail("native_plugin_response_invalid")
	}
	return out, nil
}

func (a codexMarketplaceAdapter) listInstalled(ctx pluginAdapterContext, id string) (map[string]any, error) {
	out, err := a.runCommand(ctx, []string{"plugin", "list", "--json"})
	if err != nil {
		return nil, err
	}
	rows, _ := out["installed"].([]any)
	target := id + "@" + codexMarketplaceName
	for _, r := range rows {
		m, ok := r.(map[string]any)
		if ok && m["pluginId"] == target {
			return m, nil
		}
	}
	return nil, nil
}

func extractMarketplaceLocation(row map[string]any) string {
	for _, k := range []string{"source", "sourcePath", "path", "root", "installedRoot"} {
		if v, ok := row[k]; ok && v != nil {
			if s, ok := v.(string); ok && s != "" {
				return s
			}
			if m, ok := v.(map[string]any); ok {
				if s, _ := m["source"].(string); s != "" {
					return s
				}
				if p, _ := m["path"].(string); p != "" {
					return p
				}
			}
		}
	}
	return ""
}

func (codexMarketplaceAdapter) target(ctx pluginAdapterContext, id, version string) (string, error) {
	v := version
	if v == "" {
		v = "current"
	}
	return filepath.Join(ctx.hostHomeDir, ".codex", "plugins", "cache", codexMarketplaceName, id, v), nil
}

func (codexMarketplaceAdapter) validate(_ PluginPackage) error { return nil }
func (codexMarketplaceAdapter) hasReplace() bool             { return false }
func (codexMarketplaceAdapter) replace(_ pluginAdapterContext, _ PluginPackage, _ *ManagedRecord, _ *ManagedRecord) (map[string]any, error) {
	return nil, nil
}

func (a codexMarketplaceAdapter) install(ctx pluginAdapterContext, pkg PluginPackage, rec *ManagedRecord, prev *ManagedRecord) (map[string]any, error) {
	if err := os.MkdirAll(filepath.Join(ctx.hostHomeDir, ".codex"), 0o700); err != nil {
		return nil, err
	}
	marketRoot := filepath.Join(ctx.aiHomeDir, "managed-resources", "native-plugin-marketplaces", pkg.ID)
	installed, err := a.listInstalled(ctx, pkg.ID)
	if err != nil {
		return nil, err
	}
	if installed != nil && prev == nil {
		return nil, fail("native_plugin_target_conflict")
	}
	if info, _ := lstatMaybe(rec.Target); info != nil && prev == nil {
		return nil, fail("native_plugin_target_conflict")
	}
	listOut, err := a.runCommand(ctx, []string{"plugin", "marketplace", "list", "--json"})
	if err != nil {
		return nil, err
	}
	markets, _ := listOut["marketplaces"].([]any)
	var existing map[string]any
	for _, m := range markets {
		row, ok := m.(map[string]any)
		if ok && (row["name"] == codexMarketplaceName || row["marketplaceName"] == codexMarketplaceName) {
			existing = row
			break
		}
	}
	if existing != nil {
		loc := extractMarketplaceLocation(existing)
		realRoot := canonicalPath(marketRoot)
		absLoc := canonicalPath(loc)
		if loc == "" || absLoc != realRoot {
			return nil, fail("native_plugin_marketplace_conflict")
		}
	}
	pluginDir := filepath.Join(marketRoot, "plugins", pkg.ID)
	if info, _ := lstatMaybe(pluginDir); info == nil {
		if err := copyPluginPackage(pkg, pluginDir); err != nil {
			return nil, err
		}
	} else if directoryStatus(pluginDir, pkg.Digest) != "present" {
		return nil, fail("native_plugin_snapshot_modified")
	}
	desc, _ := pkg.PackageJSON["description"].(string)
	manifestObj := map[string]any{
		"name":  codexMarketplaceName,
		"owner": map[string]any{"name": "AIH"},
		"plugins": []map[string]any{
			{"name": pkg.ID, "source": "./plugins/" + pkg.ID, "description": desc},
		},
	}
	manifestBytes, _ := json.MarshalIndent(manifestObj, "", "  ")
	manifestFile := filepath.Join(marketRoot, ".agents", "plugins", "marketplace.json")
	if err := atomicWriteFile(manifestFile, manifestBytes, 0o600); err != nil {
		return nil, err
	}
	if existing == nil {
		if _, err := a.runCommand(ctx, []string{"plugin", "marketplace", "add", marketRoot, "--json"}); err != nil {
			return nil, err
		}
	}
	if installed != nil {
		if directoryStatus(rec.Target, rec.Digest) != "present" {
			return nil, fail("native_plugin_target_modified")
		}
		return prev.NativeInstall, nil
	}
	out, err := a.runCommand(ctx, []string{"plugin", "add", pkg.ID + "@" + codexMarketplaceName, "--json"})
	if err != nil {
		return nil, err
	}
	ip, _ := out["installedPath"].(string)
	realTarget := canonicalPath(rec.Target)
	absIP := canonicalPath(ip)
	if ip == "" || absIP != realTarget {
		return nil, fail("native_plugin_install_path_mismatch")
	}
	if directoryStatus(rec.Target, rec.Digest) != "present" {
		return nil, fail("native_plugin_target_modified")
	}
	return map[string]any{"status": "installed", "marketplace": codexMarketplaceName}, nil
}

func (a codexMarketplaceAdapter) disable(ctx pluginAdapterContext, _ PluginPackage, rec *ManagedRecord) error {
	installed, err := a.listInstalled(ctx, rec.ID)
	if err != nil {
		return err
	}
	if installed != nil {
		if directoryStatus(rec.Target, rec.Digest) != "present" {
			return fail("native_plugin_target_modified")
		}
		if _, err := a.runCommand(ctx, []string{"plugin", "remove", rec.ID + "@" + codexMarketplaceName, "--json"}); err != nil {
			return err
		}
	}
	return nil
}

func (a codexMarketplaceAdapter) remove(ctx pluginAdapterContext, pkg PluginPackage, rec *ManagedRecord) error {
	listOut, err := a.runCommand(ctx, []string{"plugin", "marketplace", "list", "--json"})
	if err != nil {
		return err
	}
	markets, _ := listOut["marketplaces"].([]any)
	var existing map[string]any
	for _, m := range markets {
		row, ok := m.(map[string]any)
		if ok && (row["name"] == codexMarketplaceName || row["marketplaceName"] == codexMarketplaceName) {
			existing = row
			break
		}
	}
	if existing != nil {
		marketRoot, err := safeMarketplacePath(ctx.aiHomeDir, filepath.Join(ctx.aiHomeDir, "managed-resources", "native-plugin-marketplaces", rec.ID))
		if err != nil {
			return err
		}
		loc := extractMarketplaceLocation(existing)
		realRoot := canonicalPath(marketRoot)
		absLoc := canonicalPath(loc)
		if loc == "" || absLoc != realRoot {
			return fail("native_plugin_marketplace_conflict")
		}
		manifestFile, err := safeMarketplacePath(marketRoot, filepath.Join(marketRoot, ".agents", "plugins", "marketplace.json"))
		if err != nil {
			return err
		}
		info, _ := lstatMaybe(manifestFile)
		if info == nil || !info.Mode().IsRegular() || info.Size() > 1024*1024 {
			return fail("native_plugin_marketplace_modified")
		}
		raw, readErr := os.ReadFile(manifestFile)
		if readErr != nil {
			return fail("native_plugin_marketplace_modified")
		}
		var got map[string]any
		if json.Unmarshal(raw, &got) != nil {
			return fail("native_plugin_marketplace_modified")
		}
		desc, _ := pkg.PackageJSON["description"].(string)
		expected := map[string]any{
			"name":  codexMarketplaceName,
			"owner": map[string]any{"name": "AIH"},
			"plugins": []map[string]any{
				{"name": pkg.ID, "source": "./plugins/" + pkg.ID, "description": desc},
			},
		}
		expBytes, _ := json.Marshal(expected)
		gotBytes, _ := json.Marshal(got)
		if string(expBytes) != string(gotBytes) {
			return fail("native_plugin_marketplace_modified")
		}
		if directoryStatus(filepath.Join(marketRoot, "plugins", pkg.ID), pkg.Digest) != "present" {
			return fail("native_plugin_marketplace_modified")
		}
	}
	if err := a.disable(ctx, pkg, rec); err != nil {
		return err
	}
	if existing != nil {
		if _, err := a.runCommand(ctx, []string{"plugin", "marketplace", "remove", codexMarketplaceName, "--json"}); err != nil {
			return err
		}
	}
	return nil
}

func (a codexMarketplaceAdapter) inspect(ctx pluginAdapterContext, rec ManagedRecord) string {
	installed, err := a.listInstalled(ctx, rec.ID)
	if err != nil {
		return "modified"
	}
	if installed == nil {
		info, _ := lstatMaybe(rec.Target)
		if info != nil {
			return "modified"
		}
		return "absent"
	}
	return directoryStatus(rec.Target, rec.Digest)
}

var nativePluginAdapters = map[string]pluginAdapter{
	"native-directory":   directoryPluginAdapter{skillsSubdir: false},
	"claude-skills-dir":  directoryPluginAdapter{skillsSubdir: true},
	"gemini-extension":   geminiExtensionAdapter{},
	"opencode-local":     opencodePluginAdapter{},
	"cordis-patch":       cordisPatchAdapter{},
	"native-marketplace": nativeMarketplaceAdapter{},
	"codex-marketplace":  codexMarketplaceAdapter{},
}

// --- Native Plugin Manager ---

type nativePluginManager struct {
	aiHomeDir      string
	hostHomeDir    string
	snapshotRoot   string
	registry       map[string]ResourceCapability
	store          *managedStore
	catalog        *providers.Catalog
	env            map[string]string
	runner         CommandRunner
	nativeBinaries map[string]string
}

func newNativePluginManager(aiHomeDir, hostHomeDir string, registry map[string]ResourceCapability, store *managedStore, catalog *providers.Catalog, env map[string]string, runner CommandRunner, binaries map[string]string) (*nativePluginManager, error) {
	if strings.TrimSpace(aiHomeDir) == "" || strings.TrimSpace(hostHomeDir) == "" {
		return nil, fail("native_plugin_home_required")
	}
	return &nativePluginManager{
		aiHomeDir:      aiHomeDir,
		hostHomeDir:    hostHomeDir,
		snapshotRoot:   filepath.Join(aiHomeDir, "managed-resources", "native-plugins"),
		registry:       registry,
		store:          store,
		catalog:        catalog,
		env:            env,
		runner:         runner,
		nativeBinaries: binaries,
	}, nil
}

func (m *nativePluginManager) resolve(provider, host string) (pluginAdapter, pluginAdapterContext, error) {
	p := strings.ToLower(strings.TrimSpace(provider))
	h := strings.ToLower(strings.TrimSpace(host))
	if (p != "") == (h != "") {
		return nil, pluginAdapterContext{}, fail("native_plugin_selector_required")
	}
	var capVal ResourceCapability
	if h != "" {
		capVal = getHostResourceCapability(h, "plugin")
		if capVal.State == "unsupported" {
			return nil, pluginAdapterContext{}, fail("native_plugin_host_unsupported")
		}
	} else {
		var ok bool
		capVal, ok = m.registry[p]
		if !ok || capVal.State == "unsupported" {
			return nil, pluginAdapterContext{}, fail("native_plugin_provider_unsupported")
		}
	}
	adapter, ok := nativePluginAdapters[capVal.Adapter]
	if !ok {
		return nil, pluginAdapterContext{}, fail("native_plugin_adapter_missing")
	}
	bin := p
	if b, ok := m.nativeBinaries[p]; ok && b != "" {
		bin = b
	} else if p != "" && m.catalog != nil {
		if def, ok := m.catalog.Get(p); ok && def.CLI != nil && def.CLI.BinaryName != "" {
			bin = def.CLI.BinaryName
		}
	}
	ctx := pluginAdapterContext{
		provider:    p,
		host:        h,
		capability:  capVal,
		aiHomeDir:   m.aiHomeDir,
		hostHomeDir: m.hostHomeDir,
		binary:      bin,
		catalog:     m.catalog,
		env:         m.env,
		runner:      m.runner,
	}
	return adapter, ctx, nil
}

func findPluginIndex(resources []ManagedRecord, id, provider, host string) int {
	for i := range resources {
		r := resources[i]
		if r.Kind == "native-plugin" && r.ID == id && r.Provider == provider && r.Host == host {
			return i
		}
	}
	return -1
}

// OperateResult 是 plugin 操作的返回视图（兼容 JS 返回 pluginId）。
type PluginOperateResult struct {
	ManagedRecord
	PluginID string `json:"pluginId,omitempty"`
}

func (m *nativePluginManager) install(ctx context.Context, source, provider, host string) (PluginOperateResult, error) {
	pkg, err := readPluginPackage(source)
	if err != nil {
		return PluginOperateResult{}, err
	}
	adapter, aCtx, err := m.resolve(provider, host)
	if err != nil {
		return PluginOperateResult{}, err
	}
	if aCtx.host != "" {
		ports := inspectPortablePlugin(pkg)
		if ports[aCtx.host].State != "projection-ready" {
			return PluginOperateResult{}, fail("native_plugin_host_projection_invalid")
		}
	}
	if err := adapter.validate(pkg); err != nil {
		return PluginOperateResult{}, err
	}
	if _, err := snapshotPluginPackage(m.snapshotRoot, pkg); err != nil {
		return PluginOperateResult{}, err
	}
	res, err := m.store.update(ctx, func(st *ManagedState) (any, error) {
		idx := findPluginIndex(st.Resources, pkg.ID, aCtx.provider, aCtx.host)
		var prev *ManagedRecord
		replacing := false
		if idx >= 0 {
			copyPrev := st.Resources[idx]
			prev = &copyPrev
			replacing = prev.Digest != pkg.Digest
			if replacing && !adapter.hasReplace() {
				oldPkg, vErr := verifyPluginSnapshot(filepath.Join(m.snapshotRoot, prev.ID, prev.Version), *prev)
				if vErr != nil {
					return nil, vErr
				}
				if dErr := adapter.disable(aCtx, oldPkg, prev); dErr != nil {
					return nil, dErr
				}
			}
		}
		targetPath, err := adapter.target(aCtx, pkg.ID, pkg.Version)
		if err != nil {
			return nil, err
		}
		now := time.Now().UnixMilli()
		rec := ManagedRecord{
			Kind:      "native-plugin",
			ID:        pkg.ID,
			Provider:  aCtx.provider,
			Host:      aCtx.host,
			Version:   pkg.Version,
			Digest:    pkg.Digest,
			Target:    targetPath,
			Mode:      "native",
			Enabled:   true,
			CreatedAt: now,
			UpdatedAt: now,
		}
		if prev != nil {
			rec.CreatedAt = prev.CreatedAt
			rec.UpdatedAt = prev.UpdatedAt
		}
		var ni map[string]any
		if replacing && adapter.hasReplace() {
			ni, err = adapter.replace(aCtx, pkg, &rec, prev)
		} else {
			ni, err = adapter.install(aCtx, pkg, &rec, prev)
		}
		if err != nil {
			return nil, err
		}
		rec.NativeInstall = ni
		if idx >= 0 {
			st.Resources[idx] = rec
		} else {
			st.Resources = append(st.Resources, rec)
		}
		return PluginOperateResult{ManagedRecord: rec, PluginID: rec.ID}, nil
	})
	if err != nil {
		return PluginOperateResult{}, err
	}
	return res.(PluginOperateResult), nil
}

func (m *nativePluginManager) change(ctx context.Context, id, provider, host, action string) (ManagedRecord, error) {
	if action != "enable" && action != "disable" && action != "remove" {
		return ManagedRecord{}, fail("native_plugin_action_invalid")
	}
	adapter, aCtx, err := m.resolve(provider, host)
	if err != nil {
		return ManagedRecord{}, err
	}
	res, err := m.store.update(ctx, func(st *ManagedState) (any, error) {
		idx := findPluginIndex(st.Resources, id, aCtx.provider, aCtx.host)
		if idx < 0 {
			return nil, fail("native_plugin_not_installed")
		}
		rec := st.Resources[idx]
		pkg, err := verifyPluginSnapshot(filepath.Join(m.snapshotRoot, id, rec.Version), rec)
		if err != nil {
			return nil, err
		}
		enabled := action == "enable"
		if enabled {
			ni, err := adapter.install(aCtx, pkg, &rec, &rec)
			if err != nil {
				return nil, err
			}
			rec.NativeInstall = ni
		} else if action == "remove" {
			if err := adapter.remove(aCtx, pkg, &rec); err != nil {
				return nil, err
			}
		} else if rec.Enabled || adapter.inspect(aCtx, rec) != "absent" {
			if err := adapter.disable(aCtx, pkg, &rec); err != nil {
				return nil, err
			}
		}
		if action == "remove" {
			st.Resources = append(st.Resources[:idx], st.Resources[idx+1:]...)
			rec.Enabled = false
			rec.Removed = true
			return rec, nil
		}
		if rec.Enabled != enabled {
			rec.Enabled = enabled
			rec.UpdatedAt = time.Now().UnixMilli()
			st.Resources[idx] = rec
		}
		return rec, nil
	})
	if err != nil {
		return ManagedRecord{}, err
	}
	return res.(ManagedRecord), nil
}

func (m *nativePluginManager) list(ctx context.Context, provider, host string) (int, []ManagedRecord, error) {
	st, err := m.store.get(ctx)
	if err != nil {
		return 0, nil, err
	}
	p := strings.ToLower(strings.TrimSpace(provider))
	h := strings.ToLower(strings.TrimSpace(host))
	out := make([]ManagedRecord, 0)
	for _, r := range st.Resources {
		if r.Kind == "native-plugin" && (p == "" || r.Provider == p) && (h == "" || r.Host == h) {
			out = append(out, r)
		}
	}
	return st.Revision, out, nil
}

// Keep unused strconv import happy if needed; check compiler.
var _ = strconv.Itoa

func canonicalPath(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		return p
	}
	if realP, err := filepath.EvalSymlinks(abs); err == nil {
		return realP
	}
	parent := filepath.Dir(abs)
	for parent != filepath.Dir(parent) {
		if realParent, err := filepath.EvalSymlinks(parent); err == nil {
			rel, _ := filepath.Rel(parent, abs)
			return filepath.Join(realParent, rel)
		}
		parent = filepath.Dir(parent)
	}
	return abs
}
