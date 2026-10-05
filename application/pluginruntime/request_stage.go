package pluginruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"
	"unicode/utf8"

	plugincontract "github.com/madou1217/ai_home/contracts/plugins"
)

// CapabilityGatewayRequest 是请求变换阶段的能力名。
const CapabilityGatewayRequest = "gateway.request"

const defaultRequestStepTimeout = 2 * time.Second

// Invoker 调用某代次的一个贡献项；实现负责连接 Plugin Host、超时与取消。
type Invoker interface {
	Invoke(ctx context.Context, generation int64, contributionID string, value any, timeout time.Duration) (json.RawMessage, error)
}

// StageError 是插件阶段失败（deny 策略下请求随之失败）。
type StageError struct {
	Code           string
	Message        string
	InstanceID     string
	ContributionID string
}

func (failure *StageError) Error() string {
	return fmt.Sprintf("插件 %s 的 %s：%s", failure.InstanceID, failure.ContributionID, failure.Message)
}

// Reject 是插件明确拒绝请求（只允许 4xx）。
type Reject struct {
	Status         int
	Message        string
	InstanceID     string
	ContributionID string
}

// RequestInput 是交给 gateway.request 的请求描述。
type RequestInput struct {
	Protocol string
	Path     string
	Body     json.RawMessage
}

// RequestOutcome 是 gateway.request 的结果：拒绝、或（可能改写过的）请求体。
// Changed 为 false 时 Body 就是原始字节，调用方必须原样使用，不能重新序列化。
type RequestOutcome struct {
	Reject  *Reject
	Body    json.RawMessage
	Changed bool
	Invoked int
}

// RunRequestStage 按投影顺序（waterfall）让插件变换或拒绝请求，语义与 Node 的
// lib/plugins/gateway/request-stage.js 一致：每一步之后核对身份字段（合同里的冻结清单与
// 所有 encrypted_content）；失败按 failurePolicy：deny 让请求失败，delegate 跳过该插件。
func RunRequestStage(ctx context.Context, invoker Invoker, projection Projection, input RequestInput) (RequestOutcome, error) {
	chain := projection.ByCapability(CapabilityGatewayRequest)
	original := input.Body
	if len(chain) == 0 {
		return RequestOutcome{Body: original}, nil
	}
	fingerprint, err := identityFingerprint(original)
	if err != nil {
		return RequestOutcome{}, &StageError{Code: "plugin_request_invalid", Message: "请求体不是 JSON 对象"}
	}
	current := original
	changed := false
	invoked := 0
	for _, item := range chain {
		next, reject, stepErr := runRequestStep(ctx, invoker, projection.Generation, item, input, current)
		if stepErr == nil && reject == nil && next != nil {
			nextPrint, printErr := identityFingerprint(next)
			if printErr != nil || !bytes.Equal(nextPrint, fingerprint) {
				stepErr = &StageError{Code: "plugin_identity_modified", Message: "不允许修改会话、续写或加密内容等身份字段", InstanceID: item.InstanceID, ContributionID: item.ID}
			}
		}
		if stepErr != nil {
			if item.FailurePolicy == "delegate" {
				continue
			}
			return RequestOutcome{}, stepErr
		}
		invoked++
		if reject != nil {
			return RequestOutcome{Reject: reject, Invoked: invoked}, nil
		}
		if next != nil {
			current = next
			changed = true
		}
	}
	return RequestOutcome{Body: current, Changed: changed, Invoked: invoked}, nil
}

func runRequestStep(
	ctx context.Context,
	invoker Invoker,
	generation int64,
	item Contribution,
	input RequestInput,
	current json.RawMessage,
) (json.RawMessage, *Reject, error) {
	var model struct {
		Model any `json:"model"`
	}
	_ = json.Unmarshal(current, &model)
	modelName, _ := model.Model.(string)
	value := map[string]any{
		"protocol": input.Protocol,
		"path":     input.Path,
		"model":    modelName,
		"body":     current,
	}
	raw, err := invoker.Invoke(ctx, generation, item.ID, value, defaultRequestStepTimeout)
	if err != nil {
		code := "plugin_failed"
		if coded, ok := err.(interface{ ErrorCode() string }); ok && coded.ErrorCode() != "" {
			code = coded.ErrorCode()
		}
		return nil, nil, &StageError{Code: code, Message: err.Error(), InstanceID: item.InstanceID, ContributionID: item.ID}
	}
	return normalizeRequestResult(item, raw)
}

// normalizeRequestResult 与 Node normalizeResult 一致：null 不改动；{reject} 拒绝（非 4xx 记为 403）；
// {body} 必须是 JSON 对象。
func normalizeRequestResult(item Contribution, raw json.RawMessage) (json.RawMessage, *Reject, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, nil, nil
	}
	invalid := func(message string) error {
		return &StageError{Code: "plugin_result_invalid", Message: message, InstanceID: item.InstanceID, ContributionID: item.ID}
	}
	var result map[string]json.RawMessage
	if trimmed[0] != '{' || json.Unmarshal(trimmed, &result) != nil {
		return nil, nil, invalid("返回值必须是对象")
	}
	if rejectRaw, ok := result["reject"]; ok && isTruthy(rejectRaw) {
		var reject struct {
			Status  json.Number `json:"status"`
			Message any         `json:"message"`
		}
		_ = json.Unmarshal(rejectRaw, &reject)
		status := 403
		if parsed, err := reject.Status.Int64(); err == nil && parsed >= 400 && parsed < 500 {
			status = int(parsed)
		}
		message := "请求被插件拒绝"
		if text, ok := reject.Message.(string); ok && text != "" {
			message = truncateRunes(text, 1000)
		}
		return nil, &Reject{Status: status, Message: message, InstanceID: item.InstanceID, ContributionID: item.ID}, nil
	}
	body, ok := result["body"]
	trimmedBody := bytes.TrimSpace(body)
	if !ok || len(trimmedBody) == 0 || trimmedBody[0] != '{' {
		return nil, nil, invalid("body 必须是 JSON 对象")
	}
	return trimmedBody, nil, nil
}

func isTruthy(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	switch string(trimmed) {
	case "", "null", "false", "0", `""`:
		return false
	}
	return true
}

func truncateRunes(text string, limit int) string {
	if utf8.RuneCountInString(text) <= limit {
		return text
	}
	return string([]rune(text)[:limit])
}

// identityFingerprint 是冻结字段与全部 encrypted_content 的规范化表示（数组保持顺序，对象键排序）。
func identityFingerprint(body json.RawMessage) ([]byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var root map[string]any
	if err := decoder.Decode(&root); err != nil || root == nil {
		return nil, fmt.Errorf("body is not an object")
	}
	top := make([][2]any, 0, len(plugincontract.GatewayRequestFrozenTopLevel))
	for _, key := range plugincontract.GatewayRequestFrozenTopLevel {
		top = append(top, [2]any{key, root[key]})
	}
	metadata, _ := root["metadata"].(map[string]any)
	meta := make([][2]any, 0, len(plugincontract.GatewayRequestFrozenMetadata))
	for _, key := range plugincontract.GatewayRequestFrozenMetadata {
		var value any
		if metadata != nil {
			value = metadata[key]
		}
		meta = append(meta, [2]any{key, value})
	}
	encrypted := make([]any, 0)
	collectEncrypted(root, &encrypted)
	return json.Marshal(map[string]any{"top": top, "metadata": meta, "encrypted": encrypted})
}

func collectEncrypted(value any, out *[]any) {
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			collectEncrypted(item, out)
		}
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			if key == "encrypted_content" {
				*out = append(*out, typed[key])
				continue
			}
			collectEncrypted(typed[key], out)
		}
	}
}
