// Package webuitoolkitextapi 提供 Toolkit 扩展四项能力（边缘入口转发、Provider 配置工作台、
// 原生资源管理与订阅聚合器）的 Go WebUI HTTP 与 SSE 管理面接口。
package webuitoolkitextapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/edgeproxy"
	"github.com/madou1217/ai_home/internal/runtime/nativeresources"
	"github.com/madou1217/ai_home/internal/runtime/providerconfigs"
	"github.com/madou1217/ai_home/internal/runtime/subaggregator"
	"github.com/madou1217/ai_home/internal/transport/http/httpjson"
)

const (
	// EdgePath 是本机边缘代理（frp/nginx/caddy）状态查询根路径。
	EdgePath = "/v1/management/webui/toolkit/edge"
	// EdgePlanPath 是生成边缘代理配置预览的 GET 路径。
	EdgePlanPath = EdgePath + "/plan"
	// EdgeApplyPath 是落盘校验并重载边缘代理配置的 POST 路径。
	EdgeApplyPath = EdgePath + "/apply"

	// ProviderConfigsPath 是 Provider 配置文件列表根路径。
	ProviderConfigsPath = "/v1/management/webui/toolkit/provider-configs"
	// ProviderConfigFilePath 是单个配置文件读写的 ServeMux 路径模式。
	ProviderConfigFilePath = ProviderConfigsPath + "/{provider}/{fileId}"
	// ProviderConfigValidatePath 是配置文本语法校验的 ServeMux 路径模式。
	ProviderConfigValidatePath = ProviderConfigFilePath + "/validate"
	// ProviderConfigHistoryPath 是配置文件版本历史列表的 ServeMux 路径模式。
	ProviderConfigHistoryPath = ProviderConfigFilePath + "/history"
	// ProviderConfigHistoryEntryPath 是读取单条版本历史的 ServeMux 路径模式。
	ProviderConfigHistoryEntryPath = ProviderConfigHistoryPath + "/{entryId}"
	// ProviderConfigHistoryRestorePath 是恢复历史版本的 ServeMux 路径模式。
	ProviderConfigHistoryRestorePath = ProviderConfigHistoryEntryPath + "/restore"
	// ProviderConfigExportPath 是导出（脱敏/原始）配置的 ServeMux 路径模式。
	ProviderConfigExportPath = ProviderConfigFilePath + "/export"

	// NativeResourcesPath 是原生资源（plugin / skill / mcp）探测与生命周期操作路径。
	NativeResourcesPath = "/v1/management/webui/toolkit/native-resources"

	// SubAggregatorPath 是订阅聚合器总览根路径。
	SubAggregatorPath = "/v1/management/webui/toolkit/subscription-aggregator"
	// SubAggregatorLocalClientsPath 是本机支持深链接客户端探测路径。
	SubAggregatorLocalClientsPath = SubAggregatorPath + "/local-clients"
	// SubAggregatorLocalSourcesPath 是本机客户端已有订阅扫描路径。
	SubAggregatorLocalSourcesPath = SubAggregatorPath + "/local-sources"
	// SubAggregatorLocalSourcesImportPath 是批量导入扫描结果的 POST 路径。
	SubAggregatorLocalSourcesImportPath = SubAggregatorLocalSourcesPath + "/import"
	// SubAggregatorSourcesSyncWatchPath 是订阅源同步进度 SSE 事件流路径。
	SubAggregatorSourcesSyncWatchPath = SubAggregatorPath + "/sources/sync/watch"
	// SubAggregatorRelayPath 是本机中转边车可用性查询路径。
	SubAggregatorRelayPath = SubAggregatorPath + "/relay"
	// SubAggregatorProfilesPath 是新建/保存聚合配置路径。
	SubAggregatorProfilesPath = SubAggregatorPath + "/profiles"
	// SubAggregatorProfileNodesPath 是未保存聚合配置节点筛选预览路径。
	SubAggregatorProfileNodesPath = SubAggregatorProfilesPath + "/nodes"
	// SubAggregatorProfileTestRoutePath 是分流规则路由测试路径。
	SubAggregatorProfileTestRoutePath = SubAggregatorProfilesPath + "/test-route"
	// SubAggregatorProbePath 是节点域名解析与端口/TLS 探针路径。
	SubAggregatorProbePath = SubAggregatorPath + "/probe"
	// SubAggregatorNodesParsePath 是批量导入内容节点解析路径。
	SubAggregatorNodesParsePath = SubAggregatorPath + "/nodes/parse"
	// SubAggregatorNodesPath 是全部代理节点轻量列表路径。
	SubAggregatorNodesPath = SubAggregatorPath + "/nodes"
	// SubAggregatorNodesChainPath 是设置节点链式前置代理路径。
	SubAggregatorNodesChainPath = SubAggregatorNodesPath + "/chain"
	// SubAggregatorSourcesPreviewPath 是粘贴内容订阅源解析预览路径。
	SubAggregatorSourcesPreviewPath = SubAggregatorPath + "/sources/preview"
	// SubAggregatorSourcesPath 是新增/更新订阅源路径。
	SubAggregatorSourcesPath = SubAggregatorPath + "/sources"
	// SubAggregatorSourcesSyncPath 是发起异步批量同步任务路径。
	SubAggregatorSourcesSyncPath = SubAggregatorSourcesPath + "/sync"
	// SubAggregatorProfileTokenPath 是轮换聚合订阅 Token 路径模式。
	SubAggregatorProfileTokenPath = SubAggregatorProfilesPath + "/{profileId}/token"
	// SubAggregatorProfilePreviewPath 是预览渲染聚合订阅内容路径模式。
	SubAggregatorProfilePreviewPath = SubAggregatorProfilesPath + "/{profileId}/preview"
	// SubAggregatorProfileImportLinksPath 是生成客户端导入深链接路径模式。
	SubAggregatorProfileImportLinksPath = SubAggregatorProfilesPath + "/{profileId}/import-links"
	// SubAggregatorProfileItemPath 是删除单个聚合配置路径模式。
	SubAggregatorProfileItemPath = SubAggregatorProfilesPath + "/{profileId}"
	// SubAggregatorSourceNodesPath 是读取订阅源下属节点列表路径模式。
	SubAggregatorSourceNodesPath = SubAggregatorSourcesPath + "/{subId}/nodes"
	// SubAggregatorSourceLatencyPath 是测算订阅源节点延迟路径模式。
	SubAggregatorSourceLatencyPath = SubAggregatorSourcesPath + "/{subId}/latency"
	// SubAggregatorSourceSyncPath 是同步单个订阅源路径模式。
	SubAggregatorSourceSyncPath = SubAggregatorSourcesPath + "/{subId}/sync"
	// SubAggregatorSourceEnabledPath 是启停单个订阅源路径模式。
	SubAggregatorSourceEnabledPath = SubAggregatorSourcesPath + "/{subId}/enabled"
	// SubAggregatorSourceItemPath 是删除单个订阅源路径模式。
	SubAggregatorSourceItemPath = SubAggregatorSourcesPath + "/{subId}"
)

const defaultSyncWatchHeartbeat = 30 * time.Second

// Authorizer 校验 WebUI 管理面调用方的管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// EdgeService 抽象边缘代理探测、计划生成与配置应用服务。
type EdgeService interface {
	Status(ctx context.Context, aihPort int) edgeproxy.StatusResponse
	Plan(kind string, opts edgeproxy.PlanOptions) (*edgeproxy.Plan, *edgeproxy.EdgeError)
	Apply(ctx context.Context, kind string, opts edgeproxy.PlanOptions) (*edgeproxy.ApplyResult, *edgeproxy.EdgeError)
}

// ProviderConfigsService 抽象 Provider 配置文件读取、校验、保存、历史与导出服务。
type ProviderConfigsService interface {
	ListProviders(ctx context.Context, includeCLIVersions bool) providerconfigs.ListResponse
	ReadFile(ctx context.Context, provider, fileID string) (*providerconfigs.ReadResponse, error)
	SaveFile(ctx context.Context, provider, fileID, content string, opts providerconfigs.SaveOptions) (*providerconfigs.SaveResponse, error)
	ValidateFile(provider, fileID, content string) (*providerconfigs.ValidateResponse, error)
	ListHistory(provider, fileID string) (*providerconfigs.HistoryListResponse, error)
	ReadHistoryEntry(provider, fileID, entryID string) (*providerconfigs.HistoryEntryResponse, error)
	RestoreHistoryEntry(ctx context.Context, provider, fileID, entryID string) (*providerconfigs.SaveResponse, error)
	ExportFile(ctx context.Context, provider, fileID, mode string) (*providerconfigs.ExportResponse, error)
}

// NativeResourcesService 抽象原生资源探测与生命周期操作服务。
type NativeResourcesService interface {
	Report(ctx context.Context) (nativeresources.ReportResponse, error)
	Operate(ctx context.Context, input nativeresources.OperateInput) (nativeresources.OperateResponse, error)
}

// SubAggregatorService 抽象订阅聚合器全部管理面操作与同步监听订阅能力。
type SubAggregatorService interface {
	GetOverview() (subaggregator.OverviewResult, error)
	DetectLocalClients(ctx context.Context, local bool) map[string]any
	ScanLocalSources() (subaggregator.LocalScanResult, error)
	ImportLocalSources(ids []string) (map[string]any, error)
	ListSourceSyncJobs() subaggregator.SyncSnapshot
	OnSourceSyncChange(fn func(subaggregator.SyncEvent)) func()
	RelayAvailability() subaggregator.RelayAvailability
	SaveProfile(raw map[string]any) (subaggregator.AggregatorProfile, error)
	PreviewNodes(raw map[string]any) ([]subaggregator.PreviewNodeItem, error)
	TestRoute(ctx context.Context, raw map[string]any) (subaggregator.RouteTraceResult, error)
	Probe(ctx context.Context, input subaggregator.ProbeInput) (subaggregator.ProbeResult, error)
	ParseNodes(content string) (map[string]any, error)
	AllNodes() ([]map[string]any, error)
	SetNodeChain(nodeID, chainRef string) (map[string]any, error)
	PreviewSource(content string) (map[string]any, error)
	SaveSource(ctx context.Context, raw map[string]any) (map[string]any, error)
	StartSourceSync(ids []string) (subaggregator.SyncJobView, error)
	StartSourceSyncOne(subscriptionID string) (map[string]any, error)
	RotateToken(profileID string) (subaggregator.AggregatorProfile, error)
	StartRelay(ctx context.Context, profileID, target, clientID, remoteAddr, origin string) (subaggregator.RelayRenderStatus, error)
	Preview(profileID, target string, req subaggregator.PreviewRequest) (subaggregator.PreviewResult, error)
	ImportLinks(profileID, origin string) (subaggregator.ImportLinksResult, error)
	DeleteProfile(profileID string) error
	SourceNodes(subID string) ([]map[string]any, error)
	MeasureLatency(ctx context.Context, subID string, fresh bool) (map[string]subaggregator.LatencyResult, error)
	SetSourceEnabled(subscriptionID string, enabled bool) (subaggregator.PublicSourceView, error)
	DeleteSource(subscriptionID string) (map[string]any, error)
}

// Dependencies 声明创建 webuitoolkitextapi.Handler 所需的全部依赖。
type Dependencies struct {
	Authorizer        Authorizer
	Edge              EdgeService
	ProviderConfigs   ProviderConfigsService
	NativeResources   NativeResourcesService
	SubAggregator     SubAggregatorService
	DefaultAIHPort    int
	HeartbeatInterval time.Duration
}

// ErrInvalidDependencies 表示必填依赖（Authorizer）缺失。
var ErrInvalidDependencies = errors.New("toolkit 扩展接口依赖无效")

var (
	errBodyTooLarge = errors.New("request_body_too_large")
	errInvalidJSON  = errors.New("invalid_json_body")
)

// Handler 分发并执行四个 Toolkit 扩展域的全部 WebUI 管理路由。
type Handler struct {
	authorizer        Authorizer
	edge              EdgeService
	providerConfigs   ProviderConfigsService
	nativeResources   NativeResourcesService
	subAggregator     SubAggregatorService
	defaultAIHPort    int
	heartbeatInterval time.Duration
}

// NewHandler 校验依赖并构造 Handler。
func NewHandler(deps Dependencies) (*Handler, error) {
	if deps.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	heartbeat := deps.HeartbeatInterval
	if heartbeat <= 0 {
		heartbeat = defaultSyncWatchHeartbeat
	}
	return &Handler{
		authorizer:        deps.Authorizer,
		edge:              deps.Edge,
		providerConfigs:   deps.ProviderConfigs,
		nativeResources:   deps.NativeResources,
		subAggregator:     deps.SubAggregator,
		defaultAIHPort:    deps.DefaultAIHPort,
		heartbeatInterval: heartbeat,
	}, nil
}

// ServeHTTP 统一鉴权并按路径前缀路由到对应子系统处理器。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.authorizer == nil {
		writeError(w, http.StatusServiceUnavailable, "toolkit_ext_unavailable", "Toolkit 扩展服务不可用")
		return
	}
	if !h.authorizer.Authorized(r) {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeError(w, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}

	p := requestEscapedPath(r)
	switch {
	case p == EdgePath || strings.HasPrefix(p, EdgePath+"/"):
		h.serveEdge(w, r, p)
	case p == ProviderConfigsPath || strings.HasPrefix(p, ProviderConfigsPath+"/"):
		h.serveProviderConfigs(w, r, p)
	case p == NativeResourcesPath:
		h.serveNativeResources(w, r)
	case p == SubAggregatorPath || strings.HasPrefix(p, SubAggregatorPath+"/"):
		h.serveSubAggregator(w, r, p)
	default:
		writeError(w, http.StatusNotFound, "not_found", "未找到 Toolkit 扩展路由")
	}
}

func requestEscapedPath(r *http.Request) string {
	if r == nil || r.URL == nil {
		return ""
	}
	if escaped := r.URL.EscapedPath(); escaped != "" {
		return escaped
	}
	return r.URL.Path
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	body := map[string]any{
		"ok":    false,
		"error": code,
	}
	if message != "" {
		body["message"] = message
	}
	writeJSON(w, status, body)
}

func requireMethod(w http.ResponseWriter, r *http.Request, allowed string) bool {
	if r.Method == allowed {
		return true
	}
	w.Header().Set("Allow", allowed)
	writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 "+allowed)
	return false
}

// readJSONMap 读取最多 maxBytes 字节请求体并解析为 JSON 对象；空请求体返回空 map。
func readJSONMap(w http.ResponseWriter, r *http.Request, maxBytes int64) (map[string]any, error) {
	if r == nil || r.Body == nil {
		return map[string]any{}, nil
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return nil, errBodyTooLarge
		}
		return nil, errInvalidJSON
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return map[string]any{}, nil
	}
	if err := httpjson.ValidateDocument(trimmed); err != nil {
		return nil, errInvalidJSON
	}
	var decoded map[string]any
	if err := json.Unmarshal(trimmed, &decoded); err != nil {
		return nil, errInvalidJSON
	}
	if decoded == nil {
		decoded = map[string]any{}
	}
	return decoded, nil
}

// readJSONTarget 读取最多 maxBytes 字节请求体并反序列化到目标结构体；空请求体不修改 target。
func readJSONTarget(w http.ResponseWriter, r *http.Request, target any, maxBytes int64) error {
	if r == nil || r.Body == nil {
		return nil
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return errBodyTooLarge
		}
		return errInvalidJSON
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil
	}
	if err := httpjson.ValidateDocument(trimmed); err != nil {
		return errInvalidJSON
	}
	if err := json.Unmarshal(trimmed, target); err != nil {
		return errInvalidJSON
	}
	return nil
}

func unescapeSegment(raw string) (string, bool) {
	if raw == "" || strings.Contains(raw, "/") {
		return "", false
	}
	decoded, err := url.PathUnescape(raw)
	if err != nil || strings.TrimSpace(decoded) == "" {
		return "", false
	}
	return decoded, true
}
