package pluginhost

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	appplugins "github.com/madou1217/ai_home/application/pluginruntime"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

// ProviderDescriptorCapability 是插件声明 Provider 描述符的能力名。
const ProviderDescriptorCapability = "provider.descriptor"

const maxDescriptorTimeout = 5 * time.Second

var (
	providerIDPattern       = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)
	modelPrefixAliasPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)
)

// KnownQuotaSnapshotKinds 与 lib/account/usage-remaining.js 的 USAGE_SNAPSHOT_KINDS 对齐。
var KnownQuotaSnapshotKinds = map[string]bool{
	"codex_oauth_status":       true,
	"claude_oauth_usage":       true,
	"gemini_oauth_stats":       true,
	"agy_code_assist_quota":    true,
	"kimi_oauth_usage":         true,
	"grok_credit_usage":        true,
	"kiro_credit_usage":        true,
	"zcode_plan_balance":       true,
	"codebuddy_credit_balance": true,
	"cline_pass_usage":         true,
	"qoder_credit_usage":       true,
}

var (
	providerCapabilityNames = map[string]bool{
		"quota":               true,
		"models":              true,
		"usage":               true,
		"relay":               true,
		"authSources":         true,
		"hooks":               true,
		"acp":                 true,
		"egress":              true,
		"activity":            true,
		"providerModelPrefix": true,
	}
	quotaTransports     = map[string]bool{"http": true, "client-cli": true, "client-desktop": true}
	quotaSnapshotShapes = map[string]bool{"entries": true, "models": true}
	quotaEntryShapes    = map[string]bool{"window": true, "bucket": true, "models": true}
	modelTransports     = map[string]bool{"http": true, "cli": true, "local": true}
)

// DescriptorError 描述单条 provider.descriptor 收集或校验错误。
type DescriptorError struct {
	Code           string `json:"code"`
	Detail         string `json:"detail"`
	InstanceID     string `json:"instanceId,omitempty"`
	ContributionID string `json:"contributionId,omitempty"`
}

// AcceptedDescriptor 记录校验通过的 Provider 描述符及其贡献来源。
type AcceptedDescriptor struct {
	Descriptor     map[string]any `json:"descriptor"`
	ProviderID     string         `json:"providerId"`
	InstanceID     string         `json:"instanceId"`
	ContributionID string         `json:"contributionId"`
}

// DescriptorCollectResult 汇总一次 provider.descriptor 收集与校验结果。
type DescriptorCollectResult struct {
	Descriptors []map[string]any     `json:"descriptors"`
	Accepted    []AcceptedDescriptor `json:"accepted"`
	Errors      []DescriptorError    `json:"errors"`
}

// HandlerResolver 判断某个内置 Provider handler ID 是否可用；为 nil 时跳过宿主页 handler 存在性校验。
type HandlerResolver func(handlerID string) bool

// ValidateProviderDescriptor 校验单个外部插件 Provider 描述符的基本契约与结构边界，
// 语义与 lib/providers/contract.js 对齐。
func ValidateProviderDescriptor(raw map[string]any) (map[string]any, error) {
	if raw == nil {
		return nil, pluginerr.New(CodeDescriptorInvalid, "")
	}
	verFloat, hasVer := asFiniteFloat(raw["contractVersion"])
	if !hasVer || verFloat != 1 {
		return nil, pluginerr.New("provider_descriptor_contract_version_unsupported", fmt.Sprintf("%v", raw["contractVersion"]))
	}
	id := strings.ToLower(strings.TrimSpace(stringField(raw, "id")))
	if !providerIDPattern.MatchString(id) {
		return nil, pluginerr.New("provider_descriptor_id_invalid", id)
	}
	caps, ok := raw["capabilities"].(map[string]any)
	if !ok {
		caps = map[string]any{}
	}
	for name := range caps {
		if !providerCapabilityNames[name] {
			return nil, pluginerr.New("provider_descriptor_capability_unknown", name)
		}
	}
	quotaRaw, hasQuota := caps["quota"]
	if !hasQuota {
		return nil, pluginerr.New("provider_descriptor_quota_missing", id)
	}
	if err := validateQuotaCapability(id, quotaRaw); err != nil {
		return nil, err
	}
	if modelsRaw, ok := caps["models"]; ok {
		if err := validateModelsCapability(id, modelsRaw); err != nil {
			return nil, err
		}
	}
	if prefixRaw, ok := caps["providerModelPrefix"]; ok {
		if err := validateProviderModelPrefix(id, prefixRaw); err != nil {
			return nil, err
		}
	}
	if usageRaw, ok := caps["usage"]; ok {
		if _, isObj := usageRaw.(map[string]any); !isObj {
			return nil, pluginerr.New("provider_descriptor_usage_invalid", id)
		}
	}
	out := cloneJSONMap(raw)
	out["id"] = id
	return out, nil
}

func validateQuotaCapability(id string, raw any) error {
	quota, ok := raw.(map[string]any)
	if !ok {
		return pluginerr.New("provider_descriptor_quota_invalid", id)
	}
	supported, ok := quota["supported"].(bool)
	if !ok {
		return pluginerr.New("provider_descriptor_quota_supported_flag_invalid", id)
	}
	if !supported {
		if strings.TrimSpace(stringField(quota, "reason")) == "" {
			return pluginerr.New("provider_descriptor_quota_reason_missing", id)
		}
		kind := strings.TrimSpace(stringField(quota, "kind"))
		if kind != "" && !KnownQuotaSnapshotKinds[kind] {
			return pluginerr.New("provider_descriptor_quota_kind_unregistered", kind)
		}
		if err := validateQuotaShapes(quota); err != nil {
			return err
		}
		return nil
	}
	kind := strings.TrimSpace(stringField(quota, "kind"))
	if kind == "" {
		return pluginerr.New("provider_descriptor_quota_kind_missing", id)
	}
	if !KnownQuotaSnapshotKinds[kind] {
		return pluginerr.New("provider_descriptor_quota_kind_unregistered", kind)
	}
	if strings.TrimSpace(stringField(quota, "source")) == "" {
		return pluginerr.New("provider_descriptor_quota_source_missing", id)
	}
	if err := validateQuotaShapes(quota); err != nil {
		return err
	}
	strategies := mapSlice(quota, "strategies")
	if len(strategies) == 0 {
		return pluginerr.New("provider_descriptor_quota_strategies_missing", id)
	}
	seen := make(map[string]bool, len(strategies))
	for _, st := range strategies {
		sid := strings.TrimSpace(stringField(st, "id"))
		if sid == "" {
			return pluginerr.New("provider_descriptor_quota_strategy_id_missing", id)
		}
		if seen[sid] {
			return pluginerr.New("provider_descriptor_quota_strategy_duplicate", sid)
		}
		seen[sid] = true
		transport := strings.TrimSpace(stringField(st, "transport"))
		if !quotaTransports[transport] {
			return pluginerr.New("provider_descriptor_quota_transport_invalid", transport)
		}
		clientDep, _ := st["clientDependent"].(bool)
		if (transport == "http" && clientDep) || (transport != "http" && !clientDep) {
			return pluginerr.New("provider_descriptor_quota_transport_conflict", sid)
		}
		clientOpt, _ := st["clientOptional"].(bool)
		if clientDep && clientOpt {
			return pluginerr.New("provider_descriptor_quota_transport_conflict", sid)
		}
		if strings.TrimSpace(stringField(st, "handler")) == "" {
			return pluginerr.New("provider_descriptor_quota_strategy_impl_missing", sid)
		}
	}
	return nil
}

func validateQuotaShapes(quota map[string]any) error {
	shape := strings.TrimSpace(stringField(quota, "shape"))
	if shape != "" && !quotaSnapshotShapes[shape] {
		return pluginerr.New("provider_descriptor_quota_shape_invalid", shape)
	}
	entryShape := strings.TrimSpace(stringField(quota, "entryShape"))
	if entryShape != "" && !quotaEntryShapes[entryShape] {
		return pluginerr.New("provider_descriptor_quota_entry_shape_invalid", entryShape)
	}
	return nil
}

func validateModelsCapability(id string, raw any) error {
	models, ok := raw.(map[string]any)
	if !ok {
		return pluginerr.New("provider_descriptor_models_invalid", id)
	}
	supported, ok := models["supported"].(bool)
	if !ok {
		return pluginerr.New("provider_descriptor_models_supported_flag_invalid", id)
	}
	if !supported {
		if strings.TrimSpace(stringField(models, "reason")) == "" {
			return pluginerr.New("provider_descriptor_models_reason_missing", id)
		}
		return nil
	}
	strategies := mapSlice(models, "strategies")
	if len(strategies) == 0 {
		return pluginerr.New("provider_descriptor_models_strategies_missing", id)
	}
	seen := make(map[string]bool, len(strategies))
	for _, st := range strategies {
		sid := strings.TrimSpace(stringField(st, "id"))
		if sid == "" {
			return pluginerr.New("provider_descriptor_models_strategy_id_missing", id)
		}
		if seen[sid] {
			return pluginerr.New("provider_descriptor_models_strategy_duplicate", sid)
		}
		seen[sid] = true
		transport := strings.TrimSpace(stringField(st, "transport"))
		if !modelTransports[transport] {
			return pluginerr.New("provider_descriptor_models_transport_invalid", transport)
		}
		if strings.TrimSpace(stringField(st, "handler")) == "" {
			return pluginerr.New("provider_descriptor_models_strategy_impl_missing", sid)
		}
	}
	return nil
}

func validateProviderModelPrefix(id string, raw any) error {
	prefix, ok := raw.(map[string]any)
	if !ok {
		return pluginerr.New("provider_descriptor_provider_model_prefix_invalid", id)
	}
	supported, ok := prefix["supported"].(bool)
	if !ok {
		return pluginerr.New("provider_descriptor_provider_model_prefix_supported_flag_invalid", id)
	}
	if !supported {
		if strings.TrimSpace(stringField(prefix, "reason")) == "" {
			return pluginerr.New("provider_descriptor_provider_model_prefix_reason_missing", id)
		}
		return nil
	}
	rawAliases, _ := prefix["aliases"].([]any)
	seen := make(map[string]bool, len(rawAliases))
	for _, item := range rawAliases {
		alias := strings.ToLower(strings.TrimSpace(fmt.Sprintf("%v", item)))
		if !modelPrefixAliasPattern.MatchString(alias) {
			return pluginerr.New("provider_descriptor_provider_model_prefix_alias_invalid", id+":"+alias)
		}
		if seen[alias] {
			return pluginerr.New("provider_descriptor_provider_model_prefix_alias_duplicate", id+":"+alias)
		}
		seen[alias] = true
	}
	return nil
}

// ListMissingDescriptorHandlers 返回描述符中引用但宿主未注册的 strategy handler。
func ListMissingDescriptorHandlers(descriptor map[string]any, resolve HandlerResolver) []string {
	if resolve == nil {
		return nil
	}
	caps, _ := descriptor["capabilities"].(map[string]any)
	var missing []string
	for _, capName := range []string{"models", "quota"} {
		capObj, _ := caps[capName].(map[string]any)
		for _, st := range mapSlice(capObj, "strategies") {
			handler := strings.TrimSpace(stringField(st, "handler"))
			if handler == "" || resolve(handler) {
				continue
			}
			sid := strings.TrimSpace(stringField(st, "id"))
			if sid == "" {
				sid = "(unnamed)"
			}
			missing = append(missing, fmt.Sprintf("%s:%s→%s", capName, sid, handler))
		}
	}
	return missing
}

// CollectProviderDescriptors 从指定代次的 provider.descriptor 贡献项采集并校验 Provider 描述符。
//
// 遵守 failurePolicy 语义：
//   - contribution 自身失败时，记录 DescriptorError；若 FailurePolicy == "deny" 则返回首个阻断错误，
//     若 FailurePolicy == "delegate" 则仅记录错误并继续收集其余贡献项。
//   - 单条 descriptor 校验失败或重复声明同样在贡献项级别捕获并按上述策略处理。
func CollectProviderDescriptors(
	ctx context.Context,
	projection appplugins.Projection,
	invoke func(ctx context.Context, generation int64, contributionID string, value any, timeout time.Duration) (json.RawMessage, error),
	resolve HandlerResolver,
) (DescriptorCollectResult, error) {
	result := DescriptorCollectResult{
		Descriptors: []map[string]any{},
		Accepted:    []AcceptedDescriptor{},
		Errors:      []DescriptorError{},
	}
	chain := projection.ByCapability(ProviderDescriptorCapability)
	if len(chain) == 0 || invoke == nil {
		return result, nil
	}
	seen := make(map[string]appplugins.Contribution)
	for _, item := range chain {
		rawJSON, err := invoke(ctx, projection.Generation, item.ID, map[string]any{
			"schemaVersion": 1,
			"kind":          "descriptors",
		}, maxDescriptorTimeout)
		if err == nil {
			err = collectDescriptorContribution(rawJSON, item, seen, resolve, &result)
		}
		if err != nil {
			descErr := normalizeDescriptorError(err, item.InstanceID, item.ID)
			result.Errors = append(result.Errors, descErr)
			if item.FailurePolicy != "delegate" {
				return result, pluginerr.New(descErr.Code, descErr.Detail)
			}
		}
	}
	return result, nil
}

func collectDescriptorContribution(
	rawJSON json.RawMessage,
	item appplugins.Contribution,
	seen map[string]appplugins.Contribution,
	resolve HandlerResolver,
	result *DescriptorCollectResult,
) error {
	if len(strings.TrimSpace(string(rawJSON))) == 0 || string(rawJSON) == "null" {
		return nil
	}
	var decoded any
	if err := json.Unmarshal(rawJSON, &decoded); err != nil {
		return pluginerr.New(CodeDescriptorContributionInvalid, err.Error())
	}
	rawList, err := normalizeDescriptorValues(decoded, 0)
	if err != nil {
		return err
	}
	for _, rawDesc := range rawList {
		descriptor, err := ValidateProviderDescriptor(rawDesc)
		if err != nil {
			return err
		}
		id := stringField(descriptor, "id")
		if prev, dup := seen[id]; dup {
			return pluginerr.New(
				CodeDescriptorDuplicate,
				fmt.Sprintf("%s (already declared by %s)", id, firstNonEmpty(prev.InstanceID, prev.ID)),
			)
		}
		if missing := ListMissingDescriptorHandlers(descriptor, resolve); len(missing) > 0 {
			return pluginerr.New(CodeDescriptorHandlerUnavailable, fmt.Sprintf("%s: %s", id, strings.Join(missing, ", ")))
		}
		seen[id] = item
		result.Descriptors = append(result.Descriptors, descriptor)
		result.Accepted = append(result.Accepted, AcceptedDescriptor{
			Descriptor:     descriptor,
			ProviderID:     id,
			InstanceID:     item.InstanceID,
			ContributionID: item.ID,
		})
	}
	return nil
}

func normalizeDescriptorValues(value any, depth int) ([]map[string]any, error) {
	if depth > 4 {
		return nil, pluginerr.New(CodeDescriptorContributionInvalid, "nesting_too_deep")
	}
	if value == nil {
		return nil, nil
	}
	switch typed := value.(type) {
	case []any:
		var out []map[string]any
		for _, entry := range typed {
			sub, err := normalizeDescriptorValues(entry, depth+1)
			if err != nil {
				return nil, err
			}
			out = append(out, sub...)
		}
		return out, nil
	case map[string]any:
		if typed["kind"] == ProviderDescriptorCapability {
			if val, has := typed["value"]; has {
				return normalizeDescriptorValues(val, depth+1)
			}
		}
		if items, ok := typed["items"].([]any); ok {
			var out []map[string]any
			for _, entry := range items {
				next := entry
				if m, isMap := entry.(map[string]any); isMap {
					if val, has := m["value"]; has {
						next = val
					}
				}
				sub, err := normalizeDescriptorValues(next, depth+1)
				if err != nil {
					return nil, err
				}
				out = append(out, sub...)
			}
			return out, nil
		}
		if list, ok := typed["descriptors"].([]any); ok {
			return normalizeDescriptorValues(list, depth+1)
		}
		if single, has := typed["descriptor"]; has {
			return normalizeDescriptorValues(single, depth+1)
		}
		if _, hasVer := typed["contractVersion"]; hasVer {
			if _, hasID := typed["id"]; hasID {
				if _, hasCaps := typed["capabilities"]; hasCaps {
					return []map[string]any{typed}, nil
				}
			}
		}
		return nil, pluginerr.New(CodeDescriptorContributionInvalid, "expected_descriptor_or_descriptors")
	default:
		return nil, pluginerr.New(CodeDescriptorContributionInvalid, fmt.Sprintf("%T", value))
	}
}

func normalizeDescriptorError(err error, instanceID, contributionID string) DescriptorError {
	code := errorCode(err)
	if code == "" {
		code = CodeDescriptorCollectFailed
	}
	detail := ""
	if coded, ok := pluginerr.From(err); ok {
		detail = coded.Message
	} else if err != nil {
		detail = err.Error()
	}
	if len(detail) > 240 {
		detail = detail[:240]
	}
	return DescriptorError{
		Code:           code,
		Detail:         detail,
		InstanceID:     instanceID,
		ContributionID: contributionID,
	}
}

func asFiniteFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	default:
		return 0, false
	}
}

func cloneJSONMap(src map[string]any) map[string]any {
	if src == nil {
		return nil
	}
	raw, err := json.Marshal(src)
	if err != nil {
		return nil
	}
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return out
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
