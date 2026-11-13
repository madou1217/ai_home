package housekeeping

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// CodexAppServerPruneOptions 配置 codex app-server 状态文件清理任务。
type CodexAppServerPruneOptions struct {
	AIHomeDir   string
	Accounts    RegisteredAccountsReader
	Invalidator EndpointInvalidator
}

type rawCodexAppServerState struct {
	AccountRef   string          `json:"accountRef"`
	RuntimeScope string          `json:"runtimeScope"`
	Port         json.RawMessage `json:"port"`
	Socket       string          `json:"socket"`
	Multiplexer  string          `json:"multiplexer"`
}

// PruneStaleCodexAppServerStates 扫描 run/codex-app-server/*.json，保留网关态和仍注册且
// 状态为 up 的账号；已删除或已停用的账号会经 Invalidator 停进程并清理状态文件。
func PruneStaleCodexAppServerStates(
	ctx context.Context,
	opts CodexAppServerPruneOptions,
) (PruneSummary, error) {
	if ctx == nil ||
		strings.TrimSpace(opts.AIHomeDir) == "" ||
		opts.Accounts == nil ||
		opts.Invalidator == nil {
		return PruneSummary{}, ErrInvalidOptions
	}
	if err := ctx.Err(); err != nil {
		return PruneSummary{}, err
	}

	// 在触碰任何运行态进程之前先完整读取账号表（fail-closed），避免数据库异常被误判为全量删号。
	accounts, err := opts.Accounts.ListRegisteredAccounts(ctx)
	if err != nil {
		return PruneSummary{}, err
	}
	byRef := make(map[string]RegisteredAccount, len(accounts))
	for _, account := range accounts {
		ref := strings.TrimSpace(account.AccountRef)
		if IsValidAccountRef(ref) {
			byRef[ref] = account
		}
	}

	stateDir := filepath.Join(filepath.Clean(strings.TrimSpace(opts.AIHomeDir)), "run", "codex-app-server")
	entries, err := os.ReadDir(stateDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return PruneSummary{}, nil
		}
		return PruneSummary{}, err
	}

	var summary PruneSummary
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return summary, err
		}
		name := entry.Name()
		if !entry.Type().IsRegular() || !strings.HasSuffix(name, ".json") {
			continue
		}
		if name == "gateway.json" || name == "chat-gateway.json" {
			summary.Kept++
			continue
		}

		statePath := filepath.Join(stateDir, name)
		target, ok := parseCodexAppServerStateFile(name, statePath)
		if !ok {
			summary.Failed++
			continue
		}

		account, registered := byRef[target.AccountRef]
		if registered && isAccountActive(account) {
			summary.Kept++
			continue
		}

		if err := opts.Invalidator.Invalidate(ctx, target); err != nil {
			summary.Failed++
			continue
		}
		if _, statErr := os.Stat(statePath); statErr == nil || !errors.Is(statErr, os.ErrNotExist) {
			summary.Failed++
			continue
		}
		summary.Removed++
	}
	return summary, nil
}

func isAccountActive(account RegisteredAccount) bool {
	if strings.TrimSpace(account.Status) != "" {
		return strings.EqualFold(strings.TrimSpace(account.Status), "up")
	}
	return account.Enabled
}

func parseCodexAppServerStateFile(name, statePath string) (CodexAppServerTarget, bool) {
	payload, err := os.ReadFile(statePath)
	if err != nil {
		return CodexAppServerTarget{}, false
	}
	var parsed rawCodexAppServerState
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return CodexAppServerTarget{}, false
	}
	// 必须是 JSON 对象；非对象会在前一步失败或字段校验不通过。
	trimmedPayload := strings.TrimSpace(string(payload))
	if !strings.HasPrefix(trimmedPayload, "{") {
		return CodexAppServerTarget{}, false
	}

	runtimeScope := strings.TrimSuffix(name, ".json")
	runtimeNamespace := ""
	accountRef := runtimeScope
	if strings.HasPrefix(runtimeScope, "chat-") {
		runtimeNamespace = "chat"
		accountRef = strings.TrimPrefix(runtimeScope, "chat-")
	}
	if !IsValidAccountRef(accountRef) {
		return CodexAppServerTarget{}, false
	}
	if ref := strings.TrimSpace(parsed.AccountRef); ref != "" && ref != accountRef {
		return CodexAppServerTarget{}, false
	}
	if scope := strings.TrimSpace(parsed.RuntimeScope); scope != "" && scope != runtimeScope {
		return CodexAppServerTarget{}, false
	}

	return CodexAppServerTarget{
		RuntimeScope:     runtimeScope,
		RuntimeNamespace: runtimeNamespace,
		AccountRef:       accountRef,
		StatePath:        statePath,
		Port:             parsePortNumber(parsed.Port),
		Socket:           strings.TrimSpace(parsed.Socket),
		Multiplexer:      strings.TrimSpace(parsed.Multiplexer),
	}, true
}

func parsePortNumber(raw json.RawMessage) int {
	text := strings.TrimSpace(string(raw))
	if text == "" || text == "null" {
		return 0
	}
	var n int
	if err := json.Unmarshal(raw, &n); err == nil && n > 0 && n <= 65535 {
		return n
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		if parsed, err := strconv.Atoi(strings.TrimSpace(s)); err == nil && parsed > 0 && parsed <= 65535 {
			return parsed
		}
	}
	return 0
}
