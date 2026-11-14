package webuiopenappapi

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/hostapps"
	"github.com/madou1217/ai_home/internal/adapters/kimi/desktopsession"
	"github.com/madou1217/ai_home/internal/runtime/codexhooks"
	"github.com/madou1217/ai_home/internal/runtime/storagepolicy"
)

const (
	defaultOpenAIBaseURL = "https://api.openai.com/v1"

	kimiTokenOrigin     = "https://www.kimi.com"
	kimiEncryptionTag   = "safeStorage.v1"
	kimiMinEncStoreSize = 128

	claudeGatewayProfile3p = "Claude-3p"
	codebuddyIdeExtID      = "ai-home.aih-native-session-bridge"
)

var (
	uuidV4Pattern      = regexp.MustCompile(`^[a-f0-9-]{36}$`)
	codebuddyUIDRegexp = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	codebuddyDotRegexp = regexp.MustCompile(`^\.[A-Za-z0-9_-]+$`)
)

type desktopPrepContext struct {
	ctx                  context.Context
	deps                 NativeLauncherDependencies
	req                  Request
	snapshot             AccountSnapshot
	catalogDef           providers.Definition
	hasCatalogDef        bool
	profileDir           string
	userDataDir          string
	applicationName      string
	hostHomeDir          string
	aiHomeDir            string
	repoRoot             string
	platformKey          string // "darwin" | "windows" | "linux"
	egress               EgressResolution
	egressPrepared       bool
	rollback             *fileRollback
	envMap               map[string]envEntry
	extraArgs            []string
	requiresRestart      bool
	reuseRunningInstance bool
	restartFailedError   string
	resolved             DesktopAppRecord
	baseEnv              []string
}

func newDesktopPrepContext(
	ctx context.Context,
	deps NativeLauncherDependencies,
	req Request,
	snapshot AccountSnapshot,
	profileDir string,
	userDataDir string,
	applicationName string,
	hostHomeDir string,
	platformKey string,
	baseEnv []string,
) *desktopPrepContext {
	reuseRunning := true
	restartFailedErr := "desktop_restart_failed"
	if strings.EqualFold(req.Provider, "kimi") {
		reuseRunning = false
		restartFailedErr = "kimi_desktop_restart_failed"
	}
	var def providers.Definition
	var hasDef bool
	if deps.Catalog != nil {
		def, hasDef = deps.Catalog.Get(req.Provider)
	}
	return &desktopPrepContext{
		ctx:                  ctx,
		deps:                 deps,
		req:                  req,
		snapshot:             snapshot,
		catalogDef:           def,
		hasCatalogDef:        hasDef,
		profileDir:           profileDir,
		userDataDir:          userDataDir,
		applicationName:      applicationName,
		hostHomeDir:          hostHomeDir,
		aiHomeDir:            deps.AIHomeDir,
		repoRoot:             deps.RepoRoot,
		platformKey:          platformKey,
		rollback:             newFileRollback(),
		envMap:               envSliceToMap(baseEnv),
		reuseRunningInstance: reuseRunning,
		restartFailedError:   restartFailedErr,
		baseEnv:              baseEnv,
	}
}

func (p *desktopPrepContext) setEnv(key, value string) {
	if p == nil || strings.TrimSpace(key) == "" {
		return
	}
	setEnvKey(p.envMap, key, value)
}

func (p *desktopPrepContext) deleteEnv(key string) {
	if p == nil || strings.TrimSpace(key) == "" {
		return
	}
	deleteEnvKey(p.envMap, key)
}

func (p *desktopPrepContext) decorateBaseEnv() {
	if p == nil {
		return
	}
	if p.hasCatalogDef && p.catalogDef.CLI != nil && p.catalogDef.CLI.DesktopClient != nil {
		if key := strings.TrimSpace(p.catalogDef.CLI.DesktopClient.UserDataEnvKey); key != "" {
			p.setEnv(key, p.userDataDir)
		}
	}
	p.setEnv("AIH_ACCOUNT_APP", "1")
	if p.req.AccountRef != "" {
		p.setEnv("AIH_PROVIDER_ACCOUNT_REF", p.req.AccountRef)
	}
	if p.aiHomeDir != "" {
		p.setEnv("AIH_HOME_DIR", p.aiHomeDir)
	}

	switch strings.ToLower(strings.TrimSpace(p.req.Provider)) {
	case "codex":
		p.decorateCodexBaseEnv()
	case "agy":
		p.decorateAgyBaseEnv()
	case "zcode":
		p.decorateZcodeBaseEnv()
	case "codebuddy", "codebuddycn", "workbuddy", "workbuddycn":
		p.decorateCodebuddyFamilyBaseEnv()
	case "kimi":
		p.setEnv("KIMI_CODE_HOME", filepath.Join(p.profileDir, ".kimi-code"))
		if p.hostHomeDir != "" {
			p.setEnv("HOME", p.hostHomeDir)
			p.setEnv("USERPROFILE", p.hostHomeDir)
			p.applySharedCacheEnv()
		}
	case "claude":
		configRoot := p.hostHomeDir
		if configRoot == "" {
			configRoot = p.profileDir
		}
		p.setEnv("CLAUDE_CONFIG_DIR", filepath.Join(configRoot, ".claude"))
		p.setEnv("HOME", p.profileDir)
		p.setEnv("USERPROFILE", p.profileDir)
		p.applySharedCacheEnv()
	default:
		p.setEnv("HOME", p.profileDir)
		p.setEnv("USERPROFILE", p.profileDir)
		p.setEnv("XDG_CONFIG_HOME", p.profileDir)
		p.setEnv("XDG_DATA_HOME", filepath.Join(p.profileDir, ".local", "share"))
		p.setEnv("XDG_STATE_HOME", filepath.Join(p.profileDir, ".local", "state"))
		p.applySharedCacheEnv()
	}
}

func (p *desktopPrepContext) applySharedCacheEnv() {
	if strings.TrimSpace(p.hostHomeDir) == "" {
		return
	}
	p.setEnv("XDG_CACHE_HOME", filepath.Join(p.hostHomeDir, ".cache"))
	p.setEnv("CARGO_HOME", filepath.Join(p.hostHomeDir, ".cargo"))
	p.setEnv("GOPATH", filepath.Join(p.hostHomeDir, "go"))
	p.setEnv("GOMODCACHE", filepath.Join(p.hostHomeDir, "go", "pkg", "mod"))
	p.setEnv("GOCACHE", filepath.Join(p.hostHomeDir, ".cache", "go-build"))
	p.setEnv("npm_config_cache", filepath.Join(p.hostHomeDir, ".npm"))
}

func (p *desktopPrepContext) decorateCodexBaseEnv() {
	if p.aiHomeDir != "" {
		for k, v := range codexhooks.ReadDesktopLaunchEnv(p.aiHomeDir) {
			p.setEnv(k, v)
		}
	}
	p.setEnv("CODEX_ELECTRON_USER_DATA_PATH", p.userDataDir)
	if _, _, isAPIKey := extractCodexAPIKey(p.snapshot); isAPIKey {
		p.setEnv("CODEX_HOME", filepath.Join(p.profileDir, ".codex"))
	} else {
		p.setEnv("HOME", p.profileDir)
		p.setEnv("USERPROFILE", p.profileDir)
		p.setEnv("CODEX_HOME", filepath.Join(p.profileDir, ".codex"))
		if p.hostHomeDir != "" {
			p.setEnv("CODEX_SQLITE_HOME", filepath.Join(p.hostHomeDir, ".codex"))
		}
		p.applySharedCacheEnv()
	}
}

func (p *desktopPrepContext) decorateAgyBaseEnv() {
	p.setEnv("HOME", p.profileDir)
	p.setEnv("USERPROFILE", p.profileDir)
	p.applySharedCacheEnv()

	runtimeHome := ""
	if p.hostHomeDir != "" {
		runtimeHome = storagepolicy.ResolveRuntimeHomeRoot(p.hostHomeDir, "agy")
	}
	if runtimeHome == "" {
		runtimeHome = filepath.Join(p.profileDir, ".agy-runtime")
	}
	p.setEnv("XDG_CONFIG_HOME", filepath.Join(runtimeHome, "xdg", "config"))
	p.setEnv("XDG_DATA_HOME", filepath.Join(runtimeHome, "xdg", "data"))
	p.setEnv("XDG_STATE_HOME", filepath.Join(runtimeHome, "xdg", "state"))
	p.setEnv("XDG_CACHE_HOME", filepath.Join(runtimeHome, "xdg", "cache"))
	p.setEnv("GEMINI_CLI_SYSTEM_SETTINGS_PATH", filepath.Join(runtimeHome, ".gemini", "settings.json"))
	if p.platformKey == "windows" {
		p.setEnv("APPDATA", filepath.Join(runtimeHome, "AppData", "Roaming"))
		p.setEnv("LOCALAPPDATA", filepath.Join(runtimeHome, "AppData", "Local"))
	}

	// 强制 AGY 使用文件凭据投影而非共享 macOS Keychain。
	p.setEnv("SSH_CONNECTION", "127.0.0.1 12345 127.0.0.1 22")
	p.setEnv("SSH_CLIENT", "127.0.0.1 12345 22")
	p.setEnv("SSH_TTY", "/dev/tty")
	p.setEnv("container", "docker")
	p.setEnv("WSL_DISTRO_NAME", "Ubuntu")
}

func (p *desktopPrepContext) decorateZcodeBaseEnv() {
	p.setEnv("ZCODE_DATA_BASE_DIR", p.profileDir)
	p.setEnv("ZCODE_HOME", filepath.Join(p.profileDir, ".zcode"))
	p.setEnv("ZCODE_CREDENTIAL_SECRET", resolveZcodeSecretForHost(p.hostHomeDir, p.baseEnv))
	// 只改 HOME；Windows 上改 USERPROFILE 会导致 ZCode 主进程静默卡死。
	p.setEnv("HOME", p.profileDir)
	if p.applicationName != "" {
		p.setEnv(zcodeDesktopApplicationNameEnv, p.applicationName)
	}
}

func (p *desktopPrepContext) decorateCodebuddyFamilyBaseEnv() {
	p.setEnv("HOME", p.profileDir)
	p.setEnv("USERPROFILE", p.profileDir)
	p.setEnv("XDG_CONFIG_HOME", p.profileDir)
	p.setEnv("XDG_DATA_HOME", filepath.Join(p.profileDir, ".local", "share"))
	p.setEnv("XDG_STATE_HOME", filepath.Join(p.profileDir, ".local", "state"))
	p.applySharedCacheEnv()

	configDirNames := map[string]string{
		"codebuddy":   ".codebuddy",
		"codebuddycn": ".codebuddy-cn",
		"workbuddy":   ".workbuddy-ai",
		"workbuddycn": ".workbuddy",
	}
	provider := strings.ToLower(strings.TrimSpace(p.req.Provider))
	dirName := configDirNames[provider]
	if dirName == "" {
		dirName = ".codebuddy"
	}
	configDir := filepath.Join(p.profileDir, dirName)
	p.setEnv("CODEBUDDY_CONFIG_DIR", configDir)
	if strings.HasPrefix(provider, "workbuddy") {
		p.setEnv("WORKBUDDY_CONFIG_DIR", configDir)
	}

	p.deleteEnv("CODEBUDDY_API_KEY")
	p.deleteEnv("CODEBUDDY_BASE_URL")
	p.deleteEnv("CODEBUDDY_AUTH_TOKEN")
	if region := resolveCodebuddyInternetEnvironment(provider, p.snapshot); region != "" {
		p.setEnv("CODEBUDDY_INTERNET_ENVIRONMENT", region)
		p.setEnv("CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT", region)
	}
}

func (p *desktopPrepContext) prepareSession() *Result {
	if !strings.EqualFold(p.req.Provider, "kimi") {
		return nil
	}
	return p.prepareKimiSession()
}

func (p *desktopPrepContext) prepareProfile() *Result {
	switch strings.ToLower(strings.TrimSpace(p.req.Provider)) {
	case "codex":
		return p.prepareCodexProfile()
	case "claude":
		return p.prepareClaudeProfile()
	case "zcode":
		repairZcodeProjectionLinks(p.profileDir)
		if p.platformKey == "darwin" && p.egressPrepared {
			if errCode, err := applyZcodeNativeProxySettings(p.profileDir, p.egress, p.rollback); errCode != "" {
				reason := ""
				if err != nil {
					reason = err.Error()
				}
				return &Result{
					OK:      false,
					Error:   errCode,
					Reason:  reason,
					Message: launchErrorMessage(errCode),
				}
			}
		}
		return nil
	case "codebuddy", "codebuddycn", "workbuddy", "workbuddycn":
		return p.prepareCodebuddyKeychain()
	default:
		return nil
	}
}

func (p *desktopPrepContext) prepareResolvedLaunch() *Result {
	switch strings.ToLower(strings.TrimSpace(p.req.Provider)) {
	case "zcode":
		repairZcodeProjectionCredentialProfile(p.profileDir, p.hostHomeDir, p.baseEnv)
		if p.platformKey == "darwin" {
			shadowBundle, shadowExec, errCode, err := prepareZcodeShadowApp(
				p.ctx,
				p.aiHomeDir,
				p.repoRoot,
				p.resolved.BundlePath,
				p.resolved.ExecutablePath,
				p.deps.Runner,
			)
			if errCode != "" {
				reason := ""
				if err != nil {
					reason = err.Error()
				}
				return &Result{
					OK:      false,
					Error:   errCode,
					Reason:  reason,
					Message: launchErrorMessage(errCode),
				}
			}
			if shadowBundle != "" {
				p.resolved.BundlePath = shadowBundle
			}
			if shadowExec != "" {
				p.resolved.ExecutablePath = shadowExec
			}
			p.decorateZcodeResolvedEnv()
		}
	case "codebuddy", "codebuddycn":
		extDir, errCode, err := p.prepareCodebuddyIdeBridge()
		if errCode != "" {
			reason := ""
			if err != nil {
				reason = err.Error()
			}
			return &Result{
				OK:      false,
				Error:   errCode,
				Reason:  reason,
				Message: launchErrorMessage(errCode),
			}
		}
		if extDir != "" {
			p.extraArgs = append(p.extraArgs, "--extensions-dir="+extDir)
		}
	case "kiro":
		if p.isKiroNativeGUI() {
			if err := prepareKiroRuntimeHome(p.profileDir, p.hostHomeDir, p.platformKey); err != nil {
				return &Result{
					OK:      false,
					Error:   "kiro_desktop_profile_unavailable",
					Reason:  err.Error(),
					Message: launchErrorMessage("kiro_desktop_profile_unavailable"),
				}
			}
			p.decorateKiroNativeEnv()
		}
	}
	return nil
}

func (p *desktopPrepContext) decorateZcodeResolvedEnv() {
	if p.platformKey != "darwin" {
		return
	}
	fields := map[string]string{
		"captchaState": filepath.Join(p.profileDir, ".aih-runtime", "zcode-captcha-hook.json"),
		"scope":        p.req.AccountRef,
		"usageLog":     filepath.Join(p.profileDir, ".aih-runtime", "zcode-model-usage-owners.jsonl"),
	}
	if p.aiHomeDir != "" {
		fields["harnessStore"] = filepath.Join(p.aiHomeDir, "run", "zcode-harness-system.json")
	}
	if captureLog := resolveZcodeRequestCaptureLogPath(p.aiHomeDir); captureLog != "" {
		fields["requestLog"] = captureLog
	}
	if mailboxDir, identity := resolveZcodeBridgeDirs(p.profileDir, p.snapshot); mailboxDir != "" && identity != "" {
		fields["bridgeDir"] = mailboxDir
		fields["bridgeIdentity"] = identity
	}
	if encoded := encodeZcodeContext(fields); encoded != "" {
		p.setEnv("AIH_ZCODE_CONTEXT", encoded)
	}
	if p.resolved.BundlePath != "" && p.repoRoot != "" {
		if nodeExe := findNodeExecutable(p.baseEnv, p.platformKey); nodeExe != "" {
			if launcherPath, ok := ensureZcodeAgentLauncher(p.profileDir, nodeExe, p.repoRoot, p.resolved.BundlePath); ok {
				p.setEnv("ZCODE_AGENT_SERVER_COMMAND", launcherPath)
				p.setEnv("ZCODE_AGENT_SERVER_ARGS_JSON", `["app-server","--stdio"]`)
			}
		}
	}
}

func (p *desktopPrepContext) isKiroNativeGUI() bool {
	return p.platformKey == "darwin" && filepath.Base(strings.TrimSpace(p.resolved.ExecutablePath)) == "kiro_cli_desktop"
}

func (p *desktopPrepContext) decorateKiroNativeEnv() {
	p.setEnv("HOME", p.profileDir)
	p.setEnv("USERPROFILE", p.profileDir)
	if p.hostHomeDir != "" {
		p.setEnv("KIRO_HOME", filepath.Join(p.hostHomeDir, ".kiro"))
	} else {
		p.setEnv("KIRO_HOME", filepath.Join(p.profileDir, ".kiro"))
	}
	p.setEnv("KIRO_TEST_DB_PATH", filepath.Join(p.profileDir, "data.sqlite3"))
	p.setEnv("TMPDIR", filepath.Join(p.profileDir, "tmp")+string(filepath.Separator))
	p.setEnv("XDG_CONFIG_HOME", filepath.Join(p.profileDir, ".config"))
	p.setEnv("XDG_DATA_HOME", filepath.Join(p.profileDir, ".local", "share"))
	p.setEnv("XDG_STATE_HOME", filepath.Join(p.profileDir, ".local", "state"))
	p.applySharedCacheEnv()
	p.deleteEnv("KIRO_API_KEY")
}

func (p *desktopPrepContext) resolveSpawnPlan() SpawnSpec {
	env := applyAccountEgressProxyEnv(p.req.Provider, mapToEnvSlice(p.envMap), p.egress)
	if strings.EqualFold(p.req.Provider, "agy") && p.platformKey == "darwin" && p.resolved.BundlePath != "" {
		args := []string{"-n", "-a", p.resolved.BundlePath, "--args", "--user-data-dir=" + p.userDataDir}
		args = append(args, p.extraArgs...)
		args = decorateChromiumEgressArgs(p.req.Provider, args, p.egress)
		return SpawnSpec{
			File:        "/usr/bin/open",
			Args:        args,
			Dir:         p.profileDir,
			Env:         env,
			WindowsHide: false,
		}
	}
	if p.isKiroNativeGUI() {
		instanceName := p.applicationName
		if instanceName == "" {
			instanceName = hostapps.ApplicationName("kiro", p.req.AccountRef)
		}
		return SpawnSpec{
			File:        "/bin/bash",
			Args:        []string{"-c", `exec -a "$0" "$@"`, instanceName, p.resolved.ExecutablePath, "--allow-multiple"},
			Dir:         p.profileDir,
			Env:         env,
			WindowsHide: false,
		}
	}
	args := make([]string, 0, 1+len(p.extraArgs)+2)
	args = append(args, "--user-data-dir="+p.userDataDir)
	args = append(args, p.extraArgs...)
	args = decorateChromiumEgressArgs(p.req.Provider, args, p.egress)
	return SpawnSpec{
		File:        p.resolved.ExecutablePath,
		Args:        args,
		Dir:         p.profileDir,
		Env:         env,
		WindowsHide: false,
	}
}

func (p *desktopPrepContext) beforeSpawnHook() {
	if strings.EqualFold(p.req.Provider, "codex") && p.deps.CodexHooks != nil {
		if _, err := p.deps.CodexHooks.EnsureInstalled(); err != nil {
			p.warn("codex desktop hook install failed: " + err.Error())
		}
		res := p.deps.CodexHooks.SetDesktopAccountRef(p.req.AccountRef)
		if res.OK && res.Changed {
			_ = p.deps.CodexHooks.RestartRunningAppServers()
		}
	}
}

func (p *desktopPrepContext) warn(msg string) {
	if p.deps.Warn != nil && strings.TrimSpace(msg) != "" {
		p.deps.Warn(msg)
	}
}

func afterCloseDesktopProvider(
	ctx context.Context,
	deps NativeLauncherDependencies,
	req Request,
	snapshot AccountSnapshot,
	profileDir string,
	now time.Time,
) {
	switch strings.ToLower(strings.TrimSpace(req.Provider)) {
	case "codex":
		if deps.CodexHooks != nil {
			res := deps.CodexHooks.ClearDesktopAccountRef(req.AccountRef)
			if res.OK && res.Changed {
				_ = deps.CodexHooks.RestartRunningAppServers()
			}
		}
	case "zcode":
		captureZcodeAuthOnClose(ctx, deps.Accounts, profileDir, snapshot, now)
	}
}

// --- Codex Desktop API-Key Profile ---

func extractCodexAPIKey(snapshot AccountSnapshot) (apiKey string, baseURL string, ok bool) {
	if snapshot.Credential != nil {
		if auth, isAPIKey := snapshot.Credential.(*codex.APIKeyAuth); isAPIKey && auth != nil {
			return strings.TrimSpace(auth.APIKey()), strings.TrimSpace(auth.BaseURL()), strings.TrimSpace(auth.APIKey()) != ""
		}
	}
	if snapshot.APIKeyMode && len(snapshot.NativeAuthJSON) > 0 {
		var root map[string]any
		if json.Unmarshal(snapshot.NativeAuthJSON, &root) == nil && root != nil {
			key := stringField(root, "OPENAI_API_KEY", "apiKey")
			urlVal := stringField(root, "OPENAI_BASE_URL", "baseUrl", "base_url")
			if envMap, okMap := root["env"].(map[string]any); okMap {
				if key == "" {
					key = stringField(envMap, "OPENAI_API_KEY")
				}
				if urlVal == "" {
					urlVal = stringField(envMap, "OPENAI_BASE_URL")
				}
			}
			if urlVal == "" {
				urlVal = strings.TrimSpace(snapshot.BaseURL)
			}
			if key != "" {
				return key, urlVal, true
			}
		}
	}
	return "", "", false
}

func (p *desktopPrepContext) prepareCodexProfile() *Result {
	apiKey, baseURL, isAPIKey := extractCodexAPIKey(p.snapshot)
	if !isAPIKey {
		return nil
	}
	codexHome := filepath.Join(p.profileDir, ".codex")
	authPath := filepath.Join(codexHome, "auth.json")
	configPath := filepath.Join(codexHome, "config.toml")
	p.rollback.snapshot(authPath, configPath)

	if err := ensurePrivateDirectory(codexHome, "codex_desktop_profile_not_private"); err != nil {
		return &Result{
			OK:      false,
			Error:   "codex_desktop_profile_prepare_failed",
			Reason:  err.Error(),
			Message: launchErrorMessage("codex_desktop_profile_prepare_failed"),
		}
	}
	authDoc := map[string]any{
		"auth_mode":      "apikey",
		"OPENAI_API_KEY": apiKey,
		"tokens":         nil,
		"last_refresh":   nil,
	}
	if err := writeJSONAtomic(authPath, authDoc); err != nil {
		return &Result{
			OK:      false,
			Error:   "codex_desktop_profile_prepare_failed",
			Reason:  err.Error(),
			Message: launchErrorMessage("codex_desktop_profile_prepare_failed"),
		}
	}

	var hostConfig string
	if p.hostHomeDir != "" {
		if raw, err := os.ReadFile(filepath.Join(p.hostHomeDir, ".codex", "config.toml")); err == nil {
			hostConfig = string(raw)
		}
	}
	sqliteHome := ""
	if p.hostHomeDir != "" {
		sqliteHome = filepath.Join(p.hostHomeDir, ".codex")
	}
	if strings.TrimSpace(baseURL) == "" {
		baseURL = defaultOpenAIBaseURL
	}
	configText := buildCodexAPIKeyConfig(hostConfig, baseURL, sqliteHome)
	if err := writeBytesAtomic(configPath, []byte(configText), 0o600); err != nil {
		return &Result{
			OK:      false,
			Error:   "codex_desktop_profile_prepare_failed",
			Reason:  err.Error(),
			Message: launchErrorMessage("codex_desktop_profile_prepare_failed"),
		}
	}
	return nil
}

func buildCodexAPIKeyConfig(hostConfig, baseURL, sqliteHome string) string {
	// 去除宿主的 [model_providers.aih_server] 与管理标记行，固定用 openai + apikey。
	lines := strings.Split(strings.ReplaceAll(hostConfig, "\r\n", "\n"), "\n")
	filtered := make([]string, 0, len(lines))
	skipSection := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") {
			lowerSection := strings.ToLower(trimmed)
			if strings.HasPrefix(lowerSection, "[model_providers.aih_server") ||
				strings.HasPrefix(lowerSection, "[model_providers.openai") {
				skipSection = true
				continue
			}
			skipSection = false
		}
		if skipSection {
			continue
		}
		lower := strings.ToLower(trimmed)
		if strings.HasPrefix(lower, "preferred_auth_method") && strings.Contains(lower, "=") ||
			strings.HasPrefix(lower, "model_provider") && strings.Contains(lower, "=") ||
			strings.HasPrefix(lower, "openai_base_url") && strings.Contains(lower, "=") ||
			strings.HasPrefix(lower, "sqlite_home") && strings.Contains(lower, "=") {
			continue
		}
		filtered = append(filtered, line)
	}
	rootPrefix := []string{
		`preferred_auth_method = "apikey"`,
		`model_provider = "openai"`,
	}
	if strings.TrimSpace(sqliteHome) != "" {
		escaped := strings.ReplaceAll(sqliteHome, `"`, `\"`)
		rootPrefix = append(rootPrefix, `sqlite_home = "`+escaped+`"`)
	}
	body := strings.TrimSpace(strings.Join(filtered, "\n"))
	var b strings.Builder
	for _, line := range rootPrefix {
		b.WriteString(line)
		b.WriteByte('\n')
	}
	if body != "" {
		b.WriteString(body)
		b.WriteByte('\n')
	}
	escapedURL := strings.ReplaceAll(strings.TrimSpace(baseURL), `"`, `\"`)
	b.WriteString("\n[model_providers.openai]\n")
	b.WriteString(`name = "OpenAI"` + "\n")
	b.WriteString(`base_url = "` + escapedURL + `"` + "\n")
	b.WriteString(`wire_api = "responses"` + "\n")
	b.WriteString(`requires_openai_auth = true` + "\n")
	return b.String()
}

// --- Claude Desktop Gateway (Claude-3p) ---

func (p *desktopPrepContext) prepareClaudeProfile() *Result {
	profileDir := resolveClaudeDesktopGatewayDir(p.platformKey, p.hostHomeDir, p.baseEnv)
	if profileDir == "" || strings.TrimSpace(p.aiHomeDir) == "" {
		return nil
	}
	if p.repoRoot == "" {
		return nil
	}
	helperPath := filepath.Join(p.repoRoot, "bin", "claude-desktop-credential.js")
	if !pathExists(helperPath) {
		return &Result{
			OK:      false,
			Error:   "claude_gateway_prepare_failed",
			Reason:  "credential_helper_missing",
			Message: launchErrorMessage("claude_gateway_prepare_failed"),
		}
	}
	nodeExe := findNodeExecutable(p.baseEnv, p.platformKey)
	if nodeExe == "" {
		nodeExe = "node"
	}

	serverBaseURL := readServerConfigGatewayBaseURL(p.aiHomeDir)
	libraryDir := filepath.Join(profileDir, "configLibrary")
	metaPath := filepath.Join(libraryDir, "_meta.json")
	metaObj := map[string]any{"appliedId": "", "entries": []any{}}
	if raw, err := os.ReadFile(metaPath); err == nil && len(strings.TrimSpace(string(raw))) > 0 {
		if json.Unmarshal(raw, &metaObj) != nil || metaObj == nil {
			return &Result{
				OK:      false,
				Error:   "claude_gateway_prepare_failed",
				Reason:  "config_library_meta_invalid",
				Message: launchErrorMessage("claude_gateway_prepare_failed"),
			}
		}
	}
	entriesSlice, _ := metaObj["entries"].([]any)
	entryID := ""
	for _, rawEntry := range entriesSlice {
		entryMap, ok := rawEntry.(map[string]any)
		if !ok {
			continue
		}
		if stringField(entryMap, "name") == "ai-home API" {
			candidateID := stringField(entryMap, "id")
			if uuidV4Pattern.MatchString(candidateID) {
				entryID = candidateID
				break
			}
		}
	}
	if entryID == "" {
		entryID = generateUUIDv4()
		entriesSlice = append(entriesSlice, map[string]any{"id": entryID, "name": "ai-home API"})
	}
	metaObj["appliedId"] = entryID
	metaObj["entries"] = entriesSlice

	apiCfg := map[string]any{
		"inferenceProvider":             "gateway",
		"inferenceCredentialKind":       "helper-script",
		"inferenceGatewayBaseUrl":       serverBaseURL,
		"inferenceGatewayAuthScheme":    "bearer",
		"inferenceCredentialHelper":     nodeExe,
		"inferenceCredentialHelperArgs": []string{helperPath, "--ai-home-dir", p.aiHomeDir},
		"modelDiscoveryEnabled":         true,
	}
	if err := writeJSONAtomic(filepath.Join(libraryDir, entryID+".json"), apiCfg); err != nil {
		return &Result{OK: false, Error: "claude_gateway_prepare_failed", Reason: err.Error(), Message: launchErrorMessage("claude_gateway_prepare_failed")}
	}
	if err := writeJSONAtomic(metaPath, metaObj); err != nil {
		return &Result{OK: false, Error: "claude_gateway_prepare_failed", Reason: err.Error(), Message: launchErrorMessage("claude_gateway_prepare_failed")}
	}

	devPath := filepath.Join(profileDir, "developer_settings.json")
	devObj := map[string]any{}
	if raw, err := os.ReadFile(devPath); err == nil && len(strings.TrimSpace(string(raw))) > 0 {
		_ = json.Unmarshal(raw, &devObj)
	}
	devObj["allowDevTools"] = true
	if err := writeJSONAtomic(devPath, devObj); err != nil {
		return &Result{OK: false, Error: "claude_gateway_prepare_failed", Reason: err.Error(), Message: launchErrorMessage("claude_gateway_prepare_failed")}
	}

	desktopCfgPath := filepath.Join(profileDir, "claude_desktop_config.json")
	desktopObj := map[string]any{}
	if raw, err := os.ReadFile(desktopCfgPath); err == nil && len(strings.TrimSpace(string(raw))) > 0 {
		_ = json.Unmarshal(raw, &desktopObj)
	}
	desktopObj["deploymentMode"] = "3p"
	delete(desktopObj, "awaitingSignIn")
	if err := writeJSONAtomic(desktopCfgPath, desktopObj); err != nil {
		return &Result{OK: false, Error: "claude_gateway_prepare_failed", Reason: err.Error(), Message: launchErrorMessage("claude_gateway_prepare_failed")}
	}
	return nil
}

func resolveClaudeDesktopGatewayDir(platformKey, hostHomeDir string, baseEnv []string) string {
	home := strings.TrimSpace(hostHomeDir)
	if home == "" {
		return ""
	}
	switch platformKey {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", claudeGatewayProfile3p)
	case "windows":
		localAppData := firstEnvValue(envSliceToMap(baseEnv), "LOCALAPPDATA")
		if strings.TrimSpace(localAppData) == "" {
			localAppData = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(localAppData, claudeGatewayProfile3p)
	default:
		return ""
	}
}

func readServerConfigGatewayBaseURL(aiHomeDir string) string {
	port := 8080
	raw, err := os.ReadFile(filepath.Join(strings.TrimSpace(aiHomeDir), "server-config.json"))
	if err == nil {
		var cfg map[string]any
		if json.Unmarshal(raw, &cfg) == nil && cfg != nil {
			if p := int64Field(cfg, "port"); p > 0 && p <= 65535 {
				port = int(p)
			}
		}
	}
	return fmt.Sprintf("http://127.0.0.1:%d", port)
}

func generateUUIDv4() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// --- Kimi Desktop Managed Session ---

func (p *desktopPrepContext) prepareKimiSession() *Result {
	requiredAction := map[string]any{"kind": "desktop-login", "flow": "kimi-desktop-session"}
	warnAction := map[string]any{"kind": "desktop-login", "flow": "kimi-desktop-session", "warn": true}

	var session desktopsession.Session
	var hasSession bool
	if p.deps.KimiSessions != nil {
		s, found, err := p.deps.KimiSessions.ReadSession(p.ctx, p.req.AccountRef)
		if err == nil && found {
			session = s
			hasSession = true
		}
	}
	if !hasSession && len(p.snapshot.NativeAuthJSON) > 0 {
		if s, ok := parseKimiDesktopSessionFromJSON(p.snapshot.NativeAuthJSON); ok {
			session = s
			hasSession = true
		}
	}

	if adopted := p.adoptKimiTokensFromProfile(); adopted != nil && adopted.RefreshToken != "" {
		if !hasSession || adopted.RefreshToken != session.RefreshToken {
			session.AccessToken = adopted.AccessToken
			session.RefreshToken = adopted.RefreshToken
			if adopted.UserID != "" {
				session.UserID = adopted.UserID
			}
			session.UpdatedAtMS = p.deps.nowTime().UnixMilli()
			hasSession = true
			if p.deps.KimiSessions != nil {
				_ = p.deps.KimiSessions.WriteSession(p.ctx, p.req.AccountRef, session)
			}
		}
	}

	hasExistingStore := hasKimiDesktopTokenStore(p.userDataDir)
	if hasExistingStore && (hasSession && session.RefreshToken != "" && p.platformKey == "darwin" || p.platformKey == "darwin" && hasExistingStore) {
		return nil
	}
	if hasExistingStore && p.platformKey == "windows" {
		return nil
	}
	if !hasSession || (strings.TrimSpace(session.AccessToken) == "" && strings.TrimSpace(session.RefreshToken) == "") {
		if hasExistingStore {
			return nil
		}
		return &Result{
			OK:             false,
			Error:          "kimi_desktop_session_required",
			Message:        launchErrorMessage("kimi_desktop_session_required"),
			RequiredAction: requiredAction,
		}
	}

	if err := p.seedKimiDesktopTokenStore(session); err != nil {
		if hasExistingStore {
			return nil
		}
		return &Result{
			OK:             false,
			Error:          "kimi_desktop_session_seed_failed",
			Reason:         err.Error(),
			Message:        launchErrorMessage("kimi_desktop_session_seed_failed"),
			RequiredAction: warnAction,
		}
	}
	p.requiresRestart = true
	return nil
}

func parseKimiDesktopSessionFromJSON(raw json.RawMessage) (desktopsession.Session, bool) {
	var root map[string]any
	if json.Unmarshal(raw, &root) != nil || root == nil {
		return desktopsession.Session{}, false
	}
	ds, ok := root["desktopSession"].(map[string]any)
	if !ok || ds == nil {
		return desktopsession.Session{}, false
	}
	access := stringField(ds, "accessToken", "access_token")
	refresh := stringField(ds, "refreshToken", "refresh_token")
	userID := stringField(ds, "userId", "user_id")
	if access == "" && refresh == "" {
		return desktopsession.Session{}, false
	}
	return desktopsession.Session{
		AccessToken:  access,
		RefreshToken: refresh,
		UserID:       userID,
		UpdatedAtMS:  int64Field(ds, "updatedAtMs", "updated_at_ms"),
	}, true
}

func (p *desktopPrepContext) adoptKimiTokensFromProfile() *desktopsession.Session {
	if p.platformKey != "darwin" && p.platformKey != "windows" {
		return nil
	}
	storePath := filepath.Join(p.userDataDir, "bridge-store", "token-store.json")
	raw, err := os.ReadFile(storePath)
	if err != nil {
		return nil
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) != nil || obj == nil {
		return nil
	}
	if stringField(obj, "encryption") != kimiEncryptionTag {
		return parseKimiTokenStorePlaintext(raw)
	}
	if p.platformKey != "windows" {
		return nil
	}
	encData := stringField(obj, "data")
	if encData == "" {
		return nil
	}
	rawBlob, err := base64.StdEncoding.DecodeString(encData)
	if err != nil {
		return nil
	}
	aesKey := p.ensureKimiProfileAESKey()
	if len(aesKey) != 32 {
		return nil
	}
	plain := decryptChromiumV10(aesKey, rawBlob)
	if plain == "" {
		return nil
	}
	return parseKimiTokenStorePlaintext([]byte(plain))
}

func parseKimiTokenStorePlaintext(raw []byte) *desktopsession.Session {
	var obj map[string]any
	if json.Unmarshal(raw, &obj) != nil || obj == nil {
		return nil
	}
	tokens, ok := obj["tokens"].(map[string]any)
	if !ok || tokens == nil {
		return nil
	}
	access := stringField(tokens, "access_token")
	refresh := stringField(tokens, "refresh_token")
	if access == "" && refresh == "" {
		return nil
	}
	return &desktopsession.Session{
		AccessToken:  access,
		RefreshToken: refresh,
		UserID:       stringField(tokens, "msh_user_id"),
	}
}

func hasKimiDesktopTokenStore(userDataDir string) bool {
	storePath := filepath.Join(userDataDir, "bridge-store", "token-store.json")
	raw, err := os.ReadFile(storePath)
	if err != nil {
		return false
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) != nil || obj == nil {
		return false
	}
	if stringField(obj, "encryption") == kimiEncryptionTag {
		data := stringField(obj, "data")
		if data == "" {
			return false
		}
		decoded, decErr := base64.StdEncoding.DecodeString(data)
		return decErr == nil && len(decoded) >= kimiMinEncStoreSize
	}
	return parseKimiTokenStorePlaintext(raw) != nil
}

func (p *desktopPrepContext) seedKimiDesktopTokenStore(session desktopsession.Session) error {
	if strings.TrimSpace(session.AccessToken) == "" || strings.TrimSpace(session.RefreshToken) == "" {
		return errors.New("missing_params")
	}
	payloadObj := map[string]any{
		"origin": kimiTokenOrigin,
		"tokens": map[string]any{
			"refresh_token": session.RefreshToken,
			"access_token":  session.AccessToken,
			"msh_user_id":   session.UserID,
		},
	}
	payloadBytes, err := json.Marshal(payloadObj)
	if err != nil {
		return err
	}
	storePath := filepath.Join(p.userDataDir, "bridge-store", "token-store.json")
	switch p.platformKey {
	case "darwin":
		if err := writeBytesAtomic(storePath, payloadBytes, 0o600); err != nil {
			return err
		}
	case "windows":
		aesKey := p.ensureKimiProfileAESKey()
		if len(aesKey) != 32 {
			return errors.New("profile_key_unavailable")
		}
		encrypted, encErr := encryptChromiumV10(aesKey, payloadBytes)
		if encErr != nil {
			return encErr
		}
		wrapper := map[string]any{
			"encryption": kimiEncryptionTag,
			"data":       base64.StdEncoding.EncodeToString(encrypted),
		}
		if err := writeJSONAtomic(storePath, wrapper); err != nil {
			return err
		}
	default:
		return errors.New("unsupported_platform")
	}
	regionPath := filepath.Join(p.userDataDir, "bridge-store", "region.json")
	return writeJSONAtomic(regionPath, map[string]any{"lastEffective": "china"})
}

func (p *desktopPrepContext) ensureKimiProfileAESKey() []byte {
	localStatePath := filepath.Join(p.userDataDir, "Local State")
	localState := map[string]any{}
	if raw, err := os.ReadFile(localStatePath); err == nil {
		_ = json.Unmarshal(raw, &localState)
	}
	if osCrypt, ok := localState["os_crypt"].(map[string]any); ok && osCrypt != nil {
		if existing := stringField(osCrypt, "encrypted_key"); existing != "" {
			if out := p.dpapiUnprotectBase64(existing); len(out) == 32 {
				return out
			}
			return nil
		}
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil
	}
	protected := p.dpapiProtectBase64(base64.StdEncoding.EncodeToString(key))
	if protected == "" {
		return nil
	}
	protBytes, err := base64.StdEncoding.DecodeString(protected)
	if err != nil {
		return nil
	}
	wrapped := append([]byte("DPAPI"), protBytes...)
	osCrypt, _ := localState["os_crypt"].(map[string]any)
	if osCrypt == nil {
		osCrypt = map[string]any{}
	}
	osCrypt["encrypted_key"] = base64.StdEncoding.EncodeToString(wrapped)
	localState["os_crypt"] = osCrypt
	if err := writeJSONAtomic(localStatePath, localState); err != nil {
		return nil
	}
	return key
}

func (p *desktopPrepContext) dpapiProtectBase64(plainBase64 string) string {
	script := `$plain=[Convert]::FromBase64String($env:AIH_DPAPI_PLAIN);$blob=[System.Security.Cryptography.ProtectedData]::Protect($plain,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($blob))`
	ps := `Add-Type -AssemblyName System.Security;` + script
	env := append(append([]string(nil), p.baseEnv...), "AIH_DPAPI_PLAIN="+plainBase64)
	out := p.deps.Runner.Run(p.ctx, "powershell", []string{"-NoProfile", "-Command", ps}, RunOptions{Env: env, Timeout: 15 * time.Second})
	if out.Err != nil || out.ExitCode != 0 {
		return ""
	}
	return strings.TrimSpace(out.Stdout)
}

func (p *desktopPrepContext) dpapiUnprotectBase64(blobBase64 string) []byte {
	script := `$blob=[Convert]::FromBase64String($env:AIH_DPAPI_BLOB);if ($blob.Length -gt 5 -and [Text.Encoding]::ASCII.GetString($blob[0..4]) -eq DPAPI) { $blob = $blob[5..($blob.Length-1)] };$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($blob,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($plain))`
	ps := `Add-Type -AssemblyName System.Security;` + script
	env := append(append([]string(nil), p.baseEnv...), "AIH_DPAPI_BLOB="+blobBase64)
	out := p.deps.Runner.Run(p.ctx, "powershell", []string{"-NoProfile", "-Command", ps}, RunOptions{Env: env, Timeout: 15 * time.Second})
	if out.Err != nil || out.ExitCode != 0 {
		return nil
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(out.Stdout))
	if err != nil {
		return nil
	}
	return raw
}

func encryptChromiumV10(aesKey, plaintext []byte) ([]byte, error) {
	block, err := aes.NewCipher(aesKey)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, 12)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	sealed := gcm.Seal(nil, nonce, plaintext, nil)
	out := make([]byte, 0, 3+len(nonce)+len(sealed))
	out = append(out, "v10"...)
	out = append(out, nonce...)
	out = append(out, sealed...)
	return out, nil
}

func decryptChromiumV10(aesKey, raw []byte) string {
	if len(raw) < 3+12+16 || string(raw[:3]) != "v10" {
		return ""
	}
	block, err := aes.NewCipher(aesKey)
	if err != nil {
		return ""
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return ""
	}
	plain, err := gcm.Open(nil, raw[3:15], raw[15:], nil)
	if err != nil {
		return ""
	}
	return string(plain)
}

// --- CodeBuddy Family Keychain / Bridge / Shared Data Roots ---

func resolveCodebuddyInternetEnvironment(provider string, snapshot AccountSnapshot) string {
	if len(snapshot.NativeAuthJSON) > 0 {
		var root map[string]any
		if json.Unmarshal(snapshot.NativeAuthJSON, &root) == nil && root != nil {
			if envMap, ok := root["env"].(map[string]any); ok {
				if region := stringField(envMap, "CODEBUDDY_INTERNET_ENVIRONMENT"); region != "" {
					return region
				}
			}
			if region := stringField(root, "internetEnvironment", "CODEBUDDY_INTERNET_ENVIRONMENT"); region != "" {
				return region
			}
		}
	}
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "codebuddycn", "workbuddycn":
		return "internal"
	default:
		return ""
	}
}

func (p *desktopPrepContext) prepareCodebuddyKeychain() *Result {
	if p.platformKey != "darwin" {
		return nil
	}
	if p.profileDir == "" || filepath.Clean(p.profileDir) == filepath.Clean(p.hostHomeDir) {
		return &Result{
			OK:      false,
			Error:   "codebuddy_desktop_keychain_unavailable",
			Reason:  "desktop_home_not_isolated",
			Message: launchErrorMessage("codebuddy_desktop_keychain_unavailable"),
		}
	}
	profileEnv := overrideEnvHome(p.baseEnv, p.profileDir)
	if p.readMacDefaultKeychain(profileEnv) != "" {
		return nil
	}
	hostEnv := overrideEnvHome(p.baseEnv, p.hostHomeDir)
	hostKeychain := p.readMacDefaultKeychain(hostEnv)
	if hostKeychain == "" {
		return &Result{
			OK:      false,
			Error:   "codebuddy_desktop_keychain_unavailable",
			Reason:  "host_default_keychain_missing",
			Message: launchErrorMessage("codebuddy_desktop_keychain_unavailable"),
		}
	}
	for _, dir := range []string{
		p.profileDir,
		filepath.Join(p.profileDir, "Library"),
		filepath.Join(p.profileDir, "Library", "Preferences"),
	} {
		if err := ensurePrivateDirectory(dir, "desktop_preferences_not_private"); err != nil {
			return &Result{
				OK:      false,
				Error:   "codebuddy_desktop_keychain_unavailable",
				Reason:  err.Error(),
				Message: launchErrorMessage("codebuddy_desktop_keychain_unavailable"),
			}
		}
	}
	setOut := p.deps.Runner.Run(p.ctx, "/usr/bin/security", []string{"default-keychain", "-d", "user", "-s", hostKeychain}, RunOptions{
		Env:     profileEnv,
		Timeout: 5 * time.Second,
	})
	if setOut.Err != nil || setOut.ExitCode != 0 {
		return &Result{
			OK:      false,
			Error:   "codebuddy_desktop_keychain_unavailable",
			Reason:  "desktop_keychain_reference_failed",
			Message: launchErrorMessage("codebuddy_desktop_keychain_unavailable"),
		}
	}
	if p.readMacDefaultKeychain(profileEnv) != hostKeychain {
		return &Result{
			OK:      false,
			Error:   "codebuddy_desktop_keychain_unavailable",
			Reason:  "desktop_keychain_reference_unavailable",
			Message: launchErrorMessage("codebuddy_desktop_keychain_unavailable"),
		}
	}
	return nil
}

func (p *desktopPrepContext) readMacDefaultKeychain(env []string) string {
	out := p.deps.Runner.Run(p.ctx, "/usr/bin/security", []string{"default-keychain", "-d", "user"}, RunOptions{
		Env:     env,
		Timeout: 5 * time.Second,
	})
	if out.Err != nil || out.ExitCode != 0 {
		return ""
	}
	var val string
	if json.Unmarshal([]byte(strings.TrimSpace(out.Stdout)), &val) != nil {
		return ""
	}
	if filepath.IsAbs(val) {
		return val
	}
	return ""
}

func (p *desktopPrepContext) prepareCodebuddyIdeBridge() (string, string, error) {
	provider := strings.ToLower(strings.TrimSpace(p.req.Provider))
	if provider != "codebuddy" && provider != "codebuddycn" {
		return "", "", nil
	}
	if p.repoRoot == "" {
		return "", "", nil
	}
	runtimeDir := filepath.Join(p.repoRoot, "lib", "runtime")
	sources := []string{
		"codebuddy-ide-bridge-extension.cjs",
		"codebuddy-ide-bridge-files.js",
		"native-session-bridge-files.js",
	}
	hash := sha256.New()
	sourceContents := make(map[string][]byte, len(sources))
	for _, name := range sources {
		raw, err := os.ReadFile(filepath.Join(runtimeDir, name))
		if err != nil {
			// 未部署插件源文件时不阻塞启动。
			return "", "", nil
		}
		sourceContents[name] = raw
		hash.Write(raw)
	}
	uid := extractCodebuddyUID(p.snapshot.NativeAuthJSON)
	if !codebuddyUIDRegexp.MatchString(uid) {
		return "", "", nil
	}

	productFile := ""
	if p.resolved.BundlePath != "" {
		productFile = filepath.Join(p.resolved.BundlePath, "Contents", "Resources", "app", "product.json")
	} else if p.resolved.ExecutablePath != "" {
		productFile = filepath.Join(filepath.Dir(p.resolved.ExecutablePath), "resources", "app", "product.json")
	}
	if productFile == "" {
		return "", "", nil
	}
	productRaw, err := os.ReadFile(productFile)
	if err != nil {
		if os.IsNotExist(err) {
			return "", "codebuddy_ide_product_metadata_missing", err
		}
		return "", "codebuddy_ide_bridge_prepare_failed", err
	}
	var product map[string]any
	if json.Unmarshal(productRaw, &product) != nil || product == nil {
		return "", "codebuddy_ide_product_metadata_missing", errors.New("product.json invalid")
	}
	dataFolderName := stringField(product, "dataFolderName")
	if !codebuddyDotRegexp.MatchString(dataFolderName) {
		return "", "codebuddy_ide_product_metadata_missing", errors.New("dataFolderName missing")
	}

	if realProfile, err := filepath.EvalSymlinks(p.profileDir); err == nil && filepath.Clean(realProfile) != filepath.Clean(p.profileDir) {
		return "", "codebuddy_ide_profile_mismatch", errors.New("profile symlink mismatch")
	}

	extensionsDir := filepath.Join(p.profileDir, dataFolderName, "extensions")
	if err := os.MkdirAll(extensionsDir, 0o700); err != nil {
		return "", "codebuddy_ide_bridge_prepare_failed", err
	}
	if realExt, err := filepath.EvalSymlinks(extensionsDir); err == nil && filepath.Clean(realExt) != filepath.Clean(extensionsDir) {
		return "", "codebuddy_ide_extensions_not_private", errors.New("extensions dir not private")
	}

	version := "0.1.0-h" + hex.EncodeToString(hash.Sum(nil))[:12]
	extFolderName := codebuddyIdeExtID + "-" + version
	extensionPath := filepath.Join(extensionsDir, extFolderName)
	mailboxDir := filepath.Join(p.profileDir, ".aih-runtime", "codebuddy-ide-bridge")
	for _, dir := range []string{
		extensionPath,
		mailboxDir,
		filepath.Join(mailboxDir, "hosts"),
		filepath.Join(mailboxDir, "requests"),
		filepath.Join(mailboxDir, "results"),
	} {
		if err := ensurePrivateDirectory(dir, "codebuddy_ide_extensions_not_private"); err != nil {
			return "", "codebuddy_ide_bridge_prepare_failed", err
		}
	}
	for _, name := range sources {
		if err := writeBytesAtomic(filepath.Join(extensionPath, name), sourceContents[name], 0o600); err != nil {
			return "", "codebuddy_ide_bridge_prepare_failed", err
		}
	}

	appSupportParts := []string{".local", "share"}
	switch p.platformKey {
	case "darwin":
		appSupportParts = []string{"Library", "Application Support"}
	case "windows":
		appSupportParts = []string{"AppData", "Local"}
	}
	historyRoot := filepath.Join(append(append([]string{p.profileDir}, appSupportParts...), "CodeBuddyExtension", "Data", uid, "CodeBuddyIDE", uid, "history")...)
	binding := map[string]any{
		"version":     version,
		"provider":    provider,
		"accountRef":  p.req.AccountRef,
		"userId":      uid,
		"profileDir":  p.profileDir,
		"historyRoot": historyRoot,
		"mailboxDir":  mailboxDir,
	}
	if err := writeJSONAtomic(filepath.Join(extensionPath, "binding.json"), binding); err != nil {
		return "", "codebuddy_ide_bridge_prepare_failed", err
	}
	pkgDoc := map[string]any{
		"name":                  "aih-native-session-bridge",
		"publisher":             "ai-home",
		"version":               version,
		"engines":               map[string]any{"vscode": "^1.90.0"},
		"main":                  "./codebuddy-ide-bridge-extension.cjs",
		"activationEvents":      []string{"onStartupFinished"},
		"extensionDependencies": []string{"Tencent-Cloud.coding-copilot"},
		"extensionKind":         []string{"ui"},
		"capabilities":          map[string]any{"untrustedWorkspaces": map[string]any{"supported": false}},
	}
	if err := writeJSONAtomic(filepath.Join(extensionPath, "package.json"), pkgDoc); err != nil {
		return "", "codebuddy_ide_bridge_prepare_failed", err
	}

	manifestPath := filepath.Join(extensionsDir, "extensions.json")
	var rows []map[string]any
	if raw, err := os.ReadFile(manifestPath); err == nil && len(strings.TrimSpace(string(raw))) > 0 {
		if json.Unmarshal(raw, &rows) != nil {
			return "", "codebuddy_ide_extension_manifest_invalid", errors.New("extensions.json invalid")
		}
	}
	filtered := make([]map[string]any, 0, len(rows)+1)
	for _, row := range rows {
		if idMap, ok := row["identifier"].(map[string]any); ok && stringField(idMap, "id") == codebuddyIdeExtID {
			continue
		}
		filtered = append(filtered, row)
	}
	fileURL := (&url.URL{Scheme: "file", Path: filepath.ToSlash(extensionPath)}).String()
	filtered = append(filtered, map[string]any{
		"identifier": map[string]any{"id": codebuddyIdeExtID},
		"version":    version,
		"location": map[string]any{
			"$mid":     1,
			"scheme":   "file",
			"path":     filepath.ToSlash(extensionPath),
			"fsPath":   extensionPath,
			"external": fileURL,
		},
		"relativeLocation": extFolderName,
		"metadata": map[string]any{
			"source":         "vsix",
			"targetPlatform": "undefined",
		},
	})
	if err := writeJSONAtomic(manifestPath, filtered); err != nil {
		return "", "codebuddy_ide_bridge_prepare_failed", err
	}
	return extensionsDir, "", nil
}

func extractCodebuddyUID(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var root map[string]any
	if json.Unmarshal(raw, &root) != nil || root == nil {
		return ""
	}
	creds, _ := root["credentials"].(map[string]any)
	if creds == nil {
		creds = root
	}
	auth, _ := creds["auth"].(map[string]any)
	if auth == nil {
		return ""
	}
	return stringField(auth, "uid", "userId", "user_id")
}

// --- Kiro Runtime Home ---

func prepareKiroRuntimeHome(profileDir, hostHomeDir, platformKey string) error {
	if strings.TrimSpace(profileDir) == "" {
		return nil
	}
	if hostHomeDir != "" && filepath.Clean(profileDir) == filepath.Clean(hostHomeDir) {
		return errors.New("kiro_runtime_home_not_isolated")
	}
	if err := ensurePrivateDirectory(profileDir, "kiro_runtime_directory_not_private"); err != nil {
		return err
	}
	var appSegments []string
	switch platformKey {
	case "darwin":
		appSegments = []string{"Library", "Application Support", "kiro-cli"}
	case "linux":
		appSegments = []string{".local", "share", "kiro-cli"}
	}
	ensureAccountRel := func(rel []string) error {
		full := filepath.Join(append([]string{profileDir}, rel...)...)
		if info, err := os.Lstat(full); err == nil && info.Mode()&os.ModeSymlink != 0 && hostHomeDir != "" {
			if target, rerr := os.Readlink(full); rerr == nil {
				resolvedTarget := target
				if !filepath.IsAbs(resolvedTarget) {
					resolvedTarget = filepath.Join(filepath.Dir(full), resolvedTarget)
				}
				hostTarget := filepath.Join(append([]string{hostHomeDir}, rel...)...)
				if filepath.Clean(resolvedTarget) == filepath.Clean(hostTarget) {
					_ = os.Remove(full)
				}
			}
		}
		return ensurePrivateDirectory(full, "kiro_runtime_directory_not_private")
	}
	for _, rel := range [][]string{{"tmp"}, {".config"}, {".local"}} {
		if err := ensureAccountRel(rel); err != nil {
			return err
		}
	}
	if len(appSegments) == 0 {
		return nil
	}
	for i := 1; i <= len(appSegments); i++ {
		if err := ensureAccountRel(appSegments[:i]); err != nil {
			return err
		}
	}
	targetDB := filepath.Join(profileDir, "data.sqlite3")
	nativeDB := filepath.Join(append([]string{profileDir}, append(appSegments, "data.sqlite3")...)...)
	if info, err := os.Lstat(nativeDB); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			if linkDest, rerr := os.Readlink(nativeDB); rerr == nil {
				if !filepath.IsAbs(linkDest) {
					linkDest = filepath.Join(filepath.Dir(nativeDB), linkDest)
				}
				if filepath.Clean(linkDest) == filepath.Clean(targetDB) {
					return nil
				}
			}
		}
		return errors.New("kiro_native_database_path_conflict")
	} else if !os.IsNotExist(err) {
		return err
	}
	relTarget, err := filepath.Rel(filepath.Dir(nativeDB), targetDB)
	if err != nil {
		relTarget = targetDB
	}
	return os.Symlink(relTarget, nativeDB)
}

// --- Shared Host Data Roots ---

type sharedDataRootSpec struct {
	projection []string
	host       []string
}

func sharedDataRootsForProvider(provider, platformKey string) []sharedDataRootSpec {
	p := strings.ToLower(strings.TrimSpace(provider))
	codebuddyRoots := func(appDataName string) []sharedDataRootSpec {
		if platformKey != "darwin" {
			return nil
		}
		hostBase := []string{"Library", "Application Support", appDataName}
		return []sharedDataRootSpec{
			{
				projection: []string{"electron-user-data", "User", "globalStorage", "tencent-cloud.coding-copilot"},
				host:       append(append([]string(nil), hostBase...), "User", "globalStorage", "tencent-cloud.coding-copilot"),
			},
			{
				projection: []string{"electron-user-data", "codebuddy-sessions.vscdb"},
				host:       append(append([]string(nil), hostBase...), "codebuddy-sessions.vscdb"),
			},
		}
	}
	switch p {
	case "codebuddy":
		return codebuddyRoots("CodeBuddy")
	case "codebuddycn":
		return codebuddyRoots("CodeBuddy CN")
	case "workbuddy":
		return []sharedDataRootSpec{
			{projection: []string{".workbuddy-ai"}, host: []string{".workbuddy-ai"}},
			{projection: []string{".workbuddy"}, host: []string{".workbuddy"}},
			{projection: []string{".sheetagent"}, host: []string{".sheetagent"}},
			{projection: []string{"WorkBuddy AI"}, host: []string{"WorkBuddy AI"}},
			{projection: []string{"Library", "Application Support", "WorkBuddy AI"}, host: []string{"Library", "Application Support", "WorkBuddy AI"}},
		}
	case "workbuddycn":
		return []sharedDataRootSpec{
			{projection: []string{".workbuddy"}, host: []string{".workbuddy"}},
			{projection: []string{".sheetagent"}, host: []string{".sheetagent"}},
			{projection: []string{"WorkBuddy"}, host: []string{"WorkBuddy"}},
			{projection: []string{"Library", "Application Support", "WorkBuddy"}, host: []string{"Library", "Application Support", "WorkBuddy"}},
		}
	default:
		return nil
	}
}

func linkSharedHostDataRoots(provider, profileDir, hostHomeDir, platformKey string) error {
	if strings.TrimSpace(profileDir) == "" || strings.TrimSpace(hostHomeDir) == "" {
		return nil
	}
	if filepath.Clean(profileDir) == filepath.Clean(hostHomeDir) {
		return nil
	}
	entries := sharedDataRootsForProvider(provider, platformKey)
	for _, spec := range entries {
		projPath := filepath.Join(append([]string{profileDir}, spec.projection...)...)
		hostPath := filepath.Join(append([]string{hostHomeDir}, spec.host...)...)
		if err := linkOneSharedDataRoot(projPath, hostPath); err != nil {
			return err
		}
	}
	return nil
}

func linkOneSharedDataRoot(projPath, hostPath string) error {
	projInfo, projErr := os.Lstat(projPath)
	if projErr != nil && !os.IsNotExist(projErr) {
		return projErr
	}
	if projErr == nil && projInfo.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(projPath)
		if err != nil {
			return err
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(filepath.Dir(projPath), target)
		}
		if filepath.Clean(target) == filepath.Clean(hostPath) {
			return nil
		}
		return errors.New("desktop_data_root_not_shared")
	}

	_, hostErr := os.Lstat(hostPath)
	if hostErr != nil && !os.IsNotExist(hostErr) {
		return hostErr
	}
	hostExists := hostErr == nil

	if projErr == nil {
		if !projInfo.IsDir() && !projInfo.Mode().IsRegular() {
			return errors.New("desktop_data_root_not_shared")
		}
		hasData := projInfo.Mode().IsRegular()
		if projInfo.IsDir() {
			items, err := os.ReadDir(projPath)
			if err != nil {
				return err
			}
			hasData = len(items) > 0
		}
		if hasData {
			if hostExists {
				return errors.New("desktop_data_root_not_shared")
			}
			if err := os.MkdirAll(filepath.Dir(hostPath), 0o700); err != nil {
				return err
			}
			if err := os.Rename(projPath, hostPath); err != nil {
				return err
			}
		} else {
			if err := os.Remove(projPath); err != nil {
				return err
			}
			if !hostExists {
				return nil
			}
		}
	} else if !hostExists {
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(projPath), 0o700); err != nil {
		return err
	}
	return os.Symlink(hostPath, projPath)
}

// --- Shared Small Helpers ---

func ensurePrivateDirectory(dirPath, errCode string) error {
	if info, err := os.Lstat(dirPath); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New(errCode)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.MkdirAll(dirPath, 0o700)
}

func ensureAccountPrivateUserDataDir(userDataDir string) error {
	if info, err := os.Lstat(userDataDir); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			if remErr := os.Remove(userDataDir); remErr != nil {
				return remErr
			}
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.MkdirAll(userDataDir, 0o700)
}

func overrideEnvHome(environ []string, homeDir string) []string {
	m := envSliceToMap(environ)
	setEnvKey(m, "HOME", homeDir)
	return mapToEnvSlice(m)
}

func findNodeExecutable(environ []string, platformKey string) string {
	m := envSliceToMap(environ)
	if custom := firstEnvValue(m, "AIH_NODE_BIN", "NODE_BIN"); custom != "" && isExecutableFile(custom, platformKey) {
		return custom
	}
	if exe, err := os.Executable(); err == nil && strings.Contains(strings.ToLower(filepath.Base(exe)), "node") {
		return exe
	}
	candidates := []string{"node"}
	if platformKey == "windows" {
		candidates = []string{"node.exe", "node"}
	}
	for _, dir := range hostSearchDirectories(environ, platformKey) {
		for _, name := range candidates {
			full := filepath.Join(dir, name)
			if isExecutableFile(full, platformKey) {
				return full
			}
		}
	}
	return "node"
}

func hostSearchDirectories(environ []string, platformKey string) []string {
	m := envSliceToMap(environ)
	pathVal := firstEnvValue(m, "PATH")
	sep := ":"
	if platformKey == "windows" {
		sep = ";"
	}
	dirs := strings.Split(pathVal, sep)
	if platformKey == "darwin" {
		dirs = append(dirs, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin")
	} else if platformKey == "linux" {
		dirs = append(dirs, "/usr/local/bin", "/usr/bin", "/bin")
	}
	out := make([]string, 0, len(dirs))
	seen := make(map[string]struct{}, len(dirs))
	for _, d := range dirs {
		trimmed := strings.TrimSpace(d)
		if trimmed == "" {
			continue
		}
		if _, dup := seen[trimmed]; dup {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

func (deps NativeLauncherDependencies) nowTime() time.Time {
	if deps.Now != nil {
		return deps.Now()
	}
	return time.Now()
}

func (deps NativeLauncherDependencies) sleepFn() func(context.Context, time.Duration) error {
	if deps.Sleep != nil {
		return deps.Sleep
	}
	return defaultSleep
}

func (deps NativeLauncherDependencies) currentEnviron() []string {
	if deps.Environ != nil {
		return append([]string(nil), deps.Environ()...)
	}
	return os.Environ()
}

func isValidCLIAccountIDText(raw string) bool {
	if raw == "" {
		return false
	}
	_, err := strconv.ParseInt(raw, 10, 64)
	return err == nil
}
