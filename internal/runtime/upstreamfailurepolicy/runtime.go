// Package upstreamfailurepolicy 把 server 配置里的失败语义全局覆盖应用到契约与
// core/accountruntime 的策略快照上。
//
// 配置形状（config:server 的 upstreamFailurePolicy）：
//
//	{
//	  "version": 1,
//	  "policies": {"upstream_unavailable": {"threshold": 3, "failure_window_ms": 120000}},
//	  "signals": [{"id": "global.402", "provider": "all", "statuses": [402], "semantic": "permission_denied", "block_scope": "account_model"}],
//	  "disable": ["builtin.all.status.408"]
//	}
//
// 该包是全局覆写的唯一入口：先做契约与策略快照的干跑校验，再原子应用，保证
// 任何一侧校验失败都不会留下半生效状态。
package upstreamfailurepolicy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	failurecontract "github.com/madou1217/ai_home/contracts/upstream-failure"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// ConfigKey 是 config:server 中承载覆盖的字段名。
const ConfigKey = "upstreamFailurePolicy"

// ErrInvalidConfig 表示全局覆盖不可用；写路径应把它变成 400。
var ErrInvalidConfig = errors.New("失败语义全局覆盖无效")

// Configure 解析并应用一份覆盖；nil 或空对象表示回到内置契约。
func Configure(raw any) error {
	override, err := ParseOverride(raw)
	if err != nil {
		return err
	}
	return apply(override)
}

// ParseOverride 把配置值转换为契约覆盖对象。
func ParseOverride(raw any) (*failurecontract.Override, error) {
	encoded, err := encodeRaw(raw)
	if err != nil {
		return nil, err
	}
	if len(encoded) == 0 {
		return nil, nil
	}
	var override failurecontract.Override
	if err := json.Unmarshal(encoded, &override); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidConfig, err)
	}
	if len(override.Policies) == 0 && len(override.Signals) == 0 && len(override.Disable) == 0 {
		return nil, nil
	}
	return &override, nil
}

// Load 从 aih.db 的 config:server 读取并应用覆盖。
//
// 数据库或键缺失视为未配置（回到内置契约），不影响服务启动。
func Load(ctx context.Context, aiHomeDir string) error {
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return err
	}
	raw, found, err := appstate.ReadKV(ctx, databasePath, appstate.KeyServerConfig)
	if err != nil {
		return err
	}
	if !found || strings.TrimSpace(raw) == "" {
		return nil
	}
	var object map[string]any
	if err := json.Unmarshal([]byte(raw), &object); err != nil {
		return fmt.Errorf("%w: config:server 不是合法 JSON", ErrInvalidConfig)
	}
	return Configure(object[ConfigKey])
}

// Validate 只校验配置值能否被应用，不修改生效快照；写路径用它做 400 判定。
func Validate(raw any) error {
	override, err := ParseOverride(raw)
	if err != nil {
		return err
	}
	if override == nil {
		return nil
	}
	if err := failurecontract.ValidateOverride(override); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidConfig, err)
	}
	overrides, err := coreOverrides(override)
	if err != nil {
		return err
	}
	if err := runtimecore.ValidatePolicyOverrides(overrides); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidConfig, err)
	}
	return nil
}

// Effective 返回合并覆盖后的契约视图，供 WebUI/CLI 展示。
func Effective() *failurecontract.Document {
	return failurecontract.Effective()
}

func apply(override *failurecontract.Override) error {
	if override == nil {
		if err := runtimecore.ApplyPolicyOverrides(nil); err != nil {
			return err
		}
		return failurecontract.ConfigureOverrides(nil)
	}
	if err := failurecontract.ValidateOverride(override); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidConfig, err)
	}
	overrides, err := coreOverrides(override)
	if err != nil {
		return err
	}
	if err := runtimecore.ValidatePolicyOverrides(overrides); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidConfig, err)
	}
	// 先应用策略快照（纯内存、不会失败），再替换契约信号表；两步都只换原子指针。
	if err := runtimecore.ApplyPolicyOverrides(overrides); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidConfig, err)
	}
	if err := failurecontract.ConfigureOverrides(override); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidConfig, err)
	}
	return nil
}

func coreOverrides(override *failurecontract.Override) ([]runtimecore.PolicyOverride, error) {
	if len(override.Policies) == 0 {
		return nil, nil
	}
	overrides := make([]runtimecore.PolicyOverride, 0, len(override.Policies))
	for kind, patch := range override.Policies {
		entry := runtimecore.PolicyOverride{Kind: runtimecore.FailureKind(strings.TrimSpace(kind))}
		if entry.Kind == "" {
			return nil, fmt.Errorf("%w: 策略覆盖缺少 kind", ErrInvalidConfig)
		}
		if patch.Threshold != nil {
			if *patch.Threshold < 1 || *patch.Threshold > 10 {
				return nil, fmt.Errorf("%w: 策略 %s 的阈值必须在 1..10", ErrInvalidConfig, kind)
			}
			threshold := uint8(*patch.Threshold)
			entry.Threshold = &threshold
		}
		if patch.FailureWindowMS != nil {
			if *patch.FailureWindowMS < 0 {
				return nil, fmt.Errorf("%w: 策略 %s 的失败窗口不能为负", ErrInvalidConfig, kind)
			}
			window := time.Duration(*patch.FailureWindowMS) * time.Millisecond
			entry.FailureWindow = &window
		}
		if patch.DefaultCooldownMS != nil {
			if *patch.DefaultCooldownMS <= 0 {
				return nil, fmt.Errorf("%w: 策略 %s 的默认冷却必须大于 0", ErrInvalidConfig, kind)
			}
			cooldown := time.Duration(*patch.DefaultCooldownMS) * time.Millisecond
			entry.DefaultCooldown = &cooldown
		}
		overrides = append(overrides, entry)
	}
	return overrides, nil
}

func encodeRaw(raw any) ([]byte, error) {
	switch value := raw.(type) {
	case nil:
		return nil, nil
	case string:
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			return nil, nil
		}
		return []byte(trimmed), nil
	case json.RawMessage:
		if len(value) == 0 {
			return nil, nil
		}
		return value, nil
	case map[string]any:
		if value == nil {
			return nil, nil
		}
		return json.Marshal(value)
	default:
		return json.Marshal(value)
	}
}