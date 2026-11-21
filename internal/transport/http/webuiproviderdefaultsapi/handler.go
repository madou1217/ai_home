// Package webuiproviderdefaultsapi 提供 Provider CLI 启动默认值的结构化读写接口。
//
// `GET|PATCH /v1/management/webui/provider-defaults` 把 Codex 的 model /
// model_reasoning_effort / service_tier 作为一份设置暴露给 WebUI；写入与 CLI
// (`aih codex model|effort`) 落在同一份宿主 config.toml，避免两套事实源。
package webuiproviderdefaultsapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/application/modelmetadata"
	"github.com/madou1217/ai_home/application/modelsnapshot"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
	"github.com/madou1217/ai_home/internal/runtime/codexpreferences"
)

// Path 是 Provider 启动默认值的完整管理契约路径。
const Path = "/v1/management/webui/provider-defaults"

const maxBodyBytes = 64 << 10

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("Provider 启动默认值接口依赖无效")

// supportedProvider 是目前支持结构化启动默认值的 Provider。
const supportedProvider = "codex"

// reasoningEfforts 是 Codex 支持的推理强度档位（升序）。
var reasoningEfforts = []string{"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}

var reasoningEffortSet = func() map[string]struct{} {
	set := make(map[string]struct{}, len(reasoningEfforts))
	for _, effort := range reasoningEfforts {
		set[effort] = struct{}{}
	}
	return set
}()

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总读写所需的宿主路径与元数据端口。
type Dependencies struct {
	Authorizer Authorizer
	// HostHomeDir 是宿主家目录；Codex 配置根由 Provider 合同解析。
	HostHomeDir string
	// Reasoning 只用于告诉 UI 当前模型支持哪些强度；缺失时回退到全量档位。
	Reasoning modelmetadata.ReasoningLadderReader
	// Models 给出宿主快照里的 Codex 模型 ID，作为 UI 建议；缺失时只保留自由输入。
	Models modelsnapshot.Reader
}

// Handler 处理 Provider 启动默认值的读写。
type Handler struct {
	authorizer  Authorizer
	hostHomeDir string
	reasoning   modelmetadata.ReasoningLadderReader
	models      modelsnapshot.Reader
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || strings.TrimSpace(dependencies.HostHomeDir) == "" {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer:  dependencies.Authorizer,
		hostHomeDir: strings.TrimSpace(dependencies.HostHomeDir),
		reasoning:   dependencies.Reasoning,
		models:      dependencies.Models,
	}, nil
}

type preferencesView struct {
	OK                      bool                `json:"ok"`
	Provider                string              `json:"provider"`
	Supported               bool                `json:"supported"`
	Model                   string              `json:"model"`
	ReasoningEffort         string              `json:"reasoningEffort"`
	ServiceTier             string              `json:"serviceTier"`
	ConfigPath              string              `json:"configPath"`
	ReasoningEfforts        []string            `json:"reasoningEfforts"`
	Models                  []string            `json:"models"`
	ReasoningEffortsByModel map[string][]string `json:"reasoningEffortsByModel"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 读取或更新启动默认值。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil {
		writeError(response, http.StatusServiceUnavailable, "provider_defaults_unavailable", "启动默认值服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	switch request.Method {
	case http.MethodGet:
		handler.handleGet(response, request)
	case http.MethodPatch, http.MethodPut:
		handler.handlePatch(response, request)
	default:
		response.Header().Set("Allow", http.MethodGet+", "+http.MethodPatch+", "+http.MethodPut)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET/PATCH/PUT")
	}
}

func (handler *Handler) handleGet(response http.ResponseWriter, request *http.Request) {
	provider := normalizeProvider(request.URL.Query().Get("provider"))
	if provider != supportedProvider {
		writeError(response, http.StatusBadRequest, "unsupported_provider", "该 Provider 暂不支持配置启动默认值")
		return
	}
	snapshot, err := codexpreferences.Read(handler.codexHomeDir())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "read_provider_defaults_failed", err.Error())
		return
	}
	handler.writeSnapshot(response, request.Context(), snapshot.Model, snapshot.Effort, snapshot.Tier, snapshot.Path)
}

type preferencesPayload struct {
	Provider        string  `json:"provider"`
	Model           *string `json:"model"`
	ReasoningEffort *string `json:"reasoningEffort"`
	ServiceTier     *string `json:"serviceTier"`
}

func (handler *Handler) handlePatch(response http.ResponseWriter, request *http.Request) {
	payload, ok := decodePayload(response, request)
	if !ok {
		return
	}
	provider := normalizeProvider(payload.Provider)
	if provider != supportedProvider {
		writeError(response, http.StatusBadRequest, "unsupported_provider", "该 Provider 暂不支持配置启动默认值")
		return
	}
	values := make(map[string]string, 3)
	if payload.Model != nil {
		model := strings.TrimSpace(*payload.Model)
		if model == "" || len(model) > 200 || strings.ContainsAny(model, "\r\n\x00") {
			writeError(response, http.StatusBadRequest, "invalid_model", "默认模型不能为空")
			return
		}
		values["model"] = model
	}
	if payload.ReasoningEffort != nil {
		effort := strings.ToLower(strings.TrimSpace(*payload.ReasoningEffort))
		if _, allowed := reasoningEffortSet[effort]; !allowed {
			writeError(response, http.StatusBadRequest, "invalid_reasoning_effort", "不支持的推理强度")
			return
		}
		values["model_reasoning_effort"] = effort
	}
	if payload.ServiceTier != nil {
		tier := strings.ToLower(strings.TrimSpace(*payload.ServiceTier))
		switch tier {
		case "", "default", "off":
			tier = "default"
		case "fast", "on":
			tier = "fast"
		default:
			writeError(response, http.StatusBadRequest, "invalid_service_tier", "服务档只支持 fast/default")
			return
		}
		values["service_tier"] = tier
	}
	if len(values) == 0 {
		writeError(response, http.StatusBadRequest, "empty_preferences", "至少提供 model、reasoningEffort 或 serviceTier 之一")
		return
	}
	snapshot, err := codexpreferences.UpdateValues(handler.codexHomeDir(), values)
	if err != nil {
		writeError(response, http.StatusConflict, "save_provider_defaults_failed", err.Error())
		return
	}
	handler.writeSnapshot(response, request.Context(), snapshot.Model, snapshot.Effort, snapshot.Tier, snapshot.Path)
}

func (handler *Handler) codexHomeDir() string {
	return filepath.Join(handler.hostHomeDir, providerroot.ConfigDir("codex"))
}

func (handler *Handler) writeSnapshot(
	response http.ResponseWriter,
	ctx context.Context,
	model, effort, tier, configPath string,
) {
	models, effortsByModel := handler.modelChoices(ctx)
	writeJSON(response, http.StatusOK, preferencesView{
		OK:                      true,
		Provider:                supportedProvider,
		Supported:               true,
		Model:                   model,
		ReasoningEffort:         effort,
		ServiceTier:             tier,
		ConfigPath:              displayPath(handler.hostHomeDir, configPath),
		ReasoningEfforts:        handler.reasoningEfforts(model),
		Models:                  models,
		ReasoningEffortsByModel: effortsByModel,
	})
}

// modelChoices 从宿主模型快照取 Codex 模型 ID，并附带目录声明的强度档位。
func (handler *Handler) modelChoices(ctx context.Context) ([]string, map[string][]string) {
	effortsByModel := map[string][]string{}
	if handler.models == nil {
		return nil, effortsByModel
	}
	snapshot, err := handler.models.Read(ctx)
	if err != nil || snapshot == nil {
		return nil, effortsByModel
	}
	models := append([]string(nil), snapshot.ByProvider[supportedProvider]...)
	sort.Strings(models)
	for _, id := range models {
		if ladder, found := handler.lookupReasoningEfforts(id); found {
			effortsByModel[id] = ladder
		}
	}
	return models, effortsByModel
}

// reasoningEfforts 返回当前模型支持的档位；目录没有记录时回退全量档位，
// 与 CLI 的「实际可用性取决于模型和账号」保持一致。
func (handler *Handler) reasoningEfforts(model string) []string {
	if ladder, found := handler.lookupReasoningEfforts(model); found {
		return ladder
	}
	return append([]string(nil), reasoningEfforts...)
}

func (handler *Handler) lookupReasoningEfforts(model string) ([]string, bool) {
	if handler.reasoning == nil || strings.TrimSpace(model) == "" {
		return nil, false
	}
	ladder, found := handler.reasoning.LookupReasoningEfforts(supportedProvider, model)
	if !found || len(ladder) == 0 {
		return nil, false
	}
	values := make([]string, 0, len(ladder))
	for _, effort := range ladder {
		values = append(values, string(effort))
	}
	return values, true
}

func decodePayload(response http.ResponseWriter, request *http.Request) (preferencesPayload, bool) {
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, maxBodyBytes))
	var payload preferencesPayload
	if err := decoder.Decode(&payload); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(response, http.StatusRequestEntityTooLarge, "request_body_too_large", "")
			return preferencesPayload{}, false
		}
		writeError(response, http.StatusBadRequest, "invalid_json_body", "")
		return preferencesPayload{}, false
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		writeError(response, http.StatusBadRequest, "invalid_json_body", "")
		return preferencesPayload{}, false
	}
	return payload, true
}

func normalizeProvider(value string) string {
	provider := strings.ToLower(strings.TrimSpace(value))
	if provider == "" {
		return supportedProvider
	}
	return provider
}

// displayPath 把宿主家目录前缀折成 ~，管理面不暴露完整宿主路径。
func displayPath(hostHomeDir, path string) string {
	home := strings.TrimRight(strings.TrimSpace(hostHomeDir), "/")
	if home != "" && strings.HasPrefix(path, home+"/") {
		return "~" + strings.TrimPrefix(path, home)
	}
	return path
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}
