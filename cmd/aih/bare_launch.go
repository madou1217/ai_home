package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/serverconfig"
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
func resolveBareLaunchArgs(args []string) ([]string, bool, error) {
	if len(args) == 0 || !launchProviders[args[0]] || gatewayRelayProviders[args[0]] {
		return nil, false, nil
	}
	provider := args[0]
	rest := args[1:]
	if !bareLaunchNeedsSelection(rest) {
		return nil, false, nil
	}
	model := launchModelFromArgs(rest)
	candidate, found, err := pickHealthyAccount(provider, model)
	if err != nil {
		if errors.Is(err, launchselection.ErrNoHealthyAccount) {
			_, _ = fmt.Fprintf(os.Stderr, "[aih] %s 没有健康账号：全部候选都在账号/模型 429、额度耗尽或不可调度状态，未启动会话\n", provider)
			return nil, true, err
		}
		return nil, false, nil
	}
	if !found {
		return nil, false, nil
	}
	remaining := "未知"
	if candidate.RemainingPct != nil {
		remaining = fmt.Sprintf("%.1f%%", *candidate.RemainingPct)
	}
	if model != "" {
		_, _ = fmt.Fprintf(os.Stderr, "[aih] 未指定账号，按健康度选用 %s #%s（剩余 %s，模型 %s）\n", provider, candidate.DisplayID, remaining, model)
	} else {
		_, _ = fmt.Fprintf(os.Stderr, "[aih] 未指定账号，按健康度选用 %s #%s（剩余 %s）\n", provider, candidate.DisplayID, remaining)
	}
	return append([]string{provider, candidate.DisplayID}, rest...), true, nil
}

// bareLaunchNeedsSelection 判断无账号启动是否应走健康选号。
// 管理动作、桌面端、显式账号和统一 resume/fork 动词都保持原语义。
func bareLaunchNeedsSelection(rest []string) bool {
	if len(rest) == 0 {
		return true
	}
	first := strings.ToLower(strings.TrimSpace(rest[0]))
	if first == "" || isNumericAccountToken(first) || strings.HasPrefix(first, "acct_") || first == "--" {
		return false
	}
	if strings.HasPrefix(first, "acc_") {
		return false
	}
	switch first {
	case "relay", "resume", "fork", "ls", "list", "usage", "stats", "--usage",
		"sessions", "ss", "login", "detect", "home", "version", "install", "update",
		"auto-switch", "set-default", "unset-default", "delete", "deleteall",
		"terminal-icon", "terminal-icons", "models", "help", "--help", "-h",
		"--version", "-v", "--desktop", "--fresh", "--new":
		return false
	}
	for _, argument := range rest {
		switch strings.ToLower(strings.TrimSpace(argument)) {
		case "--desktop", "--help", "-h", "--version", "-v", "--":
			return false
		}
	}
	return true
}

// launchModelFromArgs 取出显式 --model（支持 --model value / --model=value），
// 供账号-模型 429 过滤；没有显式模型时由 launchselection 保守避开任意模型冷却。
func launchModelFromArgs(arguments []string) string {
	for index := 0; index < len(arguments); index++ {
		argument := strings.TrimSpace(arguments[index])
		if argument == "--model" && index+1 < len(arguments) {
			return strings.TrimSpace(arguments[index+1])
		}
		if strings.HasPrefix(argument, "--model=") {
			return strings.TrimSpace(strings.TrimPrefix(argument, "--model="))
		}
	}
	return ""
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
func pickHealthyAccount(provider, model string) (launchselection.Candidate, bool, error) {
	if strings.TrimSpace(provider) == "" {
		return launchselection.Candidate{}, false, nil
	}
	aiHomeDir := bareLaunchHomeDir()
	key := resolveManagementKey(aiHomeDir)
	if aiHomeDir == "" || key == "" {
		return launchselection.Candidate{}, false, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	candidate, found, err := launchselection.Pick(ctx, launchselection.Options{
		AIHomeDir:     aiHomeDir,
		BaseURL:       resolveServerBaseURL(),
		ManagementKey: key,
		Provider:      provider,
		Model:         model,
	})
	if err != nil {
		return launchselection.Candidate{}, false, err
	}
	if !found {
		return launchselection.Candidate{}, false, nil
	}
	return candidate, true, nil
}

// pickHealthyAccountDisplayID 返回裸启动口径下最该用的账号别名。
func pickHealthyAccountDisplayID(provider string) (string, bool) {
	candidate, found, err := pickHealthyAccount(provider, "")
	if err != nil || !found {
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
	return serverconfig.BaseURL(serverconfig.DefaultHost, serverconfig.DefaultPort, "")
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
	raw, found, err := appstate.ReadKV(ctx, databasePath, appstate.KeyServerConfig)
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
