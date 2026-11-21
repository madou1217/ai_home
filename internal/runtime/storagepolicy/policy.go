// Package storagepolicy is the Go port of the part of the provider storage
// policy that the fs and folder-trust slices need: the per-provider location of
// credentials and account-private state (deny rules), and the roots a caller is
// allowed to read.
//
// Source of truth: lib/runtime/provider-storage-policy.js. Only the fields that
// fs/trust consume are ported here; projection/shared-cache/session-entry data
// stays in Node until a Go caller needs it.
//
// Paths in the policy are HOME-relative segments, so the same table works for
// the real host home and for an isolated account home.
package storagepolicy

import (
	"path/filepath"
	"strings"
	"sync"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
)

// RuntimeHomeDir is the per-provider runtime directory name appended to
// RuntimeHomeRoot.
const RuntimeHomeDir = ".aih-runtime-home"

// Artifact is one credential or private artifact entry.
type Artifact struct {
	Field    string   `json:"field,omitempty"`
	Path     []string `json:"path"`
	Format   string   `json:"format,omitempty"`
	Optional bool     `json:"optional,omitempty"`
}

// Policy is the ported subset of a provider storage policy.
//
// HostAuthRoot uses nil to mean "not declared" (JS null) and an empty slice to
// mean "declared empty": the credential root is the home itself.
type Policy struct {
	NativeRoot       []string   `json:"nativeRoot"`
	HostAuthRoot     []string   `json:"hostAuthRoot"`
	RuntimeHomeRoot  []string   `json:"runtimeHomeRoot"`
	AuthArtifacts    []Artifact `json:"authArtifacts"`
	PrivateArtifacts []Artifact `json:"privateArtifacts"`
	AttachmentSubdir []string   `json:"attachmentSubdir"`
}

// FamilyProviders is the CodeBuddy family membership list (single source of
// truth: core/providers CodeBuddyFamilyProviders).
var FamilyProviders = providers.CodeBuddyFamilyProviders()

var (
	emptySegments = []string{}
)

// expandAuthArtifacts 把合同声明的相对路径展开为策略使用的 HOME 相对段。
// Base=native 追加 NativeRoot，config 追加 CLI.GlobalDir；home/hostAuth 保持原样
// （hostAuth 由消费方再与 HostAuthRoot 组合）。
func expandAuthArtifacts(definition providers.Definition) []Artifact {
	if definition.Storage == nil || len(definition.Storage.AuthArtifacts) == 0 {
		return nil
	}
	out := make([]Artifact, 0, len(definition.Storage.AuthArtifacts))
	for _, declared := range definition.Storage.AuthArtifacts {
		out = append(out, Artifact{
			Field:    declared.Field,
			Path:     expandContractPath(definition, declared.Base, declared.Path),
			Format:   declared.Format,
			Optional: declared.Optional,
		})
	}
	return out
}

// expandPrivateArtifacts 把合同声明的私有状态路径展开为 HOME 相对段。
func expandPrivateArtifacts(definition providers.Definition) []Artifact {
	if definition.Storage == nil || len(definition.Storage.PrivateArtifacts) == 0 {
		return nil
	}
	out := make([]Artifact, 0, len(definition.Storage.PrivateArtifacts))
	for _, declared := range definition.Storage.PrivateArtifacts {
		out = append(out, Artifact{Path: expandContractPath(definition, declared.Base, declared.Path)})
	}
	return out
}

func expandContractPath(definition providers.Definition, base, value string) []string {
	path := splitContractPath(value)
	switch base {
	case providers.ArtifactBaseNative:
		return append(definition.EffectiveNativeRoot(), path...)
	case providers.ArtifactBaseConfig:
		if definition.CLI != nil {
			return append(strings.Split(strings.TrimSpace(definition.CLI.GlobalDir), "/"), path...)
		}
	}
	return path
}

func splitContractPath(value string) []string {
	parts := strings.Split(strings.TrimSpace(value), "/")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// builtinCatalog 只构造一次：AuthArtifacts 的根相对路径由 Provider 合同展开。
var builtinCatalog = sync.OnceValue(func() *providers.Catalog {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		panic("storagepolicy: Provider 合同无效: " + err.Error())
	}
	return catalog
})

var providerOrder = []string{
	"codex", "claude", "gemini", "agy", "opencode", "grok", "kimi", "zcode",
	"kiro", "cline", "qoder", "qodercn", "codebuddy", "codebuddycn",
	"workbuddy", "workbuddycn",
}

var policies = map[string]Policy{
	"codex":    {},
	"claude":   {},
	"gemini":   {},
	"agy":      {},
	"opencode": {},
	"grok": {
		HostAuthRoot: emptySegments,
	},
	"kimi": {
		HostAuthRoot: emptySegments,
	},
	"zcode": {
		HostAuthRoot: emptySegments,
	},
	"kiro": {},
	"cline": {
		HostAuthRoot: emptySegments,
	},
	"qoder": {
		HostAuthRoot: providerroot.ConfigRoot("qoder"),
	},
	"qodercn": {
		HostAuthRoot: providerroot.ConfigRoot("qodercn"),
	},
	"codebuddy": {
		HostAuthRoot: emptySegments,
	},
	"codebuddycn": {
		HostAuthRoot: emptySegments,
	},
	"workbuddy": {
		HostAuthRoot: emptySegments,
	},
	"workbuddycn": {
		HostAuthRoot: emptySegments,
	},
}

// init 用 Provider 合同填充主数据根：CLI.GlobalDir 是默认值，
// Storage.NativeRoot 只声明真正不同的特例（agy / opencode / qoder）。
func init() {
	catalog := builtinCatalog()
	for providerID, policy := range policies {
		definition, found := catalog.Get(providerID)
		if !found {
			continue
		}
		policy.NativeRoot = definition.EffectiveNativeRoot()
		policy.AuthArtifacts = expandAuthArtifacts(definition)
		policy.PrivateArtifacts = expandPrivateArtifacts(definition)
		if definition.Storage != nil {
			policy.AttachmentSubdir = append([]string{}, definition.Storage.AttachmentSubdir...)
		}
		if definition.Storage != nil && definition.Storage.HostAuthRoot != nil {
			policy.HostAuthRoot = append([]string{}, (*definition.Storage.HostAuthRoot)...)
		}
		if definition.Storage != nil && definition.Storage.NoRuntimeHome {
			policy.RuntimeHomeRoot = nil
		} else {
			policy.RuntimeHomeRoot = append(append([]string{}, policy.NativeRoot...), RuntimeHomeDir)
		}
		policies[providerID] = policy
	}
}

// Normalize lowercases and trims a provider name, returning "" when the
// provider has no storage policy.
func Normalize(provider string) string {
	name := normalizeName(provider)
	if _, ok := policies[name]; !ok {
		return ""
	}
	return name
}

// Get returns the policy for a provider, or nil when unknown.
func Get(provider string) *Policy {
	name := Normalize(provider)
	if name == "" {
		return nil
	}
	policy := policies[name]
	return &policy
}

// Names returns the ported provider names in declaration order.
func Names() []string { return append([]string{}, providerOrder...) }

// PrivateEntryNames returns the first-level entry names under the provider's
// native root that hold credentials or account-private state. Duplicates and
// order are kept as declared.
func PrivateEntryNames(provider string) []string {
	policy := Get(provider)
	if policy == nil {
		return nil
	}
	root := normalizeSegments(policy.NativeRoot)
	out := []string{}
	artifacts := append(append([]Artifact{}, policy.AuthArtifacts...), policy.PrivateArtifacts...)
	for _, artifact := range artifacts {
		path := normalizeSegments(artifact.Path)
		if len(path) <= len(root) || !hasSegmentPrefix(path, root) {
			continue
		}
		out = append(out, path[len(root)])
	}
	return out
}

// IsPrivateEntryName reports whether a first-level native-root entry is
// account-private. Backup variants ("<name>.bak") are included.
func IsPrivateEntryName(provider, entryName string) bool {
	actual := normalizeSegment(entryName)
	if actual == "" {
		return false
	}
	for _, expected := range PrivateEntryNames(provider) {
		if actual == expected || hasPrefix(actual, expected+".") {
			return true
		}
	}
	return false
}

// FamilyConfigDirNames returns the HOME-relative config directory names of the
// family members that declare a single-segment native root, in family order.
func FamilyConfigDirNames() []string {
	out := []string{}
	for _, provider := range FamilyProviders {
		policy := Get(provider)
		if policy == nil || len(policy.NativeRoot) != 1 {
			continue
		}
		name := policy.NativeRoot[0]
		if !containsString(out, name) {
			out = append(out, name)
		}
	}
	return out
}

// ResolveNativeRoot joins the provider native root onto a home directory.
// Providers without a native root (qoder) resolve to the home itself.
func ResolveNativeRoot(homeDir, provider string) string {
	home := trimSpace(homeDir)
	policy := Get(provider)
	if home == "" || policy == nil {
		return ""
	}
	return joinPath(home, policy.NativeRoot)
}

// ResolveRuntimeHomeRoot joins the provider runtime home onto a home directory.
// Providers that declare no native root or no runtime root have none.
func ResolveRuntimeHomeRoot(homeDir, provider string) string {
	home := trimSpace(homeDir)
	policy := Get(provider)
	if home == "" || policy == nil || len(policy.RuntimeHomeRoot) == 0 || len(policy.NativeRoot) == 0 {
		return ""
	}
	return joinPath(home, policy.RuntimeHomeRoot)
}

// ResolveAttachmentRoot joins the provider attachment directory onto a home
// directory.
func ResolveAttachmentRoot(homeDir, provider string) string {
	root := ResolveNativeRoot(homeDir, provider)
	policy := Get(provider)
	if root == "" || policy == nil {
		return ""
	}
	return filepath.Join(root, filepath.Join(policy.AttachmentSubdir...))
}
