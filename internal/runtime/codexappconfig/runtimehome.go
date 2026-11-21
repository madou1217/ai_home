package codexappconfig

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// DesktopRuntimeHome 描述一次 Desktop runtime home 准备结果。
type DesktopRuntimeHome struct {
	RuntimeHome   string
	HostCodexHome string
	AccountRef    string
	AuthType      string
}

// PrepareDesktopRuntimeHome 写出隔离的 config.toml 与 auth.json，返回 runtime home。
// 账号身份由调用方从账号库解析后传入；本函数只负责文件物化与权限。
func PrepareDesktopRuntimeHome(aiHomeDir, hostCodexHome string, identity *DesktopIdentity, options RuntimeConfigOptions) (DesktopRuntimeHome, error) {
	if identity == nil || identity.AuthType != DesktopAuthTypeChatGPT {
		return DesktopRuntimeHome{}, errors.New("codex_desktop_identity_missing")
	}
	if !desktopAccountRefPattern.MatchString(identity.AccountRef) {
		return DesktopRuntimeHome{}, errors.New("codex_desktop_identity_invalid")
	}
	root := strings.TrimSpace(aiHomeDir)
	hostHome := strings.TrimSpace(hostCodexHome)
	if root == "" || hostHome == "" {
		return DesktopRuntimeHome{}, errors.New("codex_desktop_runtime_root_missing")
	}
	runtimeHome := filepath.Join(root, "run", "codex-desktop", identity.AccountRef)
	if err := os.MkdirAll(runtimeHome, 0o700); err != nil {
		return DesktopRuntimeHome{}, err
	}
	hostConfig := ""
	if raw, err := os.ReadFile(filepath.Join(hostHome, "config.toml")); err == nil {
		hostConfig = string(raw)
	}
	options.HostCodexHome = hostHome
	configText := BuildCodexAppServerRuntimeConfig(hostConfig, options)
	if err := writePrivateFile(filepath.Join(runtimeHome, "config.toml"), []byte(configText)); err != nil {
		return DesktopRuntimeHome{}, err
	}
	auth := BuildDesktopRuntimeAuth(identity)
	if auth == nil {
		return DesktopRuntimeHome{}, errors.New("codex_desktop_auth_missing")
	}
	authRaw, err := json.MarshalIndent(auth, "", "  ")
	if err != nil {
		return DesktopRuntimeHome{}, err
	}
	if err := writePrivateFile(filepath.Join(runtimeHome, "auth.json"), authRaw); err != nil {
		return DesktopRuntimeHome{}, err
	}
	return DesktopRuntimeHome{
		RuntimeHome: runtimeHome, HostCodexHome: hostHome,
		AccountRef: identity.AccountRef, AuthType: identity.AuthType,
	}, nil
}

func writePrivateFile(path string, content []byte) error {
	dir := filepath.Dir(path)
	temporary, err := os.CreateTemp(dir, ".aih-runtime-*")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer func() {
		_ = os.Remove(name)
	}()
	if _, err := temporary.Write(content); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
