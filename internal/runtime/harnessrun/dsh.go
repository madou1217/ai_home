package harnessrun

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	dshProfileName     = "aih"
	dshWrapperFile     = "run-dsh.mjs"
	dshRefreshFile     = "aih-model-refresh.mjs"
	dshRefreshEntry    = "aih-model-refresh"
	dshRefreshInterval = 5 * 60 * 1000
)

var dshProfileBundles = []string{"@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"}

const dshCordisYML = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

const dshPnPmWorkspaceYML = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

const dshPatchHeader = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; ` + "`!!js`" + ` expressions allowed).
`

// routeOwnerHeaders 保持 Node 写出的头部顺序。
type routeOwnerHeaders struct {
	RouteOwner string `json:"x-aih-route-owner" yaml:"x-aih-route-owner"`
	AccountRef string `json:"x-account-ref,omitempty" yaml:"x-account-ref,omitempty"`
}

type dshCompat struct {
	SupportsDeveloperRole bool   `json:"supportsDeveloperRole" yaml:"supportsDeveloperRole"`
	MaxTokensField        string `json:"maxTokensField" yaml:"maxTokensField"`
}

type dshProviderConfig struct {
	DisplayName string            `json:"displayName" yaml:"displayName"`
	APIKeyEnv   string            `json:"apiKeyEnv" yaml:"apiKeyEnv"`
	API         string            `json:"api" yaml:"api"`
	BaseURL     string            `json:"baseURL" yaml:"baseURL"`
	Headers     routeOwnerHeaders `json:"headers" yaml:"headers"`
	Compat      dshCompat         `json:"compat" yaml:"compat"`
	Models      []dshModel        `json:"models" yaml:"models"`
}

func buildDshProviderConfig(baseURL string, accountRef string, models []harnessModel) dshProviderConfig {
	return dshProviderConfig{
		DisplayName: "AIH Gateway",
		APIKeyEnv:   "OPENAI_API_KEY",
		API:         "openai-completions",
		BaseURL:     strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		Headers: routeOwnerHeaders{
			RouteOwner: "node",
			AccountRef: strings.TrimSpace(accountRef),
		},
		Compat: dshCompat{SupportsDeveloperRole: false, MaxTokensField: "max_tokens"},
		Models: buildDshModels(models),
	}
}

type dshProfilePaths struct {
	ProfileDir    string
	ProfileName   string
	PackagePath   string
	PatchPath     string
	CordisPath    string
	WorkspacePath string
}

type dshPatchInput struct {
	BaseURL    string
	AccountRef string
	Models     []harnessModel
	Model      string
	IntervalMS int64
}

// ensureDshProfile 复刻 ensureDshProfile：profile 目录、热更新插件、静态
// cordis.yml / pnpm-workspace.yaml、package.json bundles 与 patch 分层。
func ensureDshProfile(dshHome string, input dshPatchInput) (dshProfilePaths, error) {
	if strings.TrimSpace(dshHome) == "" {
		return dshProfilePaths{}, errors.New("dsh_home_missing")
	}
	profileDir := filepath.Join(dshHome, "profiles", dshProfileName)
	if err := os.MkdirAll(profileDir, privateDirMode); err != nil {
		return dshProfilePaths{}, err
	}
	if err := writePrivateText(filepath.Join(profileDir, dshRefreshFile), dshModelRefreshSource); err != nil {
		return dshProfilePaths{}, err
	}
	paths := dshProfilePaths{
		ProfileDir:    profileDir,
		ProfileName:   dshProfileName,
		PackagePath:   filepath.Join(profileDir, "package.json"),
		PatchPath:     filepath.Join(profileDir, "cordis.patch.yml"),
		CordisPath:    filepath.Join(profileDir, "cordis.yml"),
		WorkspacePath: filepath.Join(profileDir, "pnpm-workspace.yaml"),
	}
	if err := ensureFileIfMissing(paths.CordisPath, dshCordisYML); err != nil {
		return dshProfilePaths{}, err
	}
	if err := ensureFileIfMissing(paths.WorkspacePath, dshPnPmWorkspaceYML); err != nil {
		return dshProfilePaths{}, err
	}
	packageDocument := readJSONObject(paths.PackagePath)
	if err := writePrivateJSON(paths.PackagePath, buildDshProfilePackage(packageDocument)); err != nil {
		return dshProfilePaths{}, err
	}
	existing := "[]\n"
	if content, err := os.ReadFile(paths.PatchPath); err == nil {
		existing = string(content)
	}
	entries, err := parseDshPatch(existing)
	if err != nil {
		return dshProfilePaths{}, err
	}
	merged := mergeDshPatchEntries(entries, input)
	serialized, err := serializeDshPatch(merged)
	if err != nil {
		return dshProfilePaths{}, err
	}
	return paths, writePrivateText(paths.PatchPath, serialized)
}

func ensureFileIfMissing(filePath string, content string) error {
	if _, err := os.Stat(filePath); err == nil {
		return nil
	}
	return writePrivateText(filePath, content)
}

// buildDshProfilePackage 保持 Node 的 {...defaults, ...pkg, dsh} 覆盖顺序。
func buildDshProfilePackage(packageDocument map[string]any) map[string]any {
	dsh := objectOrEmpty(packageDocument["dsh"])
	profile := objectOrEmpty(dsh["profile"])
	bundles := stringSlice(profile["bundles"])
	for _, bundle := range dshProfileBundles {
		if !containsString(bundles, bundle) {
			bundles = append(bundles, bundle)
		}
	}
	profile["bundles"] = bundles
	dsh["profile"] = profile

	name := normalizeTextValue(packageDocument["name"])
	if name == "" {
		name = "dsh-profile-" + dshProfileName
	}
	next := map[string]any{
		"name":         name,
		"private":      packageDocument["private"] != false,
		"dependencies": objectOrEmpty(packageDocument["dependencies"]),
	}
	for key, value := range packageDocument {
		next[key] = value
	}
	next["dsh"] = dsh
	return next
}

// parseDshPatch 复刻 Node parseDshPatch 的错误码与消息。
func parseDshPatch(text string) ([]any, error) {
	source := strings.TrimSpace(text)
	if source == "" {
		return []any{}, nil
	}
	var parsed any
	if err := yaml.Unmarshal([]byte(source), &parsed); err != nil {
		return nil, fmt.Errorf("dsh_patch_parse_failed: %v", err)
	}
	if parsed == nil {
		return []any{}, nil
	}
	list, ok := asAnySlice(parsed)
	if !ok {
		return nil, errors.New("dsh_patch_parse_failed: cordis.patch.yml must be a YAML array")
	}
	return list, nil
}

// mergeDshPatchEntries 复刻 mergeDshPatchEntries。
func mergeDshPatchEntries(entries []any, input dshPatchInput) []any {
	list := make([]any, 0, len(entries)+2)
	for _, entry := range entries {
		object, ok := asObject(entry)
		if !ok {
			continue
		}
		if normalizeTextValue(object["id"]) == "" {
			list = append(list, object)
			continue
		}
		list = append(list, cloneObject(object))
	}

	llm, llmIndex := findByID(list, "llm-pi-ai")
	if llm == nil {
		llm = map[string]any{"id": "llm-pi-ai", "config": map[string]any{}}
		list = append(list, llm)
		llmIndex = len(list) - 1
	}
	llmConfig := objectOrEmpty(llm["config"])
	providers := objectOrEmpty(llmConfig["providers"])
	providers["aih"] = buildDshProviderConfig(input.BaseURL, input.AccountRef, input.Models)
	llmConfig["providers"] = providers
	llm["config"] = llmConfig
	list[llmIndex] = llm

	defaultModel, defaultIndex := findByID(list, "agent-default-model")
	if defaultModel == nil {
		defaultModel = map[string]any{"id": "agent-default-model", "config": map[string]any{}}
		list = append(list, defaultModel)
		defaultIndex = len(list) - 1
	}
	defaultConfig := objectOrEmpty(defaultModel["config"])
	defaultConfig["provider"] = "aih"
	defaultConfig["model"] = strings.TrimSpace(input.Model)
	defaultModel["config"] = defaultConfig
	list[defaultIndex] = defaultModel

	return withDshModelRefreshEntry(list, input.IntervalMS)
}

// withDshModelRefreshEntry 统一把热更新插件收敛到 insert 行。
func withDshModelRefreshEntry(entries []any, intervalMS int64) []any {
	config := map[string]any{
		"settingsNamespace": "llm-pi-ai",
		"provider":          "aih",
		"intervalMs":        dshRefreshInterval,
	}
	if intervalMS > 0 {
		config["intervalMs"] = intervalMS
	}
	list := make([]any, 0, len(entries)+1)
	for _, entry := range entries {
		if object, ok := asObject(entry); ok && normalizeTextValue(object["id"]) == dshRefreshEntry {
			continue
		}
		list = append(list, entry)
	}
	for _, entry := range list {
		object, ok := asObject(entry)
		if !ok {
			continue
		}
		insert, ok := asAnySlice(object["insert"])
		if !ok {
			continue
		}
		for _, item := range insert {
			inserted, ok := asObject(item)
			if !ok || normalizeTextValue(inserted["id"]) != dshRefreshEntry {
				continue
			}
			merged := objectOrEmpty(inserted["config"])
			for key, value := range config {
				merged[key] = value
			}
			inserted["config"] = merged
			return list
		}
	}
	return append(list, map[string]any{
		"insert": []any{map[string]any{
			"id":     dshRefreshEntry,
			"name":   "./" + dshRefreshFile,
			"config": config,
		}},
	})
}

func serializeDshPatch(entries []any) (string, error) {
	var buffer bytes.Buffer
	encoder := yaml.NewEncoder(&buffer)
	encoder.SetIndent(2)
	if err := encoder.Encode(entries); err != nil {
		return "", err
	}
	if err := encoder.Close(); err != nil {
		return "", err
	}
	return dshPatchHeader + buffer.String(), nil
}

// buildDshWrapperSource 与 Node 逐字一致（模块 URL 以 JSON 字符串形式嵌入）。
func buildDshWrapperSource(entryPath string) string {
	moduleURL := fileURLString(entryPath)
	encoded, _ := jsonQuote(moduleURL)
	return strings.Join([]string{
		"// DSH 0.2.x 的 bin 末尾用 import.meta.main 判断入口；Node 22 里该值为空，",
		"// 直接执行会静默退出。包装器显式 import runCli() 并等待它，行为等价。",
		"import { runCli } from " + encoded + ";",
		"await runCli();",
		"",
	}, "\n")
}

func findByID(list []any, id string) (map[string]any, int) {
	for index, entry := range list {
		object, ok := asObject(entry)
		if ok && normalizeTextValue(object["id"]) == id {
			return object, index
		}
	}
	return nil, -1
}

func asObject(value any) (map[string]any, bool) {
	switch object := value.(type) {
	case map[string]any:
		return object, true
	case map[any]any:
		converted := make(map[string]any, len(object))
		for key, item := range object {
			converted[jsTextValue(key)] = item
		}
		return converted, true
	default:
		return nil, false
	}
}

func objectOrEmpty(value any) map[string]any {
	if object, ok := asObject(value); ok {
		return cloneObject(object)
	}
	return map[string]any{}
}

func asAnySlice(value any) ([]any, bool) {
	switch list := value.(type) {
	case []any:
		return list, true
	default:
		return nil, false
	}
}

func cloneObject(source map[string]any) map[string]any {
	clone := make(map[string]any, len(source))
	for key, value := range source {
		clone[key] = value
	}
	return clone
}

func stringSlice(value any) []string {
	list, ok := asAnySlice(value)
	if !ok {
		return []string{}
	}
	out := make([]string, 0, len(list))
	for _, item := range list {
		text := normalizeTextValue(item)
		if text != "" {
			out = append(out, text)
		}
	}
	return out
}

func normalizeTextValue(value any) string {
	switch item := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(item)
	default:
		return strings.TrimSpace(jsTextValue(item))
	}
}

func jsTextValue(value any) string {
	if value == nil {
		return ""
	}
	return fmt.Sprint(value)
}
