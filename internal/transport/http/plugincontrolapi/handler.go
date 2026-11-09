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

// Dependencies 汇总管理接口依赖。
type Dependencies struct {
	Authorizer Authorizer
	Installer  Installer
}

// Handler 处理安装与卸载。
type Handler struct {
	authorizer Authorizer
	installer  Installer
}

// NewHandler 创建管理接口；依赖缺失时拒绝装配。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Installer == nil {
		return nil, errors.New("插件安装接口依赖无效")
	}
	return &Handler{authorizer: dependencies.Authorizer, installer: dependencies.Installer}, nil
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
	default:
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
func writeControlError(response http.ResponseWriter, err error) {
	coded, ok := pluginerr.From(err)
	if !ok {
		writeDomainError(response, http.StatusBadRequest, "plugin_error", err.Error())
		return
	}
	status := http.StatusBadRequest
	switch coded.Code {
	case plugincontrol.CodeNotInstalled:
		status = http.StatusNotFound
	case plugincontrol.CodeVersionConflict, plugincontrol.CodeInUse, plugincontrol.CodeRevisionConflict:
		status = http.StatusConflict
	case "account_maintenance_busy", "account_maintenance_in_progress",
		plugincontrol.CodeStateUnavailable, "plugin_runtime_unavailable", "plugin_runtime_inactive":
		status = http.StatusServiceUnavailable
	}
	writeDomainError(response, status, coded.Code, coded.Error())
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
