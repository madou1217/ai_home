package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/launchselection"
)

// gatewayRelayProviders 的裸启动语义是"网关账号池"，保持交给 Node/Relay。
var gatewayRelayProviders = map[string]bool{"codex": true, "claude": true}

// resolveBareLaunchArgs 把 "aih <provider>" 解析成 "aih <provider> <账号编号>"。
//
// 只处理非 Relay 家族：它们没有 Gateway Profile，裸启动必须落到某个具体账号。
// 选号口径借用 relay 调度：健康优先 → 余量优先 → 最少最近使用（状态落在
// run/launch-selection.json 并加锁，保证并发启动不会命中同一个账号）。
func resolveBareLaunchArgs(args []string) ([]string, bool) {
	if len(args) != 1 || !launchProviders[args[0]] || gatewayRelayProviders[args[0]] {
		return nil, false
	}
	provider := args[0]
	candidate, found := pickHealthyAccount(provider)
	if !found {
		return nil, false
	}
	remaining := "未知"
	if candidate.RemainingPct != nil {
		remaining = fmt.Sprintf("%.1f%%", *candidate.RemainingPct)
	}
	_, _ = fmt.Fprintf(os.Stderr, "[aih] 未指定账号，按健康度选用 %s #%s（剩余 %s）\n", provider, candidate.DisplayID, remaining)
	return []string{provider, candidate.DisplayID}, true
}

// ensureManagementKeyEnv 与旧入口的动作命令保持同一套密钥注入：
// 显式环境变量优先；否则从 config:server 读取并放入当前进程环境。
func ensureManagementKeyEnv() {
	if strings.TrimSpace(os.Getenv("AIH_SERVER_MANAGEMENT_KEY")) != "" {
		return
	}
	home := bareLaunchHomeDir()
	if home == "" {
		return
	}
	if key := resolveManagementKey(home); key != "" {
		_ = os.Setenv("AIH_SERVER_MANAGEMENT_KEY", key)
	}
}

// pickHealthyAccount 是裸启动与 resume 共用的选号口径：健康优先、余量最高、
// 其次最久未用。挑不到（无 server/无密钥/无可用候选）时返回 false，调用方
// 各自保留原有兜底，不因选号失败阻断启动。
func pickHealthyAccount(provider string) (launchselection.Candidate, bool) {
	if strings.TrimSpace(provider) == "" {
		return launchselection.Candidate{}, false
	}
	aiHomeDir := bareLaunchHomeDir()
	key := resolveManagementKey(aiHomeDir)
	if aiHomeDir == "" || key == "" {
		return launchselection.Candidate{}, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	candidate, found, err := launchselection.Pick(ctx, launchselection.Options{
		AIHomeDir:     aiHomeDir,
		BaseURL:       resolveServerBaseURL(),
		ManagementKey: key,
		Provider:      provider,
	})
	if err != nil || !found {
		return launchselection.Candidate{}, false
	}
	return candidate, true
}

// pickHealthyAccountDisplayID 返回裸启动口径下最该用的账号别名。
func pickHealthyAccountDisplayID(provider string) (string, bool) {
	candidate, found := pickHealthyAccount(provider)
	if !found {
		return "", false
	}
	return candidate.DisplayID, true
}

// bareLaunchHomeDir 与 CLI 其它部分保持同一口径：AIH_HOME_DIR 优先，否则 ~/.ai_home。
func bareLaunchHomeDir() string {
	if value := strings.TrimSpace(os.Getenv("AIH_HOME_DIR")); value != "" {
		return value
	}
	home := strings.TrimSpace(os.Getenv("HOME"))
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".ai_home")
}

// resolveServerBaseURL 与服务端默认监听保持一致，可用环境变量覆盖。
func resolveServerBaseURL() string {
	if value := strings.TrimSpace(os.Getenv("AIH_SERVER_BASE_URL")); value != "" {
		return value
	}
	return "http://127.0.0.1:9527"
}

// resolveManagementKey 先看环境变量，再读 aih.db 的 config:server（与 Node 入口同源）。
func resolveManagementKey(aiHomeDir string) string {
	if value := strings.TrimSpace(os.Getenv("AIH_SERVER_MANAGEMENT_KEY")); value != "" {
		return value
	}
	if aiHomeDir == "" {
		return ""
	}
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	raw, found, err := appstate.ReadKV(ctx, databasePath, "config:server")
	if err != nil || !found {
		return ""
	}
	var config struct {
		ManagementKey string `json:"managementKey"`
	}
	if json.Unmarshal([]byte(raw), &config) != nil {
		return ""
	}
	return strings.TrimSpace(config.ManagementKey)
}
