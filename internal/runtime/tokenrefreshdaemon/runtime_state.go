package tokenrefreshdaemon

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// defaultAuthInvalidBlockDuration 对齐 Node ACCOUNT_GUESSED_COOLDOWN_MS (30s) 与
// sessionchat.accountGuessedCooldownMs：过期后允许下一次真实请求或显式恢复复核。
const defaultAuthInvalidBlockDuration = 30 * time.Second

// AccountStore 抽象 Token 后台续期所需的账号列表、静态模式识别与运行态读写端口。
type AccountStore interface {
	ListAccountOverviews(ctx context.Context, query accountapp.OverviewQuery) ([]accountapp.AccountOverview, error)
	IsAPIKeyAccount(ctx context.Context, accountRef accountcore.AccountRef) (bool, error)
	GetAccountState(ctx context.Context, accountRef accountcore.AccountRef) (runtimecore.AccountState, error)
	ReplaceAccountState(ctx context.Context, state runtimecore.AccountState, block *runtimecore.AccountBlock) error
	DeleteAccountState(ctx context.Context, accountRef accountcore.AccountRef) error
}

// AccountRuntimeNotifier 把数据库里的 auth_invalid 变更/恢复同步投影到内存调度门禁。
type AccountRuntimeNotifier interface {
	ApplyAccountState(ctx context.Context, state runtimecore.AccountState) error
	ClearAccountState(ctx context.Context, accountRef accountcore.AccountRef) error
	ClearAccountBlock(ctx context.Context, accountRef accountcore.AccountRef, trigger runtimecore.RecoveryTrigger) error
}

func markAccountAuthInvalid(
	ctx context.Context,
	store AccountStore,
	runtimeNotifier AccountRuntimeNotifier,
	accountRef accountcore.AccountRef,
	reason string,
	now time.Time,
) (bool, error) {
	if store == nil || ctx == nil || !accountRef.IsValid() {
		return false, nil
	}
	doc := make(map[string]any)
	existing, err := store.GetAccountState(ctx, accountRef)
	switch {
	case err == nil:
		if existing.DeriveStatus(now).Status() == "auth_invalid" {
			return false, nil
		}
		if len(existing.Document()) > 0 {
			if unmarshalErr := json.Unmarshal(existing.Document(), &doc); unmarshalErr != nil || doc == nil {
				doc = make(map[string]any)
			}
		}
	case errors.Is(err, accountapp.ErrAccountNotFound):
	default:
		return false, err
	}

	message := sanitizeReason(reason, 480)
	if message == "" {
		message = "auth_invalid_reauth_required"
	}
	nowMS := now.UnixMilli()
	untilMS := now.Add(defaultAuthInvalidBlockDuration).UnixMilli()
	ensureDefaultRuntimeBaseFields(doc)
	doc["cooldownUntil"] = untilMS
	doc["authInvalidUntil"] = untilMS
	doc["lastFailureKind"] = "auth_invalid"
	doc["lastFailureReason"] = message
	doc["lastError"] = message
	doc["lastFailureAt"] = nowMS
	doc["consecutiveFailures"] = nextPositiveInt64(doc["consecutiveFailures"])
	doc["failCount"] = nextPositiveInt64(doc["failCount"])

	rawDoc, err := json.Marshal(doc)
	if err != nil {
		return false, err
	}
	nextState, err := runtimecore.NewAccountState(runtimecore.AccountStateInput{
		AccountRef: accountRef,
		Document:   rawDoc,
		UpdatedAt:  now.UTC(),
	})
	if err != nil {
		return false, err
	}
	var blockPtr *runtimecore.AccountBlock
	if block, hasBlock := nextState.DeriveBlock(); hasBlock {
		blockPtr = &block
	}
	if err := store.ReplaceAccountState(ctx, nextState, blockPtr); err != nil {
		if errors.Is(err, accountapp.ErrAccountNotFound) {
			return false, nil
		}
		return false, err
	}
	if runtimeNotifier != nil {
		_ = runtimeNotifier.ApplyAccountState(ctx, nextState)
	}
	return true, nil
}

func clearAccountAuthInvalid(
	ctx context.Context,
	store AccountStore,
	runtimeNotifier AccountRuntimeNotifier,
	accountRef accountcore.AccountRef,
	now time.Time,
) (bool, error) {
	if runtimeNotifier != nil && accountRef.IsValid() {
		_ = runtimeNotifier.ClearAccountBlock(ctx, accountRef, runtimecore.RecoveryCredentialsUpdated)
	}
	if store == nil || ctx == nil || !accountRef.IsValid() {
		return false, nil
	}
	existing, err := store.GetAccountState(ctx, accountRef)
	if errors.Is(err, accountapp.ErrAccountNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var doc map[string]any
	if err := json.Unmarshal(existing.Document(), &doc); err != nil || doc == nil {
		return false, nil
	}
	hasAuthInvalid := existing.DeriveStatus(now).Status() == "auth_invalid" ||
		strings.TrimSpace(stringField(doc["lastFailureKind"])) == "auth_invalid" ||
		int64Field(doc["authInvalidUntil"]) > 0 ||
		routingBlockKind(doc) == "auth_invalid"
	if !hasAuthInvalid {
		return false, nil
	}

	doc["authInvalidUntil"] = int64(0)
	if strings.TrimSpace(stringField(doc["lastFailureKind"])) == "auth_invalid" {
		doc["lastFailureKind"] = ""
		doc["lastFailureReason"] = ""
		doc["lastError"] = ""
		doc["lastFailureAt"] = int64(0)
		doc["consecutiveFailures"] = int64(0)
		doc["cooldownUntil"] = int64(0)
	}
	if routingBlockKind(doc) == "auth_invalid" {
		delete(doc, "routingBlock")
	}

	if !hasRetainedRuntimeFields(doc) {
		if err := store.DeleteAccountState(ctx, accountRef); err != nil {
			return false, err
		}
		if runtimeNotifier != nil {
			_ = runtimeNotifier.ClearAccountState(ctx, accountRef)
		}
		return true, nil
	}

	rawDoc, err := json.Marshal(doc)
	if err != nil {
		return false, err
	}
	nextState, err := runtimecore.NewAccountState(runtimecore.AccountStateInput{
		AccountRef: accountRef,
		Document:   rawDoc,
		UpdatedAt:  now.UTC(),
	})
	if err != nil {
		return false, err
	}
	var blockPtr *runtimecore.AccountBlock
	if block, hasBlock := nextState.DeriveBlock(); hasBlock {
		blockPtr = &block
	}
	if err := store.ReplaceAccountState(ctx, nextState, blockPtr); err != nil {
		if errors.Is(err, accountapp.ErrAccountNotFound) {
			return false, nil
		}
		return false, err
	}
	if runtimeNotifier != nil {
		_ = runtimeNotifier.ApplyAccountState(ctx, nextState)
	}
	return true, nil
}

func ensureDefaultRuntimeBaseFields(doc map[string]any) {
	defaults := map[string]any{
		"successCount":            int64(0),
		"rateLimitUntil":          int64(0),
		"overloadUntil":           int64(0),
		"networkUntil":            int64(0),
		"serviceUnavailableUntil": int64(0),
		"upstreamErrorUntil":      int64(0),
	}
	for k, v := range defaults {
		if _, ok := doc[k]; !ok {
			doc[k] = v
		}
	}
}

func hasRetainedRuntimeFields(doc map[string]any) bool {
	if strings.TrimSpace(stringField(doc["lastFailureKind"])) != "" ||
		strings.TrimSpace(stringField(doc["lastFailureReason"])) != "" ||
		strings.TrimSpace(stringField(doc["lastError"])) != "" {
		return true
	}
	numericKeys := []string{
		"cooldownUntil",
		"consecutiveFailures",
		"successCount",
		"lastFailureAt",
		"lastSuccessAt",
		"rateLimitUntil",
		"authInvalidUntil",
		"overloadUntil",
		"networkUntil",
		"serviceUnavailableUntil",
		"upstreamErrorUntil",
	}
	for _, key := range numericKeys {
		if int64Field(doc[key]) > 0 {
			return true
		}
	}
	if block, ok := doc["routingBlock"].(map[string]any); ok && len(block) > 0 {
		return true
	}
	if cooldowns, ok := doc["modelCooldowns"].(map[string]any); ok && len(cooldowns) > 0 {
		return true
	}
	if streaks, ok := doc["modelFailureStreaks"].(map[string]any); ok && len(streaks) > 0 {
		return true
	}
	return false
}

func routingBlockKind(doc map[string]any) string {
	block, ok := doc["routingBlock"].(map[string]any)
	if !ok || block == nil {
		return ""
	}
	return strings.TrimSpace(stringField(block["kind"]))
}

func stringField(val any) string {
	str, _ := val.(string)
	return str
}

func int64Field(val any) int64 {
	switch typed := val.(type) {
	case int64:
		return typed
	case int:
		return int64(typed)
	case float64:
		if typed > 0 {
			return int64(typed)
		}
	case json.Number:
		if parsed, err := typed.Int64(); err == nil {
			return parsed
		}
	}
	return 0
}

func nextPositiveInt64(val any) int64 {
	current := int64Field(val)
	if current < 0 {
		current = 0
	}
	return current + 1
}
