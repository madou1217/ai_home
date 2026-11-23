package main

import (
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/platform"
)

// 本文件维护 AIH 本地 app-server 的 per-launch token 登记。
//
// TUI 断线提示会打印一条 `codex --remote ws://127.0.0.1:<port> ...
// --remote-auth-token-env AIH_CODEX_LOCAL_REMOTE_TOKEN resume ...` 命令，但 token
// 只存在于原 TUI 的环境里；新 shell 直接执行会报 “environment variable … is not set”。
// 登记表让包装器按 URL 找回 token，使提示命令可以直接执行。

type localAppServerTokenRecord struct {
	URL       string `json:"url"`
	Token     string `json:"token"`
	ParentPID int    `json:"parentPid"`
	CreatedAt string `json:"createdAt"`
}

func localAppServerTokenDir(env []string) string {
	aiHome := aiHomeFromEnv(env)
	if aiHome == "" {
		return ""
	}
	return filepath.Join(aiHome, "run", "codex", "local-app-servers")
}

func aiHomeFromEnv(env []string) string {
	values := map[string]string{}
	for _, entry := range env {
		if key, value, ok := strings.Cut(entry, "="); ok {
			values[key] = value
		}
	}
	if home := strings.TrimSpace(values["AIH_HOME_DIR"]); home != "" {
		return home
	}
	if home := strings.TrimSpace(values["HOME"]); home != "" {
		return filepath.Join(home, ".ai_home")
	}
	return ""
}

// normalizeLocalEndpoint 只登记 loopback 端点；返回不带尾斜杠的规范形式。
func normalizeLocalEndpoint(raw string) (string, bool) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed == nil || parsed.Host == "" {
		return "", false
	}
	if scheme := strings.ToLower(parsed.Scheme); scheme != "ws" && scheme != "wss" {
		return "", false
	}
	host := strings.ToLower(parsed.Hostname())
	if host != "127.0.0.1" && host != "localhost" && host != "::1" {
		return "", false
	}
	port := parsed.Port()
	if port == "" {
		return "", false
	}
	return "ws://" + net.JoinHostPort(host, port), true
}

func localAppServerTokenPath(env []string, endpoint string) (string, bool) {
	dir := localAppServerTokenDir(env)
	normalized, ok := normalizeLocalEndpoint(endpoint)
	if dir == "" || !ok {
		return "", false
	}
	parsed, _ := url.Parse(normalized)
	name := strings.ReplaceAll(parsed.Hostname(), ":", "_") + "_" + parsed.Port() + ".json"
	return filepath.Join(dir, name), true
}

// publishLocalAppServerToken 原子写入当前 app-server 的 token，返回只移除自身的清理函数。
func publishLocalAppServerToken(env []string, endpoint, token string) (func(), error) {
	path, ok := localAppServerTokenPath(env, endpoint)
	if !ok || strings.TrimSpace(token) == "" {
		return func() {}, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	payload, err := json.Marshal(localAppServerTokenRecord{
		URL: endpoint, Token: token, ParentPID: os.Getpid(),
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	})
	if err != nil {
		return nil, err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, payload, 0o600); err != nil {
		return nil, err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return nil, err
	}
	return func() { removeLocalAppServerToken(path, token) }, nil
}

func removeLocalAppServerToken(path, token string) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var record localAppServerTokenRecord
	if json.Unmarshal(raw, &record) != nil || record.Token != token {
		return
	}
	_ = os.Remove(path)
}

// resolveLocalAppServerToken 按 URL 找回仍在运行的本地 app-server token。
func resolveLocalAppServerToken(env []string, endpoint string) (string, bool) {
	path, ok := localAppServerTokenPath(env, endpoint)
	if !ok {
		return "", false
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	var record localAppServerTokenRecord
	if json.Unmarshal(raw, &record) != nil {
		return "", false
	}
	// 登记写入的是启动 app-server 的包装进程；它退出（含 SIGHUP/SIGKILL）后
	// app-server 随之结束，这里顺手清掉陈旧登记，避免把死 token 注入新会话。
	if record.ParentPID > 0 && !platform.ProcessAlive(record.ParentPID) {
		_ = os.Remove(path)
		return "", false
	}
	if strings.TrimSpace(record.Token) == "" {
		return "", false
	}
	return record.Token, true
}

func argValue(args []string, flag string) string {
	for index := 0; index < len(args); index++ {
		token := strings.TrimSpace(args[index])
		if token == flag {
			if index+1 < len(args) {
				return strings.TrimSpace(args[index+1])
			}
			return ""
		}
		if strings.HasPrefix(token, flag+"=") {
			return strings.TrimSpace(strings.TrimPrefix(token, flag+"="))
		}
	}
	return ""
}

// withLocalRemoteToken 为显式 `--remote` 的调用补上 AIH 本地 token。
// 非本地端点或 token 环境变量已有值时原样返回。
func withLocalRemoteToken(env []string, args []string) ([]string, error) {
	endpoint := argValue(args, "--remote")
	envName := argValue(args, "--remote-auth-token-env")
	if endpoint == "" || envName == "" {
		return env, nil
	}
	if value, ok := localEnvValue(env, envName); ok && strings.TrimSpace(value) != "" {
		return env, nil
	}
	token, ok := resolveLocalAppServerToken(env, endpoint)
	if !ok {
		return nil, errors.New("本地 app-server 已退出或未登记（" + endpoint + "）：请重新启动 codex 会话，或在原终端继续")
	}
	injected := append([]string{}, env...)
	injected = append(injected, envName+"="+token)
	return injected, nil
}

func localEnvValue(env []string, name string) (string, bool) {
	prefix := name + "="
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			return strings.TrimPrefix(entry, prefix), true
		}
	}
	return "", false
}
