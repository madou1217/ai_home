package pluginhost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	appplugins "github.com/madou1217/ai_home/application/pluginruntime"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

// NetworkConnectorCapability 是外部网络接入插件的能力名。
const NetworkConnectorCapability = "network.connector"

const (
	defaultNetworkConnectorTimeout = 10 * time.Second
	maxNetworkConnectorPayload     = 256 * 1024
	maxNetworkConnectorItems       = 64
	maxNetworkConnectorText        = 512
)

var (
	networkConnectorIPv4RE = regexp.MustCompile(`\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b`)
	networkConnectorURLRE  = regexp.MustCompile(`(?i)https?://[^\s]+`)
	networkConnectorPathRE = regexp.MustCompile(`(?:/Users/|/home/|/var/|[A-Za-z]:\\)[^\s]+`)
)

// NetworkConnector 是经插件贡献项 describe 得到的脱敏连接器描述。
type NetworkConnector struct {
	ID           string                      `json:"id"`
	Name         string                      `json:"name"`
	Description  string                      `json:"description,omitempty"`
	Transport    string                      `json:"transport,omitempty"`
	Operations   []NetworkConnectorOperation `json:"operations"`
	Config       NetworkConnectorConfig      `json:"config,omitempty"`
	Connectivity []string                    `json:"connectivityModes,omitempty"`
	InstanceID   string                      `json:"instanceId"`
	Contribution string                      `json:"contributionId"`
	Generation   int64                       `json:"generation"`
}

// NetworkConnectorOperation 是插件声明的连接器操作。宿主不为未声明的操作生成 UI。
type NetworkConnectorOperation struct {
	ID    string `json:"id"`
	Label string `json:"label,omitempty"`
	// InputKind 控制 WebUI 是否向该操作发送插件自定义输入。
	// none 是默认值；custom 使用普通文本/JSON 输入；secret 使用密码输入。
	InputKind    string `json:"inputKind,omitempty"`
	Confirmation string `json:"confirmation,omitempty"`
}

// NetworkConnectorConfig 描述配置 schema 的脱敏投影。
type NetworkConnectorConfig struct {
	Schema       any      `json:"schema,omitempty"`
	SecretFields []string `json:"secretFields,omitempty"`
}

// NetworkConnectorStatus 是插件返回的脱敏状态。
type NetworkConnectorStatus struct {
	Installed    bool                 `json:"installed"`
	Enabled      bool                 `json:"enabled"`
	Running      bool                 `json:"running"`
	State        string               `json:"state,omitempty"`
	Version      string               `json:"version,omitempty"`
	Message      string               `json:"message,omitempty"`
	Connectivity *NetworkConnectivity `json:"connectivity,omitempty"`
}

// NetworkConnectivity 把直连、中继、DERP、出站隧道和未知路径明确区分。
type NetworkConnectivity struct {
	Mode       string                       `json:"mode"`
	Confidence string                       `json:"confidence,omitempty"`
	ObservedAt string                       `json:"observedAt,omitempty"`
	PeerID     string                       `json:"peerId,omitempty"`
	LatencyMs  int                          `json:"latencyMs,omitempty"`
	Evidence   *NetworkConnectivityEvidence `json:"evidence,omitempty"`
}

// NetworkConnectivityEvidence 是可复核但不包含凭据的探测来源。
type NetworkConnectivityEvidence struct {
	Source    string `json:"source,omitempty"`
	Path      string `json:"path,omitempty"`
	Transport string `json:"transport,omitempty"`
}

// NetworkConnectorView 是 WebUI/CLI 返回的一条连接器视图。
type NetworkConnectorView struct {
	Connector NetworkConnector        `json:"connector"`
	Status    *NetworkConnectorStatus `json:"status,omitempty"`
	Error     string                  `json:"error,omitempty"`
}

// NetworkConnectorOperationResult 是一次连接器操作的结构化结果。
type NetworkConnectorOperationResult struct {
	ConnectorID string                  `json:"connectorId"`
	Action      string                  `json:"action"`
	OK          bool                    `json:"ok"`
	Changed     bool                    `json:"changed,omitempty"`
	Message     string                  `json:"message,omitempty"`
	Status      *NetworkConnectorStatus `json:"status,omitempty"`
}

// ListNetworkConnectors 返回当前激活代次中所有 network.connector 贡献项。
// 连接器描述/状态来自插件；核心不包含厂商枚举。
func (s *Service) ListNetworkConnectors(ctx context.Context) ([]NetworkConnectorView, error) {
	if s == nil || s.runtime == nil {
		return nil, pluginerr.New(CodeRuntimeUnavailable, "插件运行时不可用")
	}
	lease := s.runtime.Acquire()
	if lease == nil {
		return []NetworkConnectorView{}, nil
	}
	defer lease.Release()

	chain := lease.Snapshot.Projection.ByCapability(NetworkConnectorCapability)
	if len(chain) > maxNetworkConnectorItems {
		chain = chain[:maxNetworkConnectorItems]
	}
	views := make([]NetworkConnectorView, 0, len(chain))
	seen := make(map[string]struct{}, len(chain))
	for _, item := range chain {
		connector, status, err := s.describeNetworkConnector(ctx, lease.Generation, item)
		if err != nil {
			views = append(views, NetworkConnectorView{
				Connector: NetworkConnector{InstanceID: item.InstanceID, Contribution: item.ID, Generation: lease.Generation},
				Error:     safeNetworkConnectorError(err),
			})
			continue
		}
		if _, exists := seen[connector.ID]; exists {
			return nil, pluginerr.New("network_connector_duplicate", "重复的网络连接器 id："+connector.ID)
		}
		seen[connector.ID] = struct{}{}
		views = append(views, NetworkConnectorView{Connector: connector, Status: status})
	}
	return views, nil
}

// OperateNetworkConnector 调用一个插件声明的连接器操作。
// 需要确认的操作默认拒绝，避免非 UI 调用绕过显式确认。
func (s *Service) OperateNetworkConnector(ctx context.Context, connectorID, action string, input any) (NetworkConnectorOperationResult, error) {
	return s.operateNetworkConnector(ctx, connectorID, action, input, false)
}

// OperateNetworkConnectorWithConfirmation 是管理面在用户明确确认后使用的入口。
// confirmed 不是鉴权边界；调用者仍必须通过管理授权。
func (s *Service) OperateNetworkConnectorWithConfirmation(ctx context.Context, connectorID, action string, input any, confirmed bool) (NetworkConnectorOperationResult, error) {
	return s.operateNetworkConnector(ctx, connectorID, action, input, confirmed)
}

func (s *Service) operateNetworkConnector(ctx context.Context, connectorID, action string, input any, confirmed bool) (NetworkConnectorOperationResult, error) {
	id := strings.TrimSpace(connectorID)
	operation := strings.TrimSpace(action)
	if id == "" || operation == "" {
		return NetworkConnectorOperationResult{}, pluginerr.New("network_connector_operation_required", "connectorId 和 action 必填")
	}
	if len(operation) > 128 {
		return NetworkConnectorOperationResult{}, pluginerr.New("network_connector_operation_invalid", "action 超过长度限制")
	}
	if s == nil || s.runtime == nil {
		return NetworkConnectorOperationResult{}, pluginerr.New(CodeRuntimeUnavailable, "插件运行时不可用")
	}
	lease := s.runtime.Acquire()
	if lease == nil {
		return NetworkConnectorOperationResult{}, pluginerr.New("plugin_runtime_inactive", "当前没有已发布的插件代次")
	}
	defer lease.Release()

	var (
		owner      *appplugins.Contribution
		descriptor NetworkConnector
	)
	for _, item := range lease.Snapshot.Projection.ByCapability(NetworkConnectorCapability) {
		if id == item.ID || id == item.InstanceID {
			itemCopy := item
			owner = &itemCopy
			break
		}
		candidate, _, err := s.describeNetworkConnector(ctx, lease.Generation, item)
		if err != nil || candidate.ID != id {
			continue
		}
		itemCopy := item
		owner = &itemCopy
		descriptor = candidate
		break
	}
	if owner == nil {
		return NetworkConnectorOperationResult{}, pluginerr.New("network_connector_unknown", "未知网络连接器："+id)
	}
	if descriptor.ID == "" {
		var err error
		descriptor, _, err = s.describeNetworkConnector(ctx, lease.Generation, *owner)
		if err != nil {
			return NetworkConnectorOperationResult{}, err
		}
	}
	declared := false
	var declaredOperation NetworkConnectorOperation
	for _, item := range descriptor.Operations {
		if item.ID == operation {
			declared = true
			declaredOperation = item
			break
		}
	}
	if !declared {
		return NetworkConnectorOperationResult{}, pluginerr.New("network_connector_operation_unsupported", "连接器未声明该操作："+operation)
	}
	if requiresNetworkConnectorConfirmation(declaredOperation) && !confirmed {
		return NetworkConnectorOperationResult{}, pluginerr.New("network_connector_confirmation_required", "该网络连接器操作需要明确确认")
	}
	if input == nil {
		input = map[string]any{}
	}
	encodedInput, err := json.Marshal(input)
	if err != nil || len(encodedInput) > maxNetworkConnectorPayload {
		return NetworkConnectorOperationResult{}, pluginerr.New("network_connector_payload_too_large", "连接器输入超过大小限制")
	}
	payload := map[string]any{
		"schemaVersion": 1,
		"kind":          "operate",
		"connectorId":   descriptor.ID,
		"action":        operation,
		"input":         input,
	}
	raw, err := s.runtime.Invoke(ctx, lease.Generation, owner.ID, payload, defaultNetworkConnectorTimeout)
	if err != nil {
		return NetworkConnectorOperationResult{}, err
	}
	result, err := decodeNetworkConnectorOperation(raw)
	if err != nil {
		return NetworkConnectorOperationResult{}, err
	}
	result.ConnectorID = descriptor.ID
	result.Action = operation
	return result, nil
}

func (s *Service) describeNetworkConnector(ctx context.Context, generation int64, item appplugins.Contribution) (NetworkConnector, *NetworkConnectorStatus, error) {
	base := map[string]any{"schemaVersion": 1, "kind": "describe"}
	raw, err := s.runtime.Invoke(ctx, generation, item.ID, base, defaultNetworkConnectorTimeout)
	if err != nil {
		return NetworkConnector{}, nil, err
	}
	if len(raw) > maxNetworkConnectorPayload {
		return NetworkConnector{}, nil, pluginerr.New("network_connector_payload_too_large", "连接器描述超过大小限制")
	}
	var response struct {
		Connector NetworkConnector `json:"connector"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return NetworkConnector{}, nil, pluginerr.New("network_connector_descriptor_invalid", "连接器 describe 返回值不是合法 JSON")
	}
	connector := sanitizeNetworkConnector(response.Connector)
	connector.InstanceID = item.InstanceID
	connector.Contribution = item.ID
	connector.Generation = generation
	if err := validateNetworkConnector(connector); err != nil {
		return NetworkConnector{}, nil, err
	}
	statusRaw, err := s.runtime.Invoke(ctx, generation, item.ID, map[string]any{"schemaVersion": 1, "kind": "status"}, defaultNetworkConnectorTimeout)
	if err != nil {
		return connector, nil, err
	}
	if len(statusRaw) > maxNetworkConnectorPayload {
		return NetworkConnector{}, nil, pluginerr.New("network_connector_payload_too_large", "连接器状态超过大小限制")
	}
	var statusResponse struct {
		Status NetworkConnectorStatus `json:"status"`
	}
	if err := json.Unmarshal(statusRaw, &statusResponse); err != nil {
		return NetworkConnector{}, nil, pluginerr.New("network_connector_status_invalid", "连接器 status 返回值不是合法 JSON")
	}
	statusResponse.Status = sanitizeNetworkConnectorStatus(statusResponse.Status)
	if err := validateNetworkConnectorStatus(statusResponse.Status); err != nil {
		return NetworkConnector{}, nil, err
	}
	return connector, &statusResponse.Status, nil
}

func decodeNetworkConnectorOperation(raw json.RawMessage) (NetworkConnectorOperationResult, error) {
	if len(raw) > maxNetworkConnectorPayload {
		return NetworkConnectorOperationResult{}, pluginerr.New("network_connector_payload_too_large", "连接器操作结果超过大小限制")
	}
	var result NetworkConnectorOperationResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return NetworkConnectorOperationResult{}, pluginerr.New("network_connector_operation_invalid", "连接器 operate 返回值不是合法 JSON")
	}
	if !result.OK && strings.TrimSpace(result.Message) == "" {
		result.Message = "连接器操作失败"
	}
	result.Message = sanitizeNetworkConnectorText(result.Message, maxNetworkConnectorText)
	if result.Status != nil {
		sanitized := sanitizeNetworkConnectorStatus(*result.Status)
		result.Status = &sanitized

		if err := validateNetworkConnectorStatus(*result.Status); err != nil {
			return NetworkConnectorOperationResult{}, err
		}
	}
	return result, nil
}

func requiresNetworkConnectorConfirmation(operation NetworkConnectorOperation) bool {
	switch strings.TrimSpace(operation.ID) {
	case "install", "uninstall", "enable", "disable", "configure":
		return true
	}
	return strings.TrimSpace(operation.Confirmation) == "required"
}

func sanitizeNetworkConnector(connector NetworkConnector) NetworkConnector {
	connector.Name = sanitizeNetworkConnectorText(connector.Name, 160)
	connector.Description = sanitizeNetworkConnectorText(connector.Description, maxNetworkConnectorText)
	connector.Transport = sanitizeNetworkConnectorText(connector.Transport, 96)
	for index := range connector.Operations {
		connector.Operations[index].ID = strings.TrimSpace(connector.Operations[index].ID)
		connector.Operations[index].Label = sanitizeNetworkConnectorText(connector.Operations[index].Label, 96)
		connector.Operations[index].InputKind = strings.TrimSpace(connector.Operations[index].InputKind)
		connector.Operations[index].Confirmation = strings.TrimSpace(connector.Operations[index].Confirmation)
	}
	connector.Config.Schema = sanitizeNetworkConnectorSchema(connector.Config.Schema)
	fields := make([]string, 0, len(connector.Config.SecretFields))
	seen := make(map[string]struct{}, len(connector.Config.SecretFields))
	for _, field := range connector.Config.SecretFields {
		field = strings.TrimSpace(field)
		if field == "" || len(field) > 128 {
			continue
		}
		if _, exists := seen[field]; exists {
			continue
		}
		seen[field] = struct{}{}
		fields = append(fields, field)
	}
	connector.Config.SecretFields = fields
	return connector
}

func sanitizeNetworkConnectorStatus(status NetworkConnectorStatus) NetworkConnectorStatus {
	status.State = sanitizeNetworkConnectorText(status.State, 96)
	status.Version = sanitizeNetworkConnectorText(status.Version, 96)
	status.Message = sanitizeNetworkConnectorText(status.Message, maxNetworkConnectorText)
	if status.Connectivity == nil {
		return status
	}
	connectivity := *status.Connectivity
	connectivity.Confidence = sanitizeNetworkConnectorText(connectivity.Confidence, 64)
	connectivity.ObservedAt = sanitizeNetworkConnectorText(connectivity.ObservedAt, 64)
	connectivity.PeerID = redactNetworkConnectorPeerID(connectivity.PeerID)
	if connectivity.LatencyMs < 0 || connectivity.LatencyMs > 10*60*1000 {
		connectivity.LatencyMs = 0
	}
	if connectivity.Evidence != nil {
		evidence := *connectivity.Evidence
		evidence.Source = sanitizeNetworkConnectorText(evidence.Source, 160)
		evidence.Path = sanitizeNetworkConnectorText(evidence.Path, 96)
		evidence.Transport = sanitizeNetworkConnectorText(evidence.Transport, 64)
		connectivity.Evidence = &evidence
	}
	status.Connectivity = &connectivity
	return status
}

func sanitizeNetworkConnectorSchema(value any) any {
	return sanitizeNetworkConnectorSchemaValue(value, false)
}

func sanitizeNetworkConnectorSchemaValue(value any, propertyMap bool) any {
	switch current := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(current))
		for key, nested := range current {
			lower := strings.ToLower(strings.TrimSpace(key))
			if !propertyMap && sensitiveNetworkConnectorSchemaKey(lower) {
				continue
			}
			if lower == "properties" {
				result[key] = sanitizeNetworkConnectorSchemaValue(nested, true)
				continue
			}
			result[key] = sanitizeNetworkConnectorSchemaValue(nested, false)
		}
		return result
	case []any:
		result := make([]any, 0, len(current))
		for _, nested := range current {
			result = append(result, sanitizeNetworkConnectorSchemaValue(nested, false))
		}
		return result
	case string:
		return sanitizeNetworkConnectorText(current, maxNetworkConnectorText)
	default:
		return value
	}
}

func sensitiveNetworkConnectorSchemaKey(key string) bool {
	switch key {
	case "default", "example", "examples", "const", "value", "currentvalue", "resolved", "resolvedvalue", "secret", "secretvalue", "credential", "credentials", "token", "password", "privatekey", "authkey", "accesskey", "secretkey":
		return true
	default:
		for _, marker := range []string{"token", "secret", "password", "privatekey", "credential", "authkey", "accesskey"} {
			if strings.Contains(key, marker) {
				return true
			}
		}
		return false
	}
}

func sanitizeNetworkConnectorText(value string, maxRunes int) string {
	value = strings.Map(func(r rune) rune {
		if r < 0x20 && r != '\t' {
			return -1
		}
		return r
	}, strings.TrimSpace(value))
	if value == "" {
		return ""
	}
	lower := strings.ToLower(value)
	for _, marker := range []string{"authorization:", "bearer ", "token=", "token:", "secret=", "secret:", "password=", "password:", "privatekey=", "private_key=", "authkey=", "auth_key=", "credential="} {
		if strings.Contains(lower, marker) {
			return "[敏感信息已隐藏]"
		}
	}
	value = networkConnectorURLRE.ReplaceAllString(value, "[地址已隐藏]")
	value = networkConnectorIPv4RE.ReplaceAllString(value, "[地址已隐藏]")
	value = networkConnectorPathRE.ReplaceAllString(value, "[路径已隐藏]")
	runes := []rune(value)
	if len(runes) > maxRunes {
		runes = runes[:maxRunes]
	}
	return string(runes)
}

func redactNetworkConnectorPeerID(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if strings.Contains(strings.ToLower(value), "redact") {
		return "peer-redacted"
	}
	sum := sha256.Sum256([]byte(value))
	return "peer-" + hex.EncodeToString(sum[:6])
}

func validateNetworkConnector(connector NetworkConnector) error {
	if strings.TrimSpace(connector.ID) == "" || strings.TrimSpace(connector.Name) == "" {
		return pluginerr.New("network_connector_descriptor_invalid", "连接器必须声明 id 和 name")
	}
	if len(connector.Operations) > maxNetworkConnectorItems {
		return pluginerr.New("network_connector_descriptor_invalid", "连接器操作数量超过限制")
	}
	allowedModes := map[string]bool{
		"direct-p2p": true, "peer-relay": true, "derp-relay": true,
		"outbound-tunnel": true, "wireguard-tunnel": true,
		"unavailable": true, "unknown": true,
	}
	for _, mode := range connector.Connectivity {
		if !allowedModes[strings.TrimSpace(mode)] {
			return pluginerr.New("network_connector_descriptor_invalid", "未知 connectivity mode："+mode)
		}
	}
	seen := map[string]bool{}
	for _, operation := range connector.Operations {
		id := strings.TrimSpace(operation.ID)
		if id == "" || seen[id] {
			return pluginerr.New("network_connector_descriptor_invalid", "连接器操作 id 重复或为空")
		}
		switch inputKind := strings.TrimSpace(operation.InputKind); inputKind {
		case "", "none", "custom", "secret":
		default:
			return pluginerr.New("network_connector_descriptor_invalid", "连接器操作 inputKind 无效："+inputKind)
		}
		switch confirmation := strings.TrimSpace(operation.Confirmation); confirmation {
		case "", "none", "required":
		default:
			return pluginerr.New("network_connector_descriptor_invalid", "连接器操作 confirmation 无效："+confirmation)
		}
		seen[id] = true
	}
	return nil
}

func validateNetworkConnectorStatus(status NetworkConnectorStatus) error {
	if status.Connectivity == nil {
		return nil
	}
	connectivity := status.Connectivity
	mode := strings.TrimSpace(connectivity.Mode)
	switch mode {
	case "direct-p2p", "peer-relay", "derp-relay", "outbound-tunnel", "wireguard-tunnel", "unavailable", "unknown":
		// accepted below
	default:
		return pluginerr.New("network_connector_status_invalid", fmt.Sprintf("未知 connectivity.mode：%s", mode))
	}
	if mode == "direct-p2p" {
		if !status.Running || connectivity.Evidence == nil ||
			strings.TrimSpace(connectivity.Evidence.Source) == "" ||
			strings.TrimSpace(connectivity.Evidence.Path) == "" {
			return pluginerr.New("network_connector_status_invalid", "direct-p2p 必须由运行中的连接器提供 source/path 证据")
		}
	}
	return nil
}

func safeNetworkConnectorError(err error) string {
	if coded, ok := pluginerr.From(err); ok && coded.Code != "" {
		return coded.Code
	}
	return "network_connector_unavailable"
}
