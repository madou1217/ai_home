// Package plugincontrolapi 暴露插件制品生命周期的管理 HTTP 边界。
//
//	POST /v1/management/plugins/install    {file, requireSigned}
//	POST /v1/management/plugins/uninstall  {pluginId, version?, expectedRevision?}
//
// 启用/停用/诊断/列表仍归 Node 与只读清单：本接口只承接安装与卸载，
// 也就是「接受一个制品」和「从控制状态移除一条记录」两个动作。
//
// 响应字段与 Node control.install / control.uninstall 逐字一致；安装成功后的
// audit.append 仍由 Node 写（审计与 WebUI 的请求所有权留在 Node）。
package plugincontrolapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/application/plugincontrol"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

const (
	// InstallPath 接受并安装一个 .aih-plugin。
	InstallPath = "/v1/management/plugins/install"
	// UninstallPath 卸载一个已安装版本。
	UninstallPath = "/v1/management/plugins/uninstall"
	// StatePath 以候选原文提交一次控制状态变更（enable/disable 使用）。
	StatePath = "/v1/management/plugins/state/commit"
	// InstancesPath 是实例启停前缀：POST /instances/{instanceId}/enable|disable。
	InstancesPath = "/v1/management/plugins/instances"
	// maxStateBodyBytes 覆盖候选文档上限（4MB）与 JSON 包装。
	maxStateBodyBytes = 5 << 20
	// maxBodyBytes 与 Node 插件路由的 MAX_BODY_BYTES（256KB）一致。
	maxBodyBytes = 256 * 1024
	// HostVersionHeader / NodeVersionHeader 是 Node 代理 install 时给出的宿主事实。
	// 插件最终在 Node 宿主进程里执行，engines 必须按真正的宿主版本判断。
	HostVersionHeader = "X-Aih-Host-Version"
	NodeVersionHeader = "X-Aih-Node-Version"
)

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Installer 是安装/卸载用例端口。
type Installer interface {
	Install(ctx context.Context, file string, options plugincontrol.AcceptOptions) (plugincontrol.InstallResult, error)
	Uninstall(ctx context.Context, input plugincontrol.UninstallInput) (plugincontrol.UninstallResult, error)
}

// StateCommitter 接收 Node 计算好的候选状态并做 CAS 写入。
type StateCommitter interface {
	Commit(ctx context.Context, operation plugincontrol.Operation, expectedRevision int64, candidate []byte) (int64, error)
}

// InstanceOperator 是实例启停用例（读 revision → Node prepare → CAS → activate）。
type InstanceOperator interface {
	Apply(ctx context.Context, operation plugincontrol.Operation, instanceID string, input json.RawMessage, expectedRevision *int64) (plugincontrol.InstanceResult, error)
}

// Dependencies 汇总管理接口依赖。
type Dependencies struct {
	Authorizer Authorizer
	Installer  Installer
	// Committer 为空时只关闭 state/commit 路由；install/uninstall 不受影响。
	Committer StateCommitter
	// Operator 为空时只关闭实例启停路由；Node 代理会得到 404（不回落到本地写）。
	Operator InstanceOperator
}

// Handler 处理安装、卸载与状态提交。
type Handler struct {
	authorizer Authorizer
	installer  Installer
	committer  StateCommitter
	operator   InstanceOperator
}

// NewHandler 创建管理接口；依赖缺失时拒绝装配。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Installer == nil {
		return nil, errors.New("插件安装接口依赖无效")
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		installer:  dependencies.Installer,
		committer:  dependencies.Committer,
		operator:   dependencies.Operator,
	}, nil
}

// ServeHTTP 按路径分派；两条路径都只接受 POST。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.installer == nil {
		writeDomainError(response, http.StatusServiceUnavailable, "plugin_control_unavailable", "插件安装服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "")
		return
	}
	switch request.URL.Path {
	case InstallPath:
		handler.install(response, request)
	case UninstallPath:
		handler.uninstall(response, request)
	case StatePath:
		handler.stateCommit(response, request)
	default:
		instanceID, operation, matched := parseInstancePath(request.URL.Path)
		if matched {
			handler.instanceOperation(response, request, instanceID, operation)
			return
		}
		writeError(response, http.StatusNotFound, "not_found", "")
	}
}

type installPayload struct {
	File          string `json:"file"`
	RequireSigned bool   `json:"requireSigned"`
}

type uninstallPayload struct {
	PluginID         string          `json:"pluginId"`
	Version          string          `json:"version"`
	ExpectedRevision json.RawMessage `json:"expectedRevision"`
}

func (handler *Handler) install(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodPost) {
		return
	}
	var payload installPayload
	if !decodePayload(response, request, &payload) {
		return
	}
	options := plugincontrol.AcceptOptions{
		HostVersion:   headerOr(request, HostVersionHeader, "1.0.0"),
		NodeVersion:   request.Header.Get(NodeVersionHeader),
		RequireSigned: payload.RequireSigned,
	}
	result, err := handler.installer.Install(request.Context(), payload.File, options)
	if err != nil {
		writeControlError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, struct {
		OK bool `json:"ok"`
		plugincontrol.InstallResult
	}{OK: true, InstallResult: result})
}

func (handler *Handler) uninstall(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodPost) {
		return
	}
	var payload uninstallPayload
	if !decodePayload(response, request, &payload) {
		return
	}
	expected, revisionErr := parseExpectedRevision(payload.ExpectedRevision)
	if revisionErr != nil {
		// Node 对非数字 expectedRevision 得到 NaN，与整数 revision 比较必然不等，
		// 最终报 plugin_revision_conflict；这里保持同一结论，且必须在写事务之前拒绝。
		writeControlError(response, pluginerr.New(plugincontrol.CodeRevisionConflict, ""))
		return
	}
	result, err := handler.installer.Uninstall(request.Context(), plugincontrol.UninstallInput{
		PluginID:         payload.PluginID,
		Version:          payload.Version,
		ExpectedRevision: expected,
	})
	if err != nil {
		writeControlError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, struct {
		OK bool `json:"ok"`
		plugincontrol.UninstallResult
	}{OK: true, UninstallResult: result})
}

// parseExpectedRevision 复刻 Number(input.expectedRevision) 的比较语义。
// 返回非 nil error 表示该值不可能等于任何整数 revision。
func parseExpectedRevision(raw json.RawMessage) (*int64, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	text := strings.TrimSpace(string(raw))
	if text == "null" {
		value := int64(0)
		return &value, nil
	}
	var textValue string
	if err := json.Unmarshal(raw, &textValue); err == nil {
		// Number('') === 0；空串与纯空白在 Node 里都是 0，不是 NaN。
		trimmed := strings.TrimSpace(textValue)
		if trimmed == "" {
			value := int64(0)
			return &value, nil
		}
	}
	var number json.Number
	if err := json.Unmarshal(raw, &number); err != nil {
		// 字符串形式的数字：Number('3') === 3。
		if err := json.Unmarshal(raw, &textValue); err != nil {
			return nil, errors.New("invalid expectedRevision")
		}
		parsed, err := strconv.ParseFloat(strings.TrimSpace(textValue), 64)
		if err != nil {
			return nil, errors.New("invalid expectedRevision")
		}
		return floatRevision(parsed)
	}
	parsed, err := number.Float64()
	if err != nil {
		return nil, errors.New("invalid expectedRevision")
	}
	return floatRevision(parsed)
}

func floatRevision(value float64) (*int64, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) || math.Trunc(value) != value || value < 0 || value > math.MaxInt64 {
		return nil, errors.New("invalid expectedRevision")
	}
	converted := int64(value)
	return &converted, nil
}

// parseInstancePath 解析 /instances/{instanceId}/enable|disable。
// 不用 ServeMux 的 PathValue，是为了让 handler 单测可以直接构造请求。
func parseInstancePath(path string) (string, plugincontrol.Operation, bool) {
	prefix := InstancesPath + "/"
	if !strings.HasPrefix(path, prefix) {
		return "", "", false
	}
	rest := strings.TrimPrefix(path, prefix)
	for _, candidate := range []struct {
		suffix    string
		operation plugincontrol.Operation
	}{
		{suffix: "/enable", operation: plugincontrol.OperationEnable},
		{suffix: "/disable", operation: plugincontrol.OperationDisable},
	} {
		if !strings.HasSuffix(rest, candidate.suffix) {
			continue
		}
		instanceID := strings.TrimSuffix(rest, candidate.suffix)
		if instanceID == "" || strings.Contains(instanceID, "/") {
			return "", "", false
		}
		return instanceID, candidate.operation, true
	}
	return "", "", false
}

// instanceOperation 接收 Go 的公开启停请求：路径里的 instanceId 是权威值，
// body 里的同名字段被覆盖；配置、权限与默认值仍由 Node prepare 校验。
func (handler *Handler) instanceOperation(
	response http.ResponseWriter,
	request *http.Request,
	instanceID string,
	operation plugincontrol.Operation,
) {
	if !requireMethod(response, request, http.MethodPost) {
		return
	}
	if handler.operator == nil {
		writeDomainError(response, http.StatusServiceUnavailable, plugincontrol.CodeStateUnavailable, "插件状态写入不可用")
		return
	}
	input, ok := decodeInstanceInput(response, request)
	if !ok {
		return
	}
	encodedID, err := json.Marshal(instanceID)
	if err != nil {
		writeDomainError(response, http.StatusBadRequest, "plugin_request_invalid", "instanceId 非法")
		return
	}
	input["instanceId"] = encodedID
	expected, revisionErr := parseExpectedRevision(input["expectedRevision"])
	if revisionErr != nil {
		writeDomainError(response, http.StatusBadRequest, plugincontrol.CodeStateInvalid, "expectedRevision 必须是整数")
		return
	}
	payload, err := json.Marshal(input)
	if err != nil {
		writeDomainError(response, http.StatusBadRequest, "plugin_request_invalid", "请求体不是合法 JSON")
		return
	}
	result, err := handler.operator.Apply(request.Context(), operation, instanceID, payload, expected)
	if err != nil {
		writeControlError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, struct {
		OK bool `json:"ok"`
		plugincontrol.InstanceResult
	}{OK: true, InstanceResult: result})
}

// decodeInstanceInput 读取启停 body；空 body 视为 {}（disable 只靠路径参数）。
func decodeInstanceInput(response http.ResponseWriter, request *http.Request) (map[string]json.RawMessage, bool) {
	if request.Body == nil {
		return map[string]json.RawMessage{}, true
	}
	request.Body = http.MaxBytesReader(response, request.Body, maxBodyBytes)
	document, err := io.ReadAll(request.Body)
	if err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			writeDomainError(response, http.StatusBadRequest, "plugin_request_too_large", "请求体过大")
		} else {
			writeDomainError(response, http.StatusBadRequest, "plugin_request_invalid", "请求体不是合法 JSON")
		}
		return nil, false
	}
	if len(bytes.TrimSpace(document)) == 0 {
		return map[string]json.RawMessage{}, true
	}
	var input map[string]json.RawMessage
	if err := json.Unmarshal(document, &input); err != nil || input == nil {
		writeDomainError(response, http.StatusBadRequest, "plugin_request_invalid", "请求体必须是 JSON 对象")
		return nil, false
	}
	return input, true
}

func requireMethod(response http.ResponseWriter, request *http.Request, method string) bool {
	if request.Method == method {
		return true
	}
	response.Header().Set("Allow", method)
	writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "")
	return false
}

func decodePayload(response http.ResponseWriter, request *http.Request, target any) bool {
	if request.Body == nil {
		writeDomainError(response, http.StatusBadRequest, "plugin_request_invalid", "请求体不是合法 JSON")
		return false
	}
	request.Body = http.MaxBytesReader(response, request.Body, maxBodyBytes)
	document, err := io.ReadAll(request.Body)
	if err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			writeDomainError(response, http.StatusBadRequest, "plugin_request_too_large", "请求体过大")
		} else {
			writeDomainError(response, http.StatusBadRequest, "plugin_request_invalid", "请求体不是合法 JSON")
		}
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(document))
	if err := decoder.Decode(target); err != nil {
		writeDomainError(response, http.StatusBadRequest, "plugin_request_invalid", "请求体不是合法 JSON")
		return false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeDomainError(response, http.StatusBadRequest, "plugin_request_invalid", "请求体不是合法 JSON")
		return false
	}
	return true
}

func headerOr(request *http.Request, name string, fallback string) string {
	value := strings.TrimSpace(request.Header.Get(name))
	if value == "" {
		return fallback
	}
	return value
}

// writeControlError 復刻 Node writeError 的状态码分类：
// not_installed → 404；version_conflict / in_use / revision_conflict → 409；
// 维护或状态不可用 → 503；其余输入/校验错误 → 400。
type stateCommitPayload struct {
	Operation        string          `json:"operation"`
	ExpectedRevision json.RawMessage `json:"expectedRevision"`
	Candidate        json.RawMessage `json:"candidate"`
}

// stateCommit 接收 Node 计算好的候选并做权威 CAS 写入。
//
// 不在这里重算 configSchema/权限指纹：候选语义属于 Node；Go 只验证结构与操作边界，
// 并按原始字节落盘。
func (handler *Handler) stateCommit(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodPost) {
		return
	}
	if handler.committer == nil {
		writeDomainError(response, http.StatusServiceUnavailable, "plugin_state_unavailable", "插件状态写入不可用")
		return
	}
	if request.Body == nil {
		writeDomainError(response, http.StatusBadRequest, "plugin_state_invalid", "请求体不是合法 JSON")
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, maxStateBodyBytes)
	document, err := io.ReadAll(request.Body)
	if err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			writeDomainError(response, http.StatusBadRequest, "plugin_state_invalid", "控制状态文档过大")
		} else {
			writeDomainError(response, http.StatusBadRequest, "plugin_state_invalid", "请求体读取失败")
		}
		return
	}
	var payload stateCommitPayload
	if err := json.Unmarshal(document, &payload); err != nil {
		writeDomainError(response, http.StatusBadRequest, "plugin_state_invalid", "请求体不是合法 JSON")
		return
	}
	operation, ok := plugincontrol.ParseOperation(strings.TrimSpace(payload.Operation))
	if !ok {
		writeDomainError(response, http.StatusBadRequest, "plugin_state_invalid", "未知 operation")
		return
	}
	expected, revisionErr := parseExpectedRevision(payload.ExpectedRevision)
	if revisionErr != nil || expected == nil {
		writeDomainError(response, http.StatusBadRequest, "plugin_state_invalid", "expectedRevision 必须是整数")
		return
	}
	if len(payload.Candidate) == 0 || !json.Valid(payload.Candidate) {
		writeDomainError(response, http.StatusBadRequest, "plugin_state_invalid", "candidate 必须是 JSON 对象")
		return
	}
	revision, commitErr := handler.committer.Commit(request.Context(), operation, *expected, payload.Candidate)
	if commitErr != nil {
		var conflict *plugincontrol.RevisionConflictError
		if errors.As(commitErr, &conflict) {
			writeJSON(response, http.StatusConflict, struct {
				OK       bool   `json:"ok"`
				Error    string `json:"error"`
				Revision int64  `json:"revision"`
			}{OK: false, Error: plugincontrol.CodeRevisionConflict, Revision: conflict.Current})
			return
		}
		writeControlError(response, commitErr)
		return
	}
	writeJSON(response, http.StatusOK, struct {
		OK       bool  `json:"ok"`
		Revision int64 `json:"revision"`
	}{OK: true, Revision: revision})
}

func writeControlError(response http.ResponseWriter, err error) {
	// RevisionConflictError 不是 pluginerr.Error（它带 Current revision 供调用方重读）；
	// 实例端点仍然返回与 Node 一致的 409 + plugin_revision_conflict。
	var conflict *plugincontrol.RevisionConflictError
	if errors.As(err, &conflict) {
		diagnostics := []any{}
		writeJSON(response, http.StatusConflict, errorView{
			OK:          false,
			Error:       plugincontrol.CodeRevisionConflict,
			Message:     plugincontrol.CodeRevisionConflict,
			Diagnostics: &diagnostics,
		})
		return
	}
	coded, ok := pluginerr.From(err)
	if !ok {
		writeDomainError(response, http.StatusBadRequest, "plugin_error", err.Error())
		return
	}
	status := http.StatusBadRequest
	switch coded.Code {
	case plugincontrol.CodeNotInstalled, plugincontrol.CodeInstanceUnknown:
		status = http.StatusNotFound
	case plugincontrol.CodeVersionConflict, plugincontrol.CodeInUse, plugincontrol.CodeRevisionConflict,
		plugincontrol.CodePublishBusy, plugincontrol.CodeTicketUnknown, plugincontrol.CodeTicketExpired:
		status = http.StatusConflict
	case "account_maintenance_busy", "account_maintenance_in_progress",
		plugincontrol.CodeStateUnavailable, plugincontrol.CodeRuntimeUnavailable,
		"plugin_runtime_inactive":
		status = http.StatusServiceUnavailable
	}
	// 候选被拒时把宿主诊断带回调用方；其它错误保持空数组，形状与 Node writeError 一致。
	diagnostics := coded.Diagnostics
	if diagnostics == nil {
		diagnostics = []any{}
	}
	writeJSON(response, status, errorView{
		OK:          false,
		Error:       coded.Code,
		Message:     coded.Error(),
		Diagnostics: &diagnostics,
	})
}

type errorView struct {
	OK          bool   `json:"ok"`
	Error       string `json:"error"`
	Message     string `json:"message,omitempty"`
	Diagnostics *[]any `json:"diagnostics,omitempty"`
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}

func writeDomainError(response http.ResponseWriter, status int, code string, message string) {
	if message == "" {
		message = code
	}
	diagnostics := []any{}
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message, Diagnostics: &diagnostics})
}
