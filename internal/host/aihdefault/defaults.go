// Package aihdefault 承载 set-default 在宿主侧的 Go 原语。
//
// 职责边界（与 Node 的 lib/account/default-account-store.js、host-default-landing.js、
// host-gateway-profile.js 对齐）：
//
//   - 「AIH Server 默认档位」指针：app_kv 的 provider:default:<provider> = .aih-server。
//   - 受管宿主配置文件的网关落点与还原：.aih-server-default-state.json 记录接管前
//     原值，归属按整文件哈希判定（ownership=file）。
//
// 账号级默认指针（account:default:<provider>）不在这里重复实现：Go Core 已把它迁到
// account_defaults 表（core/accounts + internal/adapters/accounts/sqliteaccount），
// 双写会让 Node 与 Go 的默认关系打架。
//
// 本包只做可测试的文件/配置原语；宿主配置内容构造（opencode JSONC、kimi TOML、
// claude settings env、codex config.toml）与真正的宿主同步仍在 Node。
package aihdefault

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	// ServerProfileID 是「默认账号未指定 ⇒ AIH Server 接管」的档位值。
	ServerProfileID = ".aih-server"

	providerDefaultKeyPrefix = "provider:default:"
)

// 与 Node 决策层共用的错误码/原因串。调用方直接把它们透出给 CLI/WebUI。
const (
	CodeProfileUnsupported   = "gateway_profile_not_supported"
	CodeInvalidProfile       = "invalid_default_provider_profile"
	CodeProfileWriteFailed   = "default_provider_profile_write_failed"
	CodeScopeUnavailable     = "host_scope_unavailable"
	CodeHostSyncUnavailable  = "host_sync_unavailable"
	CodeGatewaySyncFailed    = "gateway_config_sync_failed"
	CodeGatewayRestoreFailed = "gateway_default_restore_failed"
)

// Error 带稳定的原因码，方便上层映射成与 Node 一致的 reason。
type Error struct {
	Code string
	Err  error
}

func (err *Error) Error() string {
	if err == nil {
		return ""
	}
	if err.Err != nil {
		return err.Code + ": " + err.Err.Error()
	}
	return err.Code
}

func (err *Error) Unwrap() error {
	if err == nil {
		return nil
	}
	return err.Err
}

// CodeOf 返回错误链里最近的原因码；没有则返回空串。
func CodeOf(err error) string {
	var typed *Error
	if errors.As(err, &typed) && typed != nil {
		return typed.Code
	}
	return ""
}

func newError(code string, cause error) error {
	return &Error{Code: code, Err: cause}
}

// NormalizeProvider 与 Node providerCatalog.normalize 一致：去空白 + 小写。
func NormalizeProvider(provider string) string {
	return strings.ToLower(strings.TrimSpace(provider))
}

// ProviderDefaultKey 返回 AIH Server 档位的键；键名与 Node 完全一致，
// 两侧共用同一份 app_kv 数据。
func ProviderDefaultKey(provider string) string {
	normalized := NormalizeProvider(provider)
	if normalized == "" {
		return ""
	}
	return providerDefaultKeyPrefix + normalized
}

// Store 读写默认档位指针。DatabasePath 是 app-state.db 的路径；Catalog 决定
// 哪些 Provider 存在「AIH Server 默认」这一档（capability=gateway_profile）。
type Store struct {
	DatabasePath string
	Catalog      *providers.Catalog
}

// ResolveProvider 归一 Provider 并判断它是否支持网关档位。
func (store Store) ResolveProvider(provider string) (string, bool) {
	normalized := NormalizeProvider(provider)
	if normalized == "" || store.Catalog == nil {
		return normalized, false
	}
	canonicalID, found := store.Catalog.CanonicalID(normalized)
	if !found || !store.Catalog.Supports(canonicalID, providers.CapabilityGatewayProfile) {
		return normalized, false
	}
	return normalized, true
}

// ReadProviderProfile 读取档位。未支持、未设置、值不是 .aih-server 都返回空串；
// 损坏的 JSON 也按未设置处理（与 Node readJsonValue 的吞错口径一致）。
func (store Store) ReadProviderProfile(ctx context.Context, provider string) (string, error) {
	key := ProviderDefaultKey(provider)
	if _, supported := store.ResolveProvider(provider); !supported || key == "" {
		return "", nil
	}
	if err := store.requireDatabase(); err != nil {
		return "", err
	}
	raw, found, err := appstate.ReadKV(ctx, store.DatabasePath, key)
	if err != nil || !found {
		return "", err
	}
	var value string
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return "", nil
	}
	if strings.TrimSpace(value) != ServerProfileID {
		return "", nil
	}
	return ServerProfileID, nil
}

// WriteProviderProfile 写入档位。只接受 .aih-server，且 Provider 必须声明
// gateway_profile 能力——写一个启动链路不认识的档位等于制造错配。
func (store Store) WriteProviderProfile(ctx context.Context, provider, profile string) error {
	key := ProviderDefaultKey(provider)
	if _, supported := store.ResolveProvider(provider); !supported || key == "" {
		return newError(CodeInvalidProfile, fmt.Errorf("provider %q", provider))
	}
	if strings.TrimSpace(profile) != ServerProfileID {
		return newError(CodeInvalidProfile, fmt.Errorf("profile %q", profile))
	}
	if err := store.requireDatabase(); err != nil {
		return err
	}
	encoded, err := json.Marshal(ServerProfileID)
	if err != nil {
		return newError(CodeProfileWriteFailed, err)
	}
	if err := appstate.WriteKV(ctx, store.DatabasePath, key, string(encoded), time.Now().UnixMilli()); err != nil {
		return newError(CodeProfileWriteFailed, err)
	}
	return nil
}

// ClearProviderProfile 删除档位；原本没有该键时返回 false。
func (store Store) ClearProviderProfile(ctx context.Context, provider string) (bool, error) {
	key := ProviderDefaultKey(provider)
	if key == "" {
		return false, nil
	}
	if err := store.requireDatabase(); err != nil {
		return false, err
	}
	if _, statErr := os.Stat(store.DatabasePath); statErr != nil {
		if errors.Is(statErr, os.ErrNotExist) {
			return false, nil
		}
		return false, statErr
	}
	db, err := appstate.OpenWritable(ctx, store.DatabasePath)
	if err != nil {
		return false, err
	}
	defer func() { _ = db.Close() }()
	result, err := db.ExecContext(ctx, "DELETE FROM app_kv WHERE key = ?", key)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no such table") {
			return false, nil
		}
		return false, err
	}
	changes, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return changes > 0, nil
}

func (store Store) requireDatabase() error {
	if strings.TrimSpace(store.DatabasePath) == "" {
		return newError(CodeScopeUnavailable, nil)
	}
	return nil
}
