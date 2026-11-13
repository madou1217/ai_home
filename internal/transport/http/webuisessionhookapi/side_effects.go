package webuisessionhookapi

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var providerAccountRefPattern = regexp.MustCompile(`^acct_[a-f0-9]{20}$`)

// TurnAction 表示单条 hook 对账号实时活跃态的影响。
type TurnAction string

const (
	TurnActionNone  TurnAction = ""
	TurnActionAlive TurnAction = "alive"
	TurnActionDone  TurnAction = "done"
)

// AccountActivityTracker 记录 CLI 原生会话的 in-flight 回合活跃度。
type AccountActivityTracker interface {
	MarkSessionTurn(provider, accountRef string)
	EndSessionTurn(provider, accountRef string)
}

// OutcomeRecorder 记录账号维度健康统计结果（success / unclassified）。
type OutcomeRecorder interface {
	RecordHookOutcome(ctx context.Context, provider, accountRef, outcome string, at time.Time)
}

// RuntimeRecoverer 在收到已验证成功的 official hook 时清除对应账号的活动阻塞。
type RuntimeRecoverer interface {
	RecoverOnHookSuccess(ctx context.Context, provider, accountRef string, happenedAtMs int64) bool
}

var subordinateCompletionEvents = map[string]bool{
	"SubagentStop":       true,
	"TaskCompleted":      true,
	"AfterTool":          true,
	"PostToolUse":        true,
	"PostToolUseFailure": true,
	"PostToolBatch":      true,
	"PostInvocation":     true,
}

var turnAliveEventTypes = map[string]bool{
	"session:turn-started": true,
	"session:turn-updated": true,
}

var turnDoneEventTypes = map[string]bool{
	"session:turn-completed": true,
	"session:turn-failed":    true,
	"session:closed":         true,
}

// NormalizeProviderAccountRef 校验并返回合法的 acct_* 引用；非法则返回空串。
func NormalizeProviderAccountRef(value string) string {
	trimmed := strings.TrimSpace(value)
	if providerAccountRefPattern.MatchString(trimmed) {
		return trimmed
	}
	return ""
}

// ResolveSessionTurnAction 按与 Node provider-hook-account-activity.js 一致的规则决定账号活跃状态。
func ResolveSessionTurnAction(eventType, eventName string) TurnAction {
	t := strings.TrimSpace(eventType)
	name := strings.TrimSpace(eventName)
	if turnAliveEventTypes[t] {
		return TurnActionAlive
	}
	if !turnDoneEventTypes[t] {
		return TurnActionNone
	}
	if t != "session:closed" && subordinateCompletionEvents[name] {
		return TurnActionAlive
	}
	return TurnActionDone
}

// ResolveSessionTurnOutcome 返回该 hook 是否产出一条账号健康结果（success / unclassified）。
func ResolveSessionTurnOutcome(eventType, eventName string) string {
	t := strings.TrimSpace(eventType)
	name := strings.TrimSpace(eventName)
	if !turnDoneEventTypes[t] || t == "session:closed" || subordinateCompletionEvents[name] {
		return ""
	}
	if t == "session:turn-failed" {
		return "unclassified"
	}
	return "success"
}

// bindPersistentSessionByCorrelation 将 Codex 原生 thread ID 回写到 run/persistent-sessions 匹配项。
// 保留既有 JSON 字段大小写（兼容 Node camelCase 与 Go snake_case）。
func bindPersistentSessionByCorrelation(aiHomeDir, provider, correlationID, nativeSessionID string) bool {
	cleanHome := strings.TrimSpace(aiHomeDir)
	normalizedProvider := strings.ToLower(strings.TrimSpace(provider))
	corr := strings.TrimSpace(correlationID)
	nativeID := strings.TrimSpace(nativeSessionID)
	if cleanHome == "" || normalizedProvider == "" || corr == "" || nativeID == "" {
		return false
	}
	if len(corr) > 512 || len(nativeID) > 512 || strings.ContainsRune(corr, '\x00') || strings.ContainsRune(nativeID, '\x00') {
		return false
	}

	dir := filepath.Join(cleanHome, "run", "persistent-sessions")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		filePath := filepath.Join(dir, entry.Name())
		raw, readErr := os.ReadFile(filePath)
		if readErr != nil {
			continue
		}
		var doc map[string]any
		if json.Unmarshal(raw, &doc) != nil || doc == nil {
			continue
		}
		entryProvider := strings.ToLower(anyText(doc["provider"]))
		entryCorr := firstText(anyText(doc["correlationId"]), anyText(doc["correlation_id"]))
		if entryProvider != normalizedProvider || entryCorr != corr {
			continue
		}
		if _, hasCamel := doc["nativeSessionId"]; hasCamel || !hasKey(doc, "native_id") {
			doc["nativeSessionId"] = nativeID
		} else {
			doc["native_id"] = nativeID
		}
		encoded, marshalErr := json.MarshalIndent(doc, "", "  ")
		if marshalErr != nil {
			return false
		}
		if writePersistentAtomic(filePath, append(encoded, '\n')) == nil {
			return true
		}
		return false
	}
	return false
}

func writePersistentAtomic(targetPath string, content []byte) error {
	dir := filepath.Dir(targetPath)
	tmp, err := os.CreateTemp(dir, ".psess-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(content); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, targetPath); err != nil {
		return err
	}
	cleanup = false
	return nil
}
