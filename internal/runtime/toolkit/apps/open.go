package apps

import (
	"context"
	"crypto/rand"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/claudedesktopconfig"
)

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

	if ctx.Err() != nil {
		return OpenResult{OK: false, Error: "desktop_launch_cancelled", AppID: norm, Provider: provider}
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
		if ctx.Err() != nil {
			return OpenResult{OK: false, Error: "desktop_launch_cancelled", AppID: norm, Provider: provider}
		}
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

// PrepareClaudeDesktopGateway exposes preparation separately from launching a
// GUI, so callers can validate the real configuration path without UI side effects.
func PrepareClaudeDesktopGateway(ctx context.Context, opts Options) string {
	return prepareClaudeDesktopGateway(ctx, opts)
}

func prepareClaudeDesktopGateway(ctx context.Context, opts Options) string {
	profileDir := resolveClaudeDesktopGatewayProfileDir(opts)
	aiHome := strings.TrimSpace(opts.AIHomeDir)
	if profileDir == "" || !filepath.IsAbs(aiHome) {
		return "invalid_gateway_scope"
	}
	helper := nonEmpty(strings.TrimSpace(opts.CredentialHelperPath), resolveRepoFile(opts, "bin", "claude-desktop-credential.js"))
	if !fileExists(helper) {
		return "credential_helper_missing"
	}
	nodeExec := strings.TrimSpace(opts.NodeExecPath)
	if nodeExec == "" {
		var err error
		nodeExec, err = exec.LookPath("node")
		if err != nil {
			return "node_runtime_missing"
		}
	}
	result := claudedesktopconfig.Prepare(ctx, claudedesktopconfig.Options{ProfileDir: profileDir, Mode: "api", GatewayBaseURL: resolveDefaultServerRootURL(ctx, opts), CredentialHelper: nodeExec, CredentialHelperArgs: []string{helper, "--ai-home-dir", aiHome}})
	if !result.OK {
		return result.Reason
	}
	return ""
}

func newAppUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
