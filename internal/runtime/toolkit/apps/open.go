package apps

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

var claudeConfigIDRe = regexp.MustCompile(`^[a-f0-9-]{36}$`)

// OpenManagedDesktopApp 不绑定账号，直接在宿主打开已安装的桌面客户端。
// 打开 Claude Desktop 时会自动准备 Claude-3p 本地网关配置。
func OpenManagedDesktopApp(ctx context.Context, appID string, opts Options) OpenResult {
	norm := strings.ToLower(strings.TrimSpace(appID))
	if !strings.HasSuffix(norm, "-desktop") {
		return OpenResult{OK: false, Error: "unsupported_app"}
	}
	provider := strings.TrimSuffix(norm, "-desktop")
	cat := resolveCatalog(opts)
	def, ok := resolveProviderDefinition(cat, provider)
	if !ok || !def.Clients.Desktop {
		return OpenResult{OK: false, Error: "unsupported_app"}
	}

	rec := FindDesktopClientRecord(ctx, provider, opts)
	if rec == nil {
		return OpenResult{OK: false, Error: "desktop_not_installed", AppID: norm, Provider: provider}
	}

	if provider == "claude" {
		if errMsg := prepareClaudeDesktopGateway(ctx, opts); errMsg != "" {
			return OpenResult{
				OK:       false,
				Error:    "desktop_gateway_prepare_failed",
				Message:  errMsg,
				AppID:    norm,
				Provider: provider,
			}
		}
	}

	p := resolvePlatform(opts)
	cmd := rec.ExecutablePath
	var args []string
	if p == platformMacOS {
		target := nonEmpty(rec.BundlePath, rec.DisplayPath)
		if target == "" {
			return OpenResult{OK: false, Error: "desktop_executable_unavailable", AppID: norm, Provider: provider}
		}
		cmd = "open"
		args = []string{"-a", target}
	}
	if cmd == "" {
		return OpenResult{OK: false, Error: "desktop_executable_unavailable", AppID: norm, Provider: provider}
	}

	if opts.SpawnDetached != nil {
		if err := opts.SpawnDetached(cmd, args, opts.Env); err != nil {
			return OpenResult{
				OK:       false,
				Error:    "desktop_launch_failed",
				Message:  err.Error(),
				AppID:    norm,
				Provider: provider,
			}
		}
	} else {
		c := exec.Command(cmd, args...)
		if err := c.Start(); err != nil {
			return OpenResult{
				OK:       false,
				Error:    "desktop_launch_failed",
				Message:  err.Error(),
				AppID:    norm,
				Provider: provider,
			}
		}
		if c.Process != nil {
			_ = c.Process.Release()
		}
	}

	return OpenResult{
		OK:         true,
		Status:     "launched",
		AppID:      norm,
		Provider:   provider,
		Executable: nonEmpty(rec.ExecutablePath, rec.DisplayPath),
	}
}

func resolveClaudeDesktopGatewayProfileDir(opts Options) string {
	p := resolvePlatform(opts)
	home := ResolveHostHome(opts)
	if home == "" {
		return ""
	}
	env := resolveEnvMap(opts)
	switch p {
	case platformMacOS:
		return joinPlatformPath(p, home, "Library", "Application Support", "Claude-3p")
	case platformWindows:
		localAppData := nonEmpty(envLookup(env, "LOCALAPPDATA"), joinPlatformPath(p, home, "AppData", "Local"))
		return joinPlatformPath(p, localAppData, "Claude-3p")
	default:
		return ""
	}
}

func prepareClaudeDesktopGateway(ctx context.Context, opts Options) string {
	profileDir := resolveClaudeDesktopGatewayProfileDir(opts)
	aiHomeDir := strings.TrimSpace(opts.AIHomeDir)
	if profileDir == "" || !filepath.IsAbs(aiHomeDir) {
		return ""
	}
	helperScript := nonEmpty(strings.TrimSpace(opts.CredentialHelperPath), resolveRepoFile(opts, "bin", "claude-desktop-credential.js"))
	if !fileExists(helperScript) {
		return "credential_helper_missing"
	}
	nodeExec := strings.TrimSpace(opts.NodeExecPath)
	if nodeExec == "" {
		if resolved, err := exec.LookPath("node"); err == nil {
			nodeExec = resolved
		} else {
			nodeExec = "node"
		}
	}

	if err := os.MkdirAll(profileDir, 0o700); err != nil {
		return err.Error()
	}
	_ = os.Chmod(profileDir, 0o700)

	libraryDir := filepath.Join(profileDir, "configLibrary")
	metaPath := filepath.Join(libraryDir, "_meta.json")
	meta := map[string]any{"appliedId": "", "entries": []any{}}
	if raw, err := os.ReadFile(metaPath); err == nil {
		var parsed map[string]any
		if json.Unmarshal(raw, &parsed) != nil || parsed == nil {
			return "config_library_meta_invalid"
		}
		meta = parsed
	}
	rawEntries, ok := meta["entries"].([]any)
	if !ok {
		return "config_library_entries_invalid"
	}
	entryID := ""
	nextEntries := make([]any, 0, len(rawEntries)+1)
	for _, item := range rawEntries {
		m, ok := item.(map[string]any)
		if !ok {
			return "config_library_entry_invalid"
		}
		id, _ := m["id"].(string)
		name, _ := m["name"].(string)
		id = strings.TrimSpace(id)
		name = strings.TrimSpace(name)
		if !claudeConfigIDRe.MatchString(id) || name == "" {
			return "config_library_entry_invalid"
		}
		mCopy := cloneJSONMap(m)
		mCopy["id"] = id
		mCopy["name"] = name
		nextEntries = append(nextEntries, mCopy)
		if name == "ai-home API" && entryID == "" {
			entryID = id
		}
	}
	if entryID == "" {
		entryID = newAppUUID()
		nextEntries = append(nextEntries, map[string]any{"id": entryID, "name": "ai-home API"})
	}

	apiConfig := map[string]any{
		"inferenceProvider":            "gateway",
		"inferenceCredentialKind":      "helper-script",
		"inferenceGatewayBaseUrl":      resolveDefaultServerRootURL(ctx, opts),
		"inferenceGatewayAuthScheme":   "bearer",
		"inferenceCredentialHelper":    nodeExec,
		"inferenceCredentialHelperArgs": []string{helperScript, "--ai-home-dir", aiHomeDir},
		"modelDiscoveryEnabled":        true,
	}
	if err := writePrivateJSONAtomic(filepath.Join(libraryDir, entryID+".json"), apiConfig); err != nil {
		return err.Error()
	}
	meta["appliedId"] = entryID
	meta["entries"] = nextEntries
	if err := writePrivateJSONAtomic(metaPath, meta); err != nil {
		return err.Error()
	}

	devSettingsPath := filepath.Join(profileDir, "developer_settings.json")
	devSettings := readJSONObjectSafe(devSettingsPath)
	devSettings["allowDevTools"] = true
	if err := writePrivateJSONAtomic(devSettingsPath, devSettings); err != nil {
		return err.Error()
	}

	desktopCfgPath := filepath.Join(profileDir, "claude_desktop_config.json")
	desktopCfg := readJSONObjectSafe(desktopCfgPath)
	desktopCfg["deploymentMode"] = "3p"
	delete(desktopCfg, "awaitingSignIn")
	if err := writePrivateJSONAtomic(desktopCfgPath, desktopCfg); err != nil {
		return err.Error()
	}
	return ""
}

func writePrivateJSONAtomic(target string, value any) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	tmp := fmt.Sprintf("%s.aih-tmp-%d-%s", target, os.Getpid(), newAppUUID())
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	_ = os.Chmod(tmp, 0o600)
	if err := os.Rename(tmp, target); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func newAppUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
