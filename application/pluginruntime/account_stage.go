package pluginruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// CapabilityGatewayAccount 是账号偏好阶段的能力名。
const CapabilityGatewayAccount = "gateway.account"

const (
	defaultAccountStepTimeout = time.Second
	accountDescriptionTTL     = time.Minute
)

// AccountDescription 是交给插件的低敏账号描述。
type AccountDescription struct {
	Provider string
	AuthType string
}

// AccountDescriber 按 Go 账号引用查 Provider 与认证形态（只读无敏感投影）。
type AccountDescriber func(ctx context.Context, accountRef string) AccountDescription

// accountDescriptions 缓存账号描述（认证形态可能因重新登录而变化，所以带 TTL）。
type accountDescriptions struct {
	describe AccountDescriber
	mu       sync.Mutex
	entries  map[string]describedAccount
}

type describedAccount struct {
	value AccountDescription
	at    time.Time
}

func newAccountDescriptions(describe AccountDescriber) *accountDescriptions {
	return &accountDescriptions{describe: describe, entries: map[string]describedAccount{}}
}

func (cache *accountDescriptions) get(accountRef string) AccountDescription {
	if cache == nil || cache.describe == nil {
		return AccountDescription{}
	}
	cache.mu.Lock()
	entry, ok := cache.entries[accountRef]
	cache.mu.Unlock()
	if ok && time.Since(entry.at) < accountDescriptionTTL {
		return entry.value
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	value := cache.describe(ctx, accountRef)
	if value.Provider != "" {
		cache.mu.Lock()
		cache.entries[accountRef] = describedAccount{value: value, at: time.Now()}
		cache.mu.Unlock()
	}
	return value
}

// Prefer 实现 accountrouting.PreferenceProvider：按请求固定的代次运行 gateway.account，
// 语义与 Node 的 lib/plugins/gateway/account-stage.js 一致——插件只能在候选里挑选与排序
// （越界判为 plugin_scope_violation）；多个插件串行，后一个看到前一个调整后的顺序；
// 失败按 failurePolicy：deny 让请求失败，delegate 跳过。插件看到的是 Node 账号引用，
// 返回后翻译回 Go 引用。连不上 Plugin Host 时不表态（照常选号），不让 Go 侧的连接问题拖垮请求。
func (pin *Pin) Prefer(ctx context.Context, providerID string, modelID string, candidates []accountcore.AccountRef) ([]accountcore.AccountRef, error) {
	if pin == nil || pin.observer == nil {
		return nil, nil
	}
	chain := pin.Projection.ByCapability(CapabilityGatewayAccount)
	if len(chain) == 0 || len(candidates) == 0 {
		return nil, nil
	}
	registry := pin.observer.registry
	descriptions := make(map[string]map[string]string, len(candidates))
	order := make([]string, 0, len(candidates))
	allowed := make(map[string]bool, len(candidates))
	for _, ref := range candidates {
		nodeRef := registry.NodeAccountRef(ref.String())
		authType := pin.observer.accounts.get(ref.String()).AuthType
		if authType == "" {
			authType = "oauth"
		}
		descriptions[nodeRef] = map[string]string{"accountRef": nodeRef, "authType": authType}
		order = append(order, nodeRef)
		allowed[nodeRef] = true
	}
	preferred := map[string]bool{}
	for _, item := range chain {
		described := make([]map[string]string, 0, len(order))
		for _, ref := range order {
			described = append(described, descriptions[ref])
		}
		raw, err := pin.observer.invoker.Invoke(ctx, pin.Generation, item.ID, map[string]any{
			"provider": providerID, "model": modelID, "candidates": described,
		}, defaultAccountStepTimeout)
		var prefer []string
		if err == nil {
			prefer, err = normalizePreference(item, raw, allowed)
		} else if hostUnavailableCodes[errorCode(err)] {
			return nil, nil
		}
		if err != nil {
			if item.FailurePolicy == "delegate" {
				continue
			}
			var stageErr *StageError
			if errors.As(err, &stageErr) {
				return nil, err
			}
			return nil, &StageError{Code: firstNonEmpty(errorCode(err), "plugin_failed"), Message: err.Error(), InstanceID: item.InstanceID, ContributionID: item.ID}
		}
		if prefer == nil {
			continue
		}
		next := append([]string(nil), prefer...)
		for _, ref := range order {
			if !containsString(prefer, ref) {
				next = append(next, ref)
			}
		}
		order = next
		for _, ref := range prefer {
			preferred[ref] = true
		}
	}
	result := make([]accountcore.AccountRef, 0, len(preferred))
	for _, nodeRef := range order {
		if !preferred[nodeRef] {
			continue
		}
		ref, err := accountcore.ParseAccountRef(registry.GoAccountRef(nodeRef))
		if err == nil {
			result = append(result, ref)
		}
	}
	return result, nil
}

// normalizePreference 解析 { prefer: [accountRef] }；null 表示不表态。
func normalizePreference(item Contribution, raw json.RawMessage, allowed map[string]bool) ([]string, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, nil
	}
	var result struct {
		Prefer []any `json:"prefer"`
	}
	if trimmed[0] != '{' || json.Unmarshal(trimmed, &result) != nil || result.Prefer == nil {
		return nil, &StageError{Code: "plugin_result_invalid", Message: "返回值必须是 { prefer: [accountRef] }", InstanceID: item.InstanceID, ContributionID: item.ID}
	}
	prefer := make([]string, 0, len(result.Prefer))
	seen := map[string]bool{}
	for _, value := range result.Prefer {
		ref, _ := value.(string)
		if !allowed[ref] {
			return nil, &StageError{Code: "plugin_scope_violation", Message: "偏好了候选之外的账号", InstanceID: item.InstanceID, ContributionID: item.ID}
		}
		if !seen[ref] {
			seen[ref] = true
			prefer = append(prefer, ref)
		}
	}
	return prefer, nil
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
