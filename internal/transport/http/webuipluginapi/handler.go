// Package webuipluginapi 暴露插件诊断、调试调用、插件联动报价与账号插件管理的 WebUI/CLI 契约。
//
// 统一挂载在 /v1/management/webui/plugins/*，由 Go pluginhost.Service 独占执行，
// 不再回落到 Node getPluginSystem。
package webuipluginapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/pluginerr"
	"github.com/madou1217/ai_home/internal/runtime/pluginhost"
	"github.com/madou1217/ai_home/internal/runtime/pricingcatalog"
	"github.com/madou1217/ai_home/internal/transport/http/httpjson"
)

const (
	// Path 是插件管理 WebUI 路由的公共前缀。
	Path = "/v1/management/webui/plugins"

	DoctorPath              = Path + "/doctor"
	InvokePath              = Path + "/invoke"
	PricingRefreshPath      = Path + "/pricing/refresh"
	PricingQuotePath        = Path + "/pricing/quote"
	AccountsSourcesPath     = Path + "/accounts/sources"
	AccountsImportPath      = Path + "/accounts/import"
	AccountsRefreshPath     = Path + "/accounts/refresh"
	AccountsMaterializePath = Path + "/accounts/materialize"

	smallBodyBytes = 256 * 1024
	largeBodyBytes = 16 * 1024 * 1024
	doctorAuditCap = 20
)

// ErrInvalidDependencies 表示缺少鉴权依赖。
var ErrInvalidDependencies = errors.New("插件管理接口缺少 Authorizer")

// Authorizer 校验管理面请求授权。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总 webuipluginapi 处理器依赖。
type Dependencies struct {
	Authorizer       Authorizer
	HostService      *pluginhost.Service
	PricingService   *pricingcatalog.Service
	AccountRegistrar pluginhost.AccountProjectionRegistrar
}

// Handler 提供插件诊断、调用、报价与账号来源等管理接口。
type Handler struct {
	authorizer       Authorizer
	hostService      *pluginhost.Service
	pricingService   *pricingcatalog.Service
	accountRegistrar pluginhost.AccountProjectionRegistrar
}

// NewHandler 创建失败关闭的插件管理处理器。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	pricingSvc := dependencies.PricingService
	if pricingSvc == nil && dependencies.HostService != nil {
		pricingSvc = dependencies.HostService.PricingService()
	}
	return &Handler{
		authorizer:       dependencies.Authorizer,
		hostService:      dependencies.HostService,
		pricingService:   pricingSvc,
		accountRegistrar: dependencies.AccountRegistrar,
	}, nil
}

// ServeHTTP 按精确路径分派请求并校验管理密钥。
func (h *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if h == nil || h.authorizer == nil {
		writePluginErrorJSON(response, http.StatusServiceUnavailable, "plugin_host_unavailable", "插件管理服务不可用")
		return
	}
	if !h.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writePluginErrorJSON(response, http.StatusUnauthorized, "unauthorized", "")
		return
	}
	switch request.URL.Path {
	case DoctorPath:
		h.handleDoctor(response, request)
	case InvokePath:
		h.handleInvoke(response, request)
	case PricingRefreshPath:
		h.handlePricingRefresh(response, request)
	case PricingQuotePath:
		h.handlePricingQuote(response, request)
	case AccountsSourcesPath:
		h.handleAccountsSources(response, request)
	case AccountsImportPath:
		h.handleAccountsImport(response, request)
	case AccountsRefreshPath:
		h.handleAccountsRefresh(response, request)
	case AccountsMaterializePath:
		h.handleAccountsMaterialize(response, request)
	default:
		writePluginErrorJSON(response, http.StatusNotFound, "not_found", "")
	}
}

type doctorResponse struct {
	OK                bool                                `json:"ok"`
	Revision          int64                               `json:"revision"`
	ControlStateError string                              `json:"controlStateError,omitempty"`
	Issues            []pluginhost.DoctorIssue            `json:"issues"`
	Warnings          []pluginhost.DoctorIssue            `json:"warnings"`
	Capabilities      map[string]int                      `json:"capabilities"`
	Installed         []pluginhost.DoctorInstalledSummary `json:"installed"`
	Audit             []pluginhost.AuditRecord            `json:"audit"`
	Runtime           pluginhost.RuntimeStatus            `json:"runtime"`
	Pricing           *pricingcatalog.DoctorReport        `json:"pricing"`
	Healthy           bool                                `json:"healthy"`
}

func (h *Handler) handleDoctor(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodGet) {
		return
	}
	if h.hostService == nil {
		writePluginErrorJSON(response, http.StatusServiceUnavailable, "plugin_runtime_unavailable", "Go 插件宿主未装配")
		return
	}
	report := h.hostService.Doctor(request.Context())
	audit := []pluginhost.AuditRecord{}
	if auditLog := h.hostService.AuditLog(); auditLog != nil {
		audit = auditLog.Read(doctorAuditCap)
	}
	var pricingDoctor *pricingcatalog.DoctorReport
	if h.pricingService != nil {
		if status, statusErr := h.pricingService.Status(true); statusErr == nil {
			pricingDoctor = status.Doctor
		}
	}
	writeJSON(response, http.StatusOK, doctorResponse{
		OK:                report.OK,
		Revision:          report.Revision,
		ControlStateError: report.ControlStateError,
		Issues:            nonNilSlice(report.Issues),
		Warnings:          nonNilSlice(report.Warnings),
		Capabilities:      nonNilMap(report.Capabilities),
		Installed:         nonNilSlice(report.Installed),
		Audit:             nonNilSlice(audit),
		Runtime:           report.Runtime,
		Pricing:           pricingDoctor,
		Healthy:           report.OK,
	})
}

type invokeRequest struct {
	ContributionID string `json:"contributionId"`
	Value          any    `json:"value"`
	TimeoutMs      int    `json:"timeoutMs"`
}

type invokeResponse struct {
	OK           bool            `json:"ok"`
	Value        json.RawMessage `json:"value,omitempty"`
	PayloadBytes int             `json:"payloadBytes"`
}

func (h *Handler) handleInvoke(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodPost) {
		return
	}
	if h.hostService == nil {
		writePluginErrorJSON(response, http.StatusServiceUnavailable, "plugin_runtime_unavailable", "Go 插件宿主未装配")
		return
	}
	var body invokeRequest
	if err := decodeOptionalJSONBody(response, request, &body, smallBodyBytes); err != nil {
		writeDecodeError(response, err)
		return
	}
	var timeout time.Duration
	if body.TimeoutMs > 0 {
		timeout = time.Duration(body.TimeoutMs) * time.Millisecond
	}
	result, err := h.hostService.InvokeContribution(request.Context(), body.ContributionID, body.Value, timeout)
	if err != nil {
		writePluginDomainError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, invokeResponse{
		OK:           true,
		Value:        result.Value,
		PayloadBytes: result.PayloadBytes,
	})
}

type pricingRefreshRequest struct {
	SourceID        string                               `json:"sourceId"`
	TimeoutMs       int                                  `json:"timeoutMs"`
	PluginSnapshots []pricingcatalog.PluginSnapshotInput `json:"pluginSnapshots"`
}

func (h *Handler) handlePricingRefresh(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodPost) {
		return
	}
	if h.pricingService == nil {
		writePluginErrorJSON(response, http.StatusServiceUnavailable, "pricing_service_unavailable", "价格目录服务未装配")
		return
	}
	var body pricingRefreshRequest
	if err := decodeOptionalJSONBody(response, request, &body, largeBodyBytes); err != nil {
		writeDecodeError(response, err)
		return
	}
	sourceID := strings.TrimSpace(body.SourceID)
	if sourceID != "" {
		res, err := h.pricingService.RefreshSource(request.Context(), sourceID)
		if err != nil {
			writePricingError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{
			"ok":             true,
			"sourceId":       res.SourceID,
			"applied":        res.Applied,
			"reviewRequired": res.ReviewRequired,
			"changes":        res.Changes,
			"reviews":        res.Reviews,
			"fetchedAt":      res.FetchedAt,
			"quoteCount":     res.QuoteCount,
		})
		return
	}

	snapshots := body.PluginSnapshots
	if snapshots == nil && h.hostService != nil {
		var timeout time.Duration
		if body.TimeoutMs > 0 {
			timeout = time.Duration(body.TimeoutMs) * time.Millisecond
		}
		snapshots = h.hostService.CollectPricingSnapshots(request.Context(), timeout)
	}
	report, err := h.pricingService.RefreshAll(request.Context(), snapshots)
	if err != nil {
		writePricingError(response, err)
		return
	}
	if h.hostService != nil {
		auditPricingRefresh(h.hostService, report)
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":        true,
		"pluginRun": report,
	})
}

func auditPricingRefresh(svc *pluginhost.Service, report pricingcatalog.RefreshReport) {
	appliedIDs := make([]string, 0, len(report.Sources))
	for _, src := range report.Sources {
		if src.Applied && strings.TrimSpace(src.SourceID) != "" {
			appliedIDs = append(appliedIDs, src.SourceID)
		}
	}
	if len(appliedIDs) > 0 {
		svc.Audit("pricing_apply", map[string]any{
			"sources": appliedIDs,
			"reviews": len(report.Reviews),
		})
	}
	if len(report.Reviews) > 0 {
		seen := make(map[string]struct{}, len(report.Reviews))
		reviewSources := make([]string, 0, len(report.Reviews))
		for _, item := range report.Reviews {
			id := strings.TrimSpace(item.SourceID)
			if id == "" {
				continue
			}
			if _, exists := seen[id]; exists {
				continue
			}
			seen[id] = struct{}{}
			reviewSources = append(reviewSources, id)
		}
		svc.Audit("pricing_review_queued", map[string]any{
			"sources": reviewSources,
			"reviews": len(report.Reviews),
		})
	}
}

func (h *Handler) handlePricingQuote(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodPost) {
		return
	}
	if h.hostService == nil {
		writePluginErrorJSON(response, http.StatusServiceUnavailable, "plugin_runtime_unavailable", "Go 插件宿主未装配")
		return
	}
	var body pluginhost.PricingQuoteRequest
	if err := decodeOptionalJSONBody(response, request, &body, smallBodyBytes); err != nil {
		writeDecodeError(response, err)
		return
	}
	merged, err := h.hostService.QuotePricing(request.Context(), body)
	if err != nil {
		code := extractErrorCode(err)
		if code == "" {
			writePricingError(response, err)
			return
		}
		writePluginDomainError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":              true,
		"quote":           merged.Quote,
		"contributions":   merged.Contributions,
		"snapshot":        merged.Snapshot,
		"sourceSnapshots": merged.SourceSnapshots,
	})
}

func (h *Handler) handleAccountsSources(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodGet) {
		return
	}
	if h.hostService == nil {
		writePluginErrorJSON(response, http.StatusServiceUnavailable, "plugin_runtime_unavailable", "Go 插件宿主未装配")
		return
	}
	provider := request.URL.Query().Get("provider")
	listed, err := h.hostService.ListAccountSources(request.Context(), provider, pluginhost.AccountListOptions{})
	if err != nil {
		writePluginDomainError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":         true,
		"sources":    nonNilSlice(listed.Sources),
		"warnings":   nonNilSlice(listed.Warnings),
		"generation": listed.Generation,
	})
}

func (h *Handler) handleAccountsImport(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodPost) {
		return
	}
	if h.hostService == nil {
		writePluginErrorJSON(response, http.StatusServiceUnavailable, "plugin_runtime_unavailable", "Go 插件宿主未装配")
		return
	}
	var body pluginhost.AccountImportRequest
	if err := decodeOptionalJSONBody(response, request, &body, smallBodyBytes); err != nil {
		writeDecodeError(response, err)
		return
	}
	result, err := h.hostService.ImportAccountSource(request.Context(), body, h.accountRegistrar)
	if err != nil {
		writePluginDomainError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func (h *Handler) handleAccountsRefresh(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodPost) {
		return
	}
	if h.hostService == nil {
		writePluginErrorJSON(response, http.StatusServiceUnavailable, "plugin_runtime_unavailable", "Go 插件宿主未装配")
		return
	}
	var body pluginhost.AccountRefreshRequest
	if err := decodeOptionalJSONBody(response, request, &body, largeBodyBytes); err != nil {
		writeDecodeError(response, err)
		return
	}
	result, err := h.hostService.RefreshAccount(request.Context(), body, h.accountRegistrar)
	if err != nil {
		writePluginDomainError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, struct {
		OK bool `json:"ok"`
		pluginhost.AccountRefreshResult
	}{
		OK:                   true,
		AccountRefreshResult: result,
	})
}

func (h *Handler) handleAccountsMaterialize(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodPost) {
		return
	}
	if h.hostService == nil {
		writePluginErrorJSON(response, http.StatusServiceUnavailable, "plugin_runtime_unavailable", "Go 插件宿主未装配")
		return
	}
	var body pluginhost.AccountMaterializeRequest
	if err := decodeOptionalJSONBody(response, request, &body, largeBodyBytes); err != nil {
		writeDecodeError(response, err)
		return
	}
	result, err := h.hostService.MaterializeAccount(request.Context(), body)
	if err != nil {
		writePluginDomainError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, struct {
		OK bool `json:"ok"`
		pluginhost.AccountMaterializeResult
	}{
		OK:                       true,
		AccountMaterializeResult: result,
	})
}

func decodeOptionalJSONBody(
	response http.ResponseWriter,
	request *http.Request,
	target any,
	maxBytes int64,
) error {
	if request == nil || request.Body == nil || request.Body == http.NoBody {
		return nil
	}
	request.Body = http.MaxBytesReader(response, request.Body, maxBytes)
	raw, err := io.ReadAll(request.Body)
	if err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			return httpjson.ErrBodyTooLarge
		}
		return httpjson.ErrInvalidDocument
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	if ct := strings.TrimSpace(request.Header.Get("Content-Type")); ct != "" {
		mediaType, _, parseErr := mime.ParseMediaType(ct)
		if parseErr != nil || mediaType != "application/json" {
			return httpjson.ErrUnsupportedMediaType
		}
	}
	if err := httpjson.ValidateDocument(raw); err != nil {
		return httpjson.ErrInvalidDocument
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(target); err != nil {
		return httpjson.ErrInvalidDocument
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return httpjson.ErrInvalidDocument
	}
	return nil
}

func requireMethod(response http.ResponseWriter, request *http.Request, allowed string) bool {
	if request.Method == allowed {
		return true
	}
	response.Header().Set("Allow", allowed)
	writePluginErrorJSON(response, http.StatusMethodNotAllowed, "method_not_allowed", "")
	return false
}

func writeDecodeError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, httpjson.ErrUnsupportedMediaType):
		writePluginErrorJSON(response, http.StatusUnsupportedMediaType, "unsupported_media_type", err.Error())
	case errors.Is(err, httpjson.ErrBodyTooLarge):
		writePluginErrorJSON(response, http.StatusRequestEntityTooLarge, "plugin_request_too_large", err.Error())
	default:
		writePluginErrorJSON(response, http.StatusBadRequest, "plugin_request_invalid", "请求体不是合法 JSON")
	}
}

func writePluginDomainError(response http.ResponseWriter, err error) {
	code := extractErrorCode(err)
	if code == "" {
		code = "plugin_error"
	}
	status := http.StatusBadRequest
	switch code {
	case "plugin_runtime_unavailable", "plugin_runtime_inactive", "plugin_contribution_unavailable", "pricing_service_unavailable":
		status = http.StatusServiceUnavailable
	case "plugin_revision_conflict", "plugin_in_use", "plugin_version_conflict":
		status = http.StatusConflict
	case "plugin_contribution_unknown", "plugin_not_installed", "plugin_instance_unknown":
		status = http.StatusNotFound
	}
	var diags []any
	if pe, ok := pluginerr.From(err); ok && len(pe.Diagnostics) > 0 {
		diags = pe.Diagnostics
	}
	writePluginErrorJSONWithDiags(response, status, code, err.Error(), diags)
}

func writePricingError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, pricingcatalog.ErrStoreUnavailable):
		writePluginErrorJSON(response, http.StatusServiceUnavailable, "pricing_source_store_unavailable", err.Error())
	case errors.Is(err, pricingcatalog.ErrSourceIDInvalid):
		writePluginErrorJSON(response, http.StatusBadRequest, "source_id_invalid", err.Error())
	case errors.Is(err, pricingcatalog.ErrReviewPendingMissing):
		writePluginErrorJSON(response, http.StatusNotFound, "pricing_review_pending_missing", err.Error())
	case errors.Is(err, pricingcatalog.ErrCommunitySourceUnknown):
		writePluginErrorJSON(response, http.StatusBadRequest, "community_pricing_source_unknown", err.Error())
	case errors.Is(err, pricingcatalog.ErrCommunityParserUnknown):
		writePluginErrorJSON(response, http.StatusInternalServerError, "community_pricing_parser_unknown", err.Error())
	case errors.Is(err, pricingcatalog.ErrCommunityFetchFailed):
		writePluginErrorJSON(response, http.StatusBadGateway, "community_pricing_refresh_failed", err.Error())
	case errors.Is(err, pricingcatalog.ErrInvalidMergeRequest), errors.Is(err, pricingcatalog.ErrInvalidQuote):
		writePluginErrorJSON(response, http.StatusBadRequest, "invalid_payload", err.Error())
	default:
		writePluginErrorJSON(response, http.StatusInternalServerError, "pricing_catalog_error", err.Error())
	}
}

func extractErrorCode(err error) string {
	if pe, ok := pluginerr.From(err); ok {
		return strings.TrimSpace(pe.Code)
	}
	var coded interface{ Code() string }
	if errors.As(err, &coded) {
		return strings.TrimSpace(coded.Code())
	}
	return ""
}

func writePluginErrorJSON(response http.ResponseWriter, status int, code string, message string) {
	writePluginErrorJSONWithDiags(response, status, code, message, nil)
}

func writePluginErrorJSONWithDiags(response http.ResponseWriter, status int, code string, message string, diags []any) {
	if strings.TrimSpace(message) == "" {
		message = code
	}
	if diags == nil {
		diags = []any{}
	}
	writeJSON(response, status, map[string]any{
		"ok":          false,
		"error":       code,
		"message":     message,
		"diagnostics": diags,
	})
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		response.Header().Set("Content-Type", "application/json; charset=utf-8")
		response.WriteHeader(http.StatusInternalServerError)
		_, _ = response.Write([]byte(`{"ok":false,"error":"internal_encode_error"}`))
		return
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_, _ = response.Write(append(encoded, '\n'))
}

func nonNilSlice[T any](items []T) []T {
	if items == nil {
		return []T{}
	}
	return items
}

func nonNilMap[K comparable, V any](items map[K]V) map[K]V {
	if items == nil {
		return map[K]V{}
	}
	return items
}
