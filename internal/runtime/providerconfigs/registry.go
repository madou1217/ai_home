package providerconfigs

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

const maxEditableBytes = 2 * 1024 * 1024

var formatByExt = map[string]string{
	".toml":  "toml",
	".json":  "json",
	".jsonc": "jsonc",
	".yaml":  "yaml",
	".yml":   "yaml",
	".ini":   "ini",
	".conf":  "ini",
}

// FileLocation 描述配置文件在宿主机的定位基准和相对路径片段。
type FileLocation struct {
	Kind     string
	Provider string
	Parts    []string
}

// FileDefinition 声明某 Provider 允许 WebUI 管理的配置文件元数据。
type FileDefinition struct {
	Provider     string
	ID           string
	Label        string
	Location     FileLocation
	Alternatives []FileLocation
	Format       string
	SchemaID     string
	Sensitive    bool
	Editable     bool
	Description  string
	DocsURL      string
	Synthetic    bool
}

// PublicFile 是对外暴露的配置元数据视图（路径只含 ~ 前缀，不泄宿主绝对根目录）。
type PublicFile struct {
	Provider                 string `json:"provider"`
	ID                       string `json:"id"`
	Label                    string `json:"label"`
	DisplayPath              string `json:"displayPath"`
	Exists                   bool   `json:"exists"`
	Size                     int64  `json:"size"`
	ModifiedAt               int64  `json:"modifiedAt"`
	Format                   string `json:"format"`
	Sensitive                bool   `json:"sensitive"`
	Editable                 bool   `json:"editable"`
	SchemaID                 string `json:"schemaId"`
	SchemaTitle              string `json:"schemaTitle"`
	SchemaFieldCount         int    `json:"schemaFieldCount"`
	SchemaVerifiedCLIVersion string `json:"schemaVerifiedCliVersion"`
	Description              string `json:"description"`
	DocsURL                  string `json:"docsUrl"`
	CanCreate                bool   `json:"canCreate"`
}

type resolvedFile struct {
	Definition   FileDefinition
	Public       PublicFile
	AbsolutePath string
	Writable     bool
}

var builtinFileDefinitions = []FileDefinition{
	// ---------------- Codex ----------------
	{
		Provider:    "codex",
		ID:          "config",
		Label:       "config.toml",
		Location:    FileLocation{Kind: "provider-root", Parts: []string{"config.toml"}},
		Format:      "toml",
		SchemaID:    "codex.config",
		Editable:    true,
		Description: "Codex CLI 主配置：模型、审批策略、沙箱、MCP、profiles 与通知。",
		DocsURL:     "https://developers.openai.com/codex/config-reference",
	},
	{
		Provider:    "codex",
		ID:          "auth",
		Label:       "auth.json",
		Location:    FileLocation{Kind: "home", Parts: []string{".codex", "auth.json"}},
		Format:      "json",
		SchemaID:    "codex.auth",
		Sensitive:   true,
		Editable:    true,
		Description: "ChatGPT 登录态与 API Key。包含 token，编辑前请确认当前环境。",
		DocsURL:     "https://developers.openai.com/codex/auth",
	},
	{
		Provider:    "codex",
		ID:          "hooks",
		Label:       "hooks.json",
		Location:    FileLocation{Kind: "home", Parts: []string{".codex", "hooks.json"}},
		Format:      "json",
		Editable:    true,
		Description: "Codex 生命周期 Hook 配置（SessionStart / UserPromptSubmit / Stop 等）。",
		DocsURL:     "https://developers.openai.com/codex/hooks",
	},

	// ---------------- Claude ----------------
	{
		Provider:    "claude",
		ID:          "settings",
		Label:       "settings.json",
		Location:    FileLocation{Kind: "provider-root", Parts: []string{"settings.json"}},
		Format:      "json",
		SchemaID:    "claude.settings",
		Editable:    true,
		Description: "Claude Code 用户设置：模型、权限、Hook、状态栏与环境变量。",
		DocsURL:     "https://code.claude.com/docs/en/settings",
	},
	{
		Provider:     "claude",
		ID:           "credentials",
		Label:        ".credentials.json",
		Location:     FileLocation{Kind: "home", Parts: []string{".claude", ".credentials.json"}},
		Alternatives: []FileLocation{{Kind: "home", Parts: []string{".claude", "credentials.json"}}},
		Format:       "json",
		SchemaID:     "claude.credentials",
		Sensitive:    true,
		Editable:     true,
		Description:  "Claude OAuth 凭据。通常由 CLI 自动维护，只在必要时手动修复。",
		DocsURL:      "https://code.claude.com/docs/en/authentication",
	},

	// ---------------- Gemini ----------------
	{
		Provider:    "gemini",
		ID:          "settings",
		Label:       "settings.json",
		Location:    FileLocation{Kind: "provider-root", Parts: []string{"settings.json"}},
		Format:      "json",
		SchemaID:    "gemini.settings",
		Editable:    true,
		Description: "Gemini CLI 设置：UI、模型、工具、上下文、MCP 与安全策略。",
		DocsURL:     "https://geminicli.com/docs/cli/settings/",
	},
	{
		Provider:    "gemini",
		ID:          "oauth",
		Label:       "oauth_creds.json",
		Location:    FileLocation{Kind: "home", Parts: []string{".gemini", "oauth_creds.json"}},
		Format:      "json",
		SchemaID:    "gemini.oauth",
		Sensitive:   true,
		Editable:    true,
		Description: "Google OAuth 凭据（个人登录态）。包含访问令牌与刷新令牌。",
		DocsURL:     "https://geminicli.com/docs/get-started/authentication/",
	},
	{
		Provider:    "gemini",
		ID:          "accounts",
		Label:       "google_accounts.json",
		Location:    FileLocation{Kind: "home", Parts: []string{".gemini", "google_accounts.json"}},
		Format:      "json",
		Editable:    true,
		Description: "Gemini CLI 记录的 Google 账号列表（用于账号切换）。",
		DocsURL:     "https://geminicli.com/docs/get-started/authentication/",
	},

	// ---------------- Antigravity (agy) ----------------
	{
		Provider:    "agy",
		ID:          "settings",
		Label:       "settings.json",
		Location:    FileLocation{Kind: "home", Parts: []string{".gemini", "antigravity-cli", "settings.json"}},
		Format:      "json",
		SchemaID:    "agy.settings",
		Editable:    true,
		Description: "Antigravity CLI 设置：模型、状态栏、工具权限与受信任工作区。",
		DocsURL:     "https://antigravity.google/docs/cli",
	},
	{
		Provider:    "agy",
		ID:          "hooks",
		Label:       "hooks.json",
		Location:    FileLocation{Kind: "home", Parts: []string{".gemini", "antigravity-cli", "hooks.json"}},
		Format:      "json",
		Editable:    true,
		Description: "Antigravity CLI 生命周期 Hook 配置。",
		DocsURL:     "https://antigravity.google/docs/cli",
	},

	// ---------------- OpenCode ----------------
	{
		Provider:     "opencode",
		ID:           "config",
		Label:        "opencode.json",
		Location:     FileLocation{Kind: "provider-root", Parts: []string{"opencode.json"}},
		Alternatives: []FileLocation{{Kind: "provider-root", Parts: []string{"opencode.jsonc"}}},
		Format:       "jsonc",
		SchemaID:     "opencode.config",
		Editable:     true,
		Description:  "OpenCode 主配置：默认模型、Provider、Agent、权限、MCP、LSP 与格式化。",
		DocsURL:      "https://opencode.ai/docs/config/",
	},
	{
		Provider:    "opencode",
		ID:          "auth",
		Label:       "auth.json",
		Location:    FileLocation{Kind: "xdg-data", Parts: []string{"opencode", "auth.json"}},
		Format:      "json",
		SchemaID:    "opencode.auth",
		Sensitive:   true,
		Editable:    true,
		Description: "OpenCode Provider 凭据（API Key / OAuth）。",
		DocsURL:     "https://opencode.ai/docs/providers/",
	},

	// ---------------- Grok ----------------
	{
		Provider:    "grok",
		ID:          "config",
		Label:       "config.toml",
		Location:    FileLocation{Kind: "provider-root", Parts: []string{"config.toml"}},
		Format:      "toml",
		SchemaID:    "grok.config",
		Editable:    true,
		Description: "Grok Build 主配置：模型、Agent、沙箱、MCP、权限与终端行为。",
		DocsURL:     "",
	},
	{
		Provider:    "grok",
		ID:          "auth",
		Label:       "auth.json",
		Location:    FileLocation{Kind: "provider-root", Parts: []string{"auth.json"}},
		Format:      "json",
		Sensitive:   true,
		Editable:    true,
		Description: "Grok 登录态与 API 凭据。",
		DocsURL:     "",
	},

	// ---------------- Qoder ----------------
	{
		Provider:    "qoder",
		ID:          "config",
		Label:       "config.json",
		Location:    FileLocation{Kind: "provider-root", Parts: []string{"config.json"}},
		Format:      "json",
		Editable:    true,
		Description: "Qoder CLI 配置。",
		DocsURL:     "https://docs.qoder.com/",
	},
	{
		Provider:    "qoder",
		ID:          "credentials",
		Label:       "qoder-cli-credentials.json",
		Location:    FileLocation{Kind: "provider-root", Parts: []string{"qoder-cli-credentials.json"}},
		Format:      "json",
		Sensitive:   true,
		Editable:    true,
		Description: "Qoder CLI 登录凭据（由 CLI 加密/维护）。",
		DocsURL:     "https://docs.qoder.com/",
	},
	{
		Provider:    "qodercn",
		ID:          "config",
		Label:       "config.json",
		Location:    FileLocation{Kind: "provider-root", Parts: []string{"config.json"}},
		Format:      "json",
		Editable:    true,
		Description: "Qoder（国内站）CLI 配置。",
		DocsURL:     "https://docs.qoder.com.cn/",
	},
	{
		Provider:    "qodercn",
		ID:          "credentials",
		Label:       "qoder-cli-cn-credentials.json",
		Location:    FileLocation{Kind: "provider-root", Parts: []string{"qoder-cli-cn-credentials.json"}},
		Format:      "json",
		Sensitive:   true,
		Editable:    true,
		Description: "Qoder（国内站）CLI 登录凭据。",
		DocsURL:     "https://docs.qoder.com.cn/",
	},

	// ---------------- Kimi ----------------
	{
		Provider:    "kimi",
		ID:          "config",
		Label:       "config.toml",
		Location:    FileLocation{Kind: "provider-root", Parts: []string{"config.toml"}},
		Format:      "toml",
		Editable:    true,
		Description: "Kimi Code CLI 配置：默认模型、Provider、思考模式与服务端点。",
		DocsURL:     "https://platform.moonshot.cn/docs/",
	},
	{
		Provider:    "kimi",
		ID:          "credentials",
		Label:       "credentials/kimi-code.json",
		Location:    FileLocation{Kind: "home", Parts: []string{".kimi-code", "credentials", "kimi-code.json"}},
		Format:      "json",
		Sensitive:   true,
		Editable:    true,
		Description: "Kimi Code OAuth 凭据（refresh_token 轮换）。",
		DocsURL:     "https://platform.moonshot.cn/docs/",
	},

	// ---------------- Kiro ----------------
	{
		Provider:    "kiro",
		ID:          "config",
		Label:       "config.json",
		Location:    FileLocation{Kind: "provider-root", Parts: []string{"config.json"}},
		Format:      "json",
		Editable:    true,
		Description: "Kiro CLI 配置。",
		DocsURL:     "https://kiro.dev/docs/",
	},
	{
		Provider:    "kiro",
		ID:          "mcp",
		Label:       "settings/mcp.json",
		Location:    FileLocation{Kind: "provider-root", Parts: []string{"settings", "mcp.json"}},
		Format:      "json",
		Editable:    true,
		Description: "Kiro MCP 服务器配置。",
		DocsURL:     "https://kiro.dev/docs/mcp/",
	},

	// ---------------- ZCode ----------------
	{
		Provider:    "zcode",
		ID:          "setting",
		Label:       "v2/setting.json",
		Location:    FileLocation{Kind: "provider-root", Parts: []string{"v2", "setting.json"}},
		Format:      "json",
		Editable:    true,
		Description: "ZCode 桌面端设置：模型 Provider、区域、窗口与功能开关。",
		DocsURL:     "https://z.ai/docs",
	},
	{
		Provider:    "zcode",
		ID:          "config",
		Label:       "v2/config.json",
		Location:    FileLocation{Kind: "provider-root", Parts: []string{"v2", "config.json"}},
		Format:      "json",
		Editable:    true,
		Description: "ZCode 运行时配置（Provider、模型与工作区）。",
		DocsURL:     "https://z.ai/docs",
	},
	{
		Provider:    "zcode",
		ID:          "credentials",
		Label:       "v2/credentials.json",
		Location:    FileLocation{Kind: "provider-root", Parts: []string{"v2", "credentials.json"}},
		Format:      "json",
		Sensitive:   true,
		Editable:    true,
		Description: "ZCode 登录凭据。",
		DocsURL:     "https://z.ai/docs",
	},

	// ---------------- CodeBuddy ----------------
	{
		Provider:    "codebuddy",
		ID:          "settings",
		Label:       "settings.json",
		Location:    FileLocation{Kind: "provider-root", Parts: []string{"settings.json"}},
		Format:      "json",
		Editable:    true,
		Description: "CodeBuddy CLI 设置：插件、MCP 与运行时开关。",
		DocsURL:     "https://www.codebuddy.ai/docs",
	},
	{
		Provider:    "codebuddycn",
		ID:          "settings",
		Label:       "settings.json",
		Location:    FileLocation{Kind: "provider-root", Parts: []string{"settings.json"}},
		Format:      "json",
		Editable:    true,
		Description: "CodeBuddy（国内站）CLI 设置。",
		DocsURL:     "https://www.codebuddy.cn/docs",
	},

	// ---------------- WorkBuddy ----------------
	{
		Provider:    "workbuddy",
		ID:          "settings",
		Label:       "settings.json",
		Location:    FileLocation{Kind: "provider-root", Parts: []string{"settings.json"}},
		Format:      "json",
		Editable:    true,
		Description: "WorkBuddy CLI 设置。",
		DocsURL:     "https://www.workbuddy.ai/docs",
	},
	{
		Provider:    "workbuddycn",
		ID:          "settings",
		Label:       "settings.json",
		Location:    FileLocation{Kind: "provider-root", Parts: []string{"settings.json"}},
		Format:      "json",
		Editable:    true,
		Description: "WorkBuddy（国内站）CLI 设置。",
		DocsURL:     "https://www.workbuddy.cn/docs",
	},

	// ---------------- Cline ----------------
	{
		Provider:    "cline",
		ID:          "providers",
		Label:       "data/settings/providers.json",
		Location:    FileLocation{Kind: "home", Parts: []string{".cline", "data", "settings", "providers.json"}},
		Format:      "json",
		Sensitive:   true,
		Editable:    true,
		Description: "Cline 账号与 Provider 登录态（CLI 与宿主共享）。",
		DocsURL:     "https://docs.cline.bot/",
	},
	{
		Provider:    "cline",
		ID:          "secrets",
		Label:       "data/secrets.json",
		Location:    FileLocation{Kind: "home", Parts: []string{".cline", "data", "secrets.json"}},
		Format:      "json",
		Sensitive:   true,
		Editable:    true,
		Description: "Cline 密钥存储。",
		DocsURL:     "https://docs.cline.bot/",
	},
}

func splitRelParts(value string) []string {
	trimmed := strings.Trim(value, "/\\")
	if trimmed == "" {
		return nil
	}
	normalized := strings.ReplaceAll(trimmed, "\\", "/")
	var parts []string
	for _, p := range strings.Split(normalized, "/") {
		if p != "" {
			parts = append(parts, p)
		}
	}
	return parts
}

func formatFromParts(parts []string) string {
	if len(parts) == 0 {
		return "text"
	}
	ext := strings.ToLower(filepath.Ext(parts[len(parts)-1]))
	if f, ok := formatByExt[ext]; ok {
		return f
	}
	return "text"
}

func configHomeFor(hostHome string, env map[string]string) string {
	if v := strings.TrimSpace(env["XDG_CONFIG_HOME"]); v != "" {
		return v
	}
	if runtime.GOOS == "windows" {
		if v := strings.TrimSpace(env["APPDATA"]); v != "" {
			return v
		}
		return filepath.Join(hostHome, "AppData", "Roaming")
	}
	return filepath.Join(hostHome, ".config")
}

func dataHomeFor(hostHome string, env map[string]string) string {
	if v := strings.TrimSpace(env["XDG_DATA_HOME"]); v != "" {
		return v
	}
	if runtime.GOOS == "windows" {
		if v := strings.TrimSpace(env["LOCALAPPDATA"]); v != "" {
			return v
		}
		return filepath.Join(hostHome, "AppData", "Local")
	}
	return filepath.Join(hostHome, ".local", "share")
}

func resolveProviderRoot(catalog *providers.Catalog, provider, hostHome string, env map[string]string) string {
	if hostHome == "" {
		return ""
	}
	var globalDir, configSubDir string
	if catalog != nil {
		if def, ok := catalog.Get(provider); ok && def.CLI != nil {
			globalDir = strings.TrimSpace(def.CLI.GlobalDir)
			configSubDir = strings.TrimSpace(def.CLI.ConfigSubDir)
		}
	}
	if globalDir == "" {
		globalDir = "." + provider
	}
	parts := splitRelParts(globalDir)
	var root string
	if len(parts) > 0 && parts[0] == ".config" {
		joined := append([]string{configHomeFor(hostHome, env)}, parts[1:]...)
		root = filepath.Join(joined...)
	} else {
		joined := append([]string{hostHome}, parts...)
		root = filepath.Join(joined...)
	}
	if configSubDir != "" {
		sub := splitRelParts(configSubDir)
		joined := append([]string{root}, sub...)
		root = filepath.Join(joined...)
	}
	return root
}

func resolveLocationPath(catalog *providers.Catalog, defaultProvider string, loc FileLocation, hostHome string, env map[string]string) string {
	switch loc.Kind {
	case "home":
		if hostHome == "" {
			return ""
		}
		return filepath.Join(append([]string{hostHome}, loc.Parts...)...)
	case "xdg-data":
		return filepath.Join(append([]string{dataHomeFor(hostHome, env)}, loc.Parts...)...)
	case "xdg-config":
		return filepath.Join(append([]string{configHomeFor(hostHome, env)}, loc.Parts...)...)
	case "provider-root":
		owner := loc.Provider
		if owner == "" {
			owner = defaultProvider
		}
		root := resolveProviderRoot(catalog, owner, hostHome, env)
		if root == "" {
			return ""
		}
		return filepath.Join(append([]string{root}, loc.Parts...)...)
	default:
		root := resolveProviderRoot(catalog, defaultProvider, hostHome, env)
		if root == "" {
			return ""
		}
		return filepath.Join(append([]string{root}, loc.Parts...)...)
	}
}

func displayPath(absPath, hostHome string) string {
	if absPath == "" {
		return ""
	}
	if hostHome != "" {
		if absPath == hostHome {
			return "~"
		}
		prefix := hostHome + string(filepath.Separator)
		if strings.HasPrefix(absPath, prefix) {
			return "~" + absPath[len(hostHome):]
		}
	}
	return absPath
}

func listProviderDefinitions(catalog *providers.Catalog, provider string) []FileDefinition {
	id := strings.ToLower(strings.TrimSpace(provider))
	if id == "" {
		return nil
	}
	var out []FileDefinition
	for _, def := range builtinFileDefinitions {
		if def.Provider == id {
			out = append(out, def)
		}
	}
	if len(out) > 0 {
		return out
	}
	if catalog == nil {
		return nil
	}
	catDef, ok := catalog.Get(id)
	if !ok || catDef.CLI == nil || strings.TrimSpace(catDef.CLI.ConfigFile) == "" {
		return nil
	}
	parts := splitRelParts(catDef.CLI.ConfigFile)
	if len(parts) == 0 {
		return nil
	}
	label := parts[len(parts)-1]
	menuLabel := catDef.Presentation.Label
	if menuLabel == "" {
		menuLabel = catDef.ID
	}
	return []FileDefinition{{
		Provider:    id,
		ID:          "config",
		Label:       label,
		Location:    FileLocation{Kind: "provider-root", Provider: id, Parts: parts},
		Format:      formatFromParts(parts),
		Editable:    true,
		Description: fmt.Sprintf("%s 的主配置文件。", menuLabel),
		Synthetic:   true,
	}}
}

func getProviderDefinition(catalog *providers.Catalog, provider, fileID string) (FileDefinition, bool) {
	fid := strings.TrimSpace(fileID)
	if fid == "" {
		return FileDefinition{}, false
	}
	for _, def := range listProviderDefinitions(catalog, provider) {
		if def.ID == fid {
			return def, true
		}
	}
	return FileDefinition{}, false
}

func describeDefinition(catalog *providers.Catalog, def FileDefinition, hostHome string, env map[string]string) resolvedFile {
	locs := append([]FileLocation{def.Location}, def.Alternatives...)
	var candidates []string
	for _, loc := range locs {
		if p := resolveLocationPath(catalog, def.Provider, loc, hostHome, env); p != "" {
			candidates = append(candidates, p)
		}
	}
	chosen := ""
	exists := false
	var stat os.FileInfo
	for _, c := range candidates {
		if info, err := os.Stat(c); err == nil {
			chosen = c
			exists = true
			stat = info
			break
		}
	}
	if !exists && len(candidates) > 0 {
		chosen = candidates[0]
	}
	var size int64
	var modifiedAt int64
	if exists && stat != nil && !stat.IsDir() {
		size = stat.Size()
		modifiedAt = stat.ModTime().UnixMilli()
	}
	format := def.Format
	if format == "" {
		format = formatFromParts([]string{chosen})
	}
	var schemaTitle, verifiedVer string
	var schemaFieldCount int
	if def.SchemaID != "" {
		if s := GetConfigSchema(def.SchemaID); s != nil {
			schemaTitle = s.Title
			schemaFieldCount = len(s.Fields)
			verifiedVer = s.VerifiedCLIVersion
		}
	}
	return resolvedFile{
		Definition:   def,
		AbsolutePath: chosen,
		Writable:     isWritableTarget(chosen),
		Public: PublicFile{
			Provider:                 def.Provider,
			ID:                       def.ID,
			Label:                    def.Label,
			DisplayPath:              displayPath(chosen, hostHome),
			Exists:                   exists,
			Size:                     size,
			ModifiedAt:               modifiedAt,
			Format:                   format,
			Sensitive:                def.Sensitive,
			Editable:                 def.Editable && size <= maxEditableBytes,
			SchemaID:                 def.SchemaID,
			SchemaTitle:              schemaTitle,
			SchemaFieldCount:         schemaFieldCount,
			SchemaVerifiedCLIVersion: verifiedVer,
			Description:              def.Description,
			DocsURL:                  def.DocsURL,
			CanCreate:                !exists,
		},
	}
}
