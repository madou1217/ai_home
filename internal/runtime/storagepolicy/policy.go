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
	codebuddyAuth = []string{"Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth"}
	attachments   = []string{"tmp", "model", "images"}
)

func credential(field, format string, optional bool, path ...string) Artifact {
	return Artifact{Field: field, Path: path, Format: format, Optional: optional}
}

// builtinCatalog 只构造一次：AuthArtifacts 的根相对路径由 Provider 合同展开。
var builtinCatalog = sync.OnceValue(func() *providers.Catalog {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		panic("storagepolicy: Provider 合同无效: " + err.Error())
	}
	return catalog
})

// nativePath 返回 <该 Provider 的 NativeRoot>/<suffix...>，根事实来自合同。
func nativePath(providerID string, suffix ...string) []string {
	definition, found := builtinCatalog().Get(providerID)
	if !found {
		panic("storagepolicy: 未知 Provider " + providerID)
	}
	return append(definition.EffectiveNativeRoot(), suffix...)
}

// configPath 返回 <该 Provider 的 CLI.GlobalDir>/<suffix...>。
// 用于不使用 NativeRoot、但仍在配置根下的凭据（例如 agy 的共享 token）。
func configPath(providerID string, suffix ...string) []string {
	definition, found := builtinCatalog().Get(providerID)
	if !found || definition.CLI == nil {
		panic("storagepolicy: 未知 Provider 或缺少 CLI 配置 " + providerID)
	}
	return append(strings.Split(strings.TrimSpace(definition.CLI.GlobalDir), "/"), suffix...)
}

func private(path ...string) Artifact { return Artifact{Path: path} }

func sharedAuthPath(name string) []string {
	out := make([]string, 0, len(codebuddyAuth)+1)
	out = append(out, codebuddyAuth...)
	return append(out, name)
}

// codebuddyPrivateDesktopState is the private state shared by every CodeBuddy
// family member. It is HOME-relative, not native-root-relative.
func codebuddyPrivateDesktopState() []Artifact {
	return []Artifact{
		private("electron-user-data"),
		private(".codebuddy", "diagnostics"),
		private("Library", "Preferences", "com.apple.security.plist"),
		private(".workbuddy-key-fallback"),
		private("Library", "Application Support", "CodeBuddyExtension", "Cache"),
		private("Library", "Application Support", "CodeBuddyExtension", "Logs"),
	}
}

func codebuddyFamilyPrivate(nativeRoot string) []Artifact {
	items := codebuddyPrivateDesktopState()
	if nativeRoot != "" {
		items = append(items, private(nativeRoot, ".mcp.json"), private(nativeRoot, "sessions"))
	}
	return append(items, private("Library", "Keychains"))
}

var providerOrder = []string{
	"codex", "claude", "gemini", "agy", "opencode", "grok", "kimi", "zcode",
	"kiro", "cline", "qoder", "qodercn", "codebuddy", "codebuddycn",
	"workbuddy", "workbuddycn",
}

var policies = map[string]Policy{
	"codex": {
		AuthArtifacts: []Artifact{
			credential("auth", "json", false, nativePath("codex", "auth.json")...),
		},
		PrivateArtifacts: []Artifact{
			private("electron-user-data"),
			private(".codex", "config.toml"),
			private("Library", "Keychains"),
		},
		AttachmentSubdir: []string{".tmp", "model", "images"},
	},
	"claude": {
		AuthArtifacts: []Artifact{
			credential("credentials", "json", false, nativePath("claude", ".credentials.json")...),
		},
		PrivateArtifacts: []Artifact{
			private("electron-user-data"),
			private("Library", "Keychains"),
		},
		AttachmentSubdir: attachments,
	},
	"gemini": {
		AuthArtifacts: []Artifact{
			credential("oauthCreds", "json", false, nativePath("gemini", "oauth_creds.json")...),
			credential("googleAccounts", "json", true, nativePath("gemini", "google_accounts.json")...),
		},
		PrivateArtifacts: []Artifact{
			private("Library", "Keychains"),
		},
		AttachmentSubdir: attachments,
	},
	"agy": {
		AuthArtifacts: []Artifact{
			credential("oauthToken", "json", false, nativePath("agy", "antigravity-oauth-token")...),
			credential("desktopOauthToken", "json", true, configPath("agy", "jetski-standalone-oauth-token")...),
			credential("email", "text", true, nativePath("agy", "email.cache")...),
			credential("oauthCreds", "json", true, configPath("agy", "oauth_creds.json")...),
			credential("googleAccounts", "json", true, configPath("agy", "google_accounts.json")...),
		},
		PrivateArtifacts: []Artifact{
			private("electron-user-data"),
			private("Library", "Keychains"),
		},
		AttachmentSubdir: attachments,
	},
	"opencode": {
		AuthArtifacts: []Artifact{
			credential("auth", "json", false, nativePath("opencode", "auth.json")...),
		},
		PrivateArtifacts: []Artifact{
			private("electron-user-data"),
			private(".local", "share", "aih-opencode-runtime", "opencode", "auth.json"),
			private(".config", "opencode", "auth.json"),
			private("Library", "Keychains"),
		},
		AttachmentSubdir: attachments,
	},
	"grok": {
		HostAuthRoot:     emptySegments,
		AttachmentSubdir: attachments,
		AuthArtifacts: []Artifact{
			credential("auth", "json", false, nativePath("grok", "auth.json")...),
		},
		PrivateArtifacts: []Artifact{
			private("Library", "Keychains"),
		},
	},
	"kimi": {
		HostAuthRoot: emptySegments,
		AuthArtifacts: []Artifact{
			credential("credentials", "json", false, nativePath("kimi", "credentials", "kimi-code.json")...),
			credential("deviceId", "text", true, nativePath("kimi", "device_id")...),
		},
		PrivateArtifacts: []Artifact{
			private("electron-user-data"),
			private(".kimi-code", "config.toml"),
			private(".kimi-code", "credentials"),
			private(".kimi-code", "session_index.jsonl"),
		},
		AttachmentSubdir: attachments,
	},
	"zcode": {
		HostAuthRoot: emptySegments,
		AuthArtifacts: []Artifact{
			credential("credentials", "json", false, nativePath("zcode", "v2", "credentials.json")...),
			credential("config", "json", true, nativePath("zcode", "v2", "config.json")...),
		},
		PrivateArtifacts: []Artifact{
			private("electron-user-data"),
			private("Library", "Keychains"),
		},
		AttachmentSubdir: attachments,
	},
	"kiro": {
		HostAuthRoot: []string{".local", "share", "kiro-cli"},
		AuthArtifacts: []Artifact{
			credential("database", "binary-base64", false, "data.sqlite3"),
		},
		PrivateArtifacts: []Artifact{
			private("electron-user-data"),
			private(".aih-kiro-auth-binding"),
		},
		AttachmentSubdir: attachments,
	},
	"cline": {
		HostAuthRoot:     emptySegments,
		AttachmentSubdir: attachments,
		AuthArtifacts: []Artifact{
			credential("auth", "json", false, nativePath("cline", "data", "settings", "providers.json")...),
		},
		PrivateArtifacts: []Artifact{
			private("electron-user-data"),
			private(".cline", "data", "settings"),
			private(".cline", "data", "secrets.json"),
			private("Library", "Keychains"),
		},
	},
	"qoder": {
		HostAuthRoot: []string{".qoder"},
		AuthArtifacts: []Artifact{
			credential("credentials", "text", false, ".auth", "user"),
			credential("machineId", "text", true, ".auth", "machine_id"),
			credential("dnsCache", "json", true, ".cache", "dns-cache.json"),
		},
		PrivateArtifacts: []Artifact{
			private("electron-user-data"),
			private(".auth"),
			private("Library", "Keychains"),
		},
		AttachmentSubdir: attachments,
	},
	"qodercn": {
		HostAuthRoot: []string{".qoder-cn"},
		AuthArtifacts: []Artifact{
			credential("credentials", "text", false, ".auth", "user"),
			credential("machineId", "text", true, ".auth", "machine_id"),
			credential("dnsCache", "json", true, ".cache", "dns-cache.json"),
		},
		PrivateArtifacts: []Artifact{
			private("electron-user-data"),
			private(".auth"),
			private("Library", "Keychains"),
		},
		AttachmentSubdir: attachments,
	},
	"codebuddy": {
		HostAuthRoot: emptySegments,
		AuthArtifacts: []Artifact{
			credential("credentials", "json", false, sharedAuthPath("Tencent-Cloud.coding-copilot.info")...),
		},
		PrivateArtifacts: codebuddyFamilyPrivate(".codebuddy"),
		AttachmentSubdir: attachments,
	},
	"codebuddycn": {
		HostAuthRoot: emptySegments,
		AuthArtifacts: []Artifact{
			credential("credentials", "json", false, sharedAuthPath("workbuddy-desktop.info")...),
		},
		PrivateArtifacts: codebuddyFamilyPrivate(".codebuddy-cn"),
		AttachmentSubdir: attachments,
	},
	"workbuddy": {
		HostAuthRoot: emptySegments,
		AuthArtifacts: []Artifact{
			credential("credentials", "json", false, sharedAuthPath("workbuddy-desktop-ai.info")...),
		},
		PrivateArtifacts: codebuddyFamilyPrivate(""),
		AttachmentSubdir: attachments,
	},
	"workbuddycn": {
		HostAuthRoot: emptySegments,
		AuthArtifacts: []Artifact{
			credential("credentials", "json", false, sharedAuthPath("workbuddy-desktop.info")...),
		},
		PrivateArtifacts: codebuddyFamilyPrivate(""),
		AttachmentSubdir: attachments,
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
