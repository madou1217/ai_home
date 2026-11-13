// Package webuipricingapi 提供价格目录、复核队列、社区价格采集与报价合并的 WebUI 管理契约。
//
// 暴露路径：
//
//	GET  /v1/management/webui/pricing/sources
//	GET  /v1/management/webui/pricing/reviews
//	GET  /v1/management/webui/pricing/status
//	POST /v1/management/webui/pricing/refresh
//	POST /v1/management/webui/pricing/approve
//	POST /v1/management/webui/pricing/reject
//	POST /v1/management/webui/pricing/merge-quotes
package webuipricingapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/pricingcatalog"
	"github.com/madou1217/ai_home/internal/transport/http/httpjson"
)

const (
	// Path 是价格管理契约的公共路径前缀。
	Path = "/v1/management/webui/pricing"

	SourcesPath     = Path + "/sources"
	ReviewsPath     = Path + "/reviews"
	StatusPath      = Path + "/status"
	RefreshPath     = Path + "/refresh"
	ApprovePath     = Path + "/approve"
	RejectPath      = Path + "/reject"
	MergeQuotesPath = Path + "/merge-quotes"

	smallBodyBytes = 256 * 1024
	largeBodyBytes = 16 * 1024 * 1024
)

// ErrInvalidDependencies 表示价格管理接口缺少必需的鉴权或服务依赖。
var ErrInvalidDependencies = errors.New("价格管理接口依赖无效")

// Authorizer 是管理面请求的鉴权策略。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总价格管理 HTTP 适配器的依赖。
type Dependencies struct {
	Authorizer Authorizer
	Service    *pricingcatalog.Service
}

// Handler 负责把 /v1/management/webui/pricing/* 路由映射到 pricingcatalog.Service。
type Handler struct {
	authorizer Authorizer
	service    *pricingcatalog.Service
}

// NewHandler 创建失败关闭的价格管理 HTTP 处理器。
func NewHandler(dependencies Dependencies) (http.Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Service == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		service:    dependencies.Service,
	}, nil
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

type sourcesResponse struct {
	OK               bool                            `json:"ok"`
	CommunitySources []pricingcatalog.CommunitySource `json:"communitySources"`
	Sources          []pricingcatalog.SourceSummary   `json:"sources"`
	Reviews          []pricingcatalog.ReviewItem      `json:"reviews"`
}

type reviewsResponse struct {
	OK      bool                        `json:"ok"`
	Reviews []pricingcatalog.ReviewItem `json:"reviews"`
}

type statusResponse struct {
	OK             bool                          `json:"ok"`
	Running        bool                          `json:"running"`
	LastRun        *pricingcatalog.RefreshReport `json:"lastRun"`
	Sources        int                           `json:"sources"`
	PendingReviews int                           `json:"pendingReviews"`
	Records        int                           `json:"records"`
	Doctor         *pricingcatalog.DoctorReport  `json:"doctor,omitempty"`
}

type refreshRequest struct {
	SourceID        string                              `json:"sourceId"`
	PluginSnapshots []pricingcatalog.PluginSnapshotInput `json:"pluginSnapshots"`
}

type refreshSourceResponse struct {
	OK             bool                         `json:"ok"`
	SourceID       string                       `json:"sourceId"`
	Applied        bool                         `json:"applied"`
	ReviewRequired bool                         `json:"reviewRequired"`
	Changes        []pricingcatalog.QuoteChange `json:"changes"`
	Reviews        []pricingcatalog.ReviewItem  `json:"reviews"`
	FetchedAt      string                       `json:"fetchedAt"`
	QuoteCount     int                          `json:"quoteCount"`
}

type refreshAllResponse struct {
	OK        bool                         `json:"ok"`
	PluginRun pricingcatalog.RefreshReport `json:"pluginRun"`
}

type sourceActionRequest struct {
	SourceID string `json:"sourceId"`
}

type approveResponse struct {
	OK        bool   `json:"ok"`
	SourceID  string `json:"sourceId"`
	AppliedAt string `json:"appliedAt"`
	Quotes    int    `json:"quotes"`
}

type rejectResponse struct {
	OK       bool   `json:"ok"`
	SourceID string `json:"sourceId"`
	Rejected bool   `json:"rejected"`
}

type mergeQuotesResponse struct {
	OK              bool                                  `json:"ok"`
	Quote           pricingcatalog.MergedPriceQuote       `json:"quote"`
	Contributions   int                                   `json:"contributions"`
	Snapshot        *pricingcatalog.ApplySnapshotOutcome  `json:"snapshot,omitempty"`
	SourceSnapshots []pricingcatalog.ApplySnapshotOutcome `json:"sourceSnapshots,omitempty"`
}

// ServeHTTP 先鉴权再分发路由与方法，避免未授权探测路由是否存在。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.service == nil {
		writeJSONError(response, http.StatusServiceUnavailable, "pricing_source_store_unavailable", "价格目录服务未就绪")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeJSONError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}

	switch request.URL.Path {
	case SourcesPath:
		if !requireMethod(response, request, http.MethodGet) {
			return
		}
		handler.handleSources(response)
	case ReviewsPath:
		if !requireMethod(response, request, http.MethodGet) {
			return
		}
		handler.handleReviews(response, request)
	case StatusPath:
		if !requireMethod(response, request, http.MethodGet) {
			return
		}
		handler.handleStatus(response, request)
	case RefreshPath:
		if !requireMethod(response, request, http.MethodPost) {
			return
		}
		handler.handleRefresh(response, request)
	case ApprovePath:
		if !requireMethod(response, request, http.MethodPost) {
			return
		}
		handler.handleApprove(response, request)
	case RejectPath:
		if !requireMethod(response, request, http.MethodPost) {
			return
		}
		handler.handleReject(response, request)
	case MergeQuotesPath:
		if !requireMethod(response, request, http.MethodPost) {
			return
		}
		handler.handleMergeQuotes(response, request)
	default:
		writeJSONError(response, http.StatusNotFound, "not_found", "")
	}
}

func (handler *Handler) handleSources(response http.ResponseWriter) {
	payload, err := handler.service.SourcesPayload()
	if err != nil {
		writeDomainError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, sourcesResponse{
		OK:               true,
		CommunitySources: payload.CommunitySources,
		Sources:          payload.Sources,
		Reviews:          payload.Reviews,
	})
}

func (handler *Handler) handleReviews(response http.ResponseWriter, request *http.Request) {
	status := strings.TrimSpace(request.URL.Query().Get("status"))
	reviews := handler.service.ListReviews(status)
	writeJSON(response, http.StatusOK, reviewsResponse{
		OK:      true,
		Reviews: reviews,
	})
}

func (handler *Handler) handleStatus(response http.ResponseWriter, request *http.Request) {
	detail := strings.TrimSpace(request.URL.Query().Get("detail"))
	includeDoctor := strings.EqualFold(detail, "doctor")
	status, err := handler.service.Status(includeDoctor)
	if err != nil {
		writeDomainError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, statusResponse{
		OK:             true,
		Running:        status.Running,
		LastRun:        status.LastRun,
		Sources:        status.Sources,
		PendingReviews: status.PendingReviews,
		Records:        status.Records,
		Doctor:         status.Doctor,
	})
}

func (handler *Handler) handleRefresh(response http.ResponseWriter, request *http.Request) {
	var body refreshRequest
	if err := decodeOptionalJSONBody(response, request, &body, largeBodyBytes); err != nil {
		writeDecodeError(response, err)
		return
	}
	sourceID := strings.TrimSpace(body.SourceID)
	if sourceID != "" {
		res, err := handler.service.RefreshSource(request.Context(), sourceID)
		if err != nil {
			writeDomainError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, refreshSourceResponse{
			OK:             true,
			SourceID:       res.SourceID,
			Applied:        res.Applied,
			ReviewRequired: res.ReviewRequired,
			Changes:        res.Changes,
			Reviews:        res.Reviews,
			FetchedAt:      res.FetchedAt,
			QuoteCount:     res.QuoteCount,
		})
		return
	}

	report, err := handler.service.RefreshAll(request.Context(), body.PluginSnapshots)
	if err != nil {
		writeDomainError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, refreshAllResponse{
		OK:        true,
		PluginRun: report,
	})
}

func (handler *Handler) handleApprove(response http.ResponseWriter, request *http.Request) {
	var body sourceActionRequest
	if err := httpjson.DecodeRequest(response, request, &body, smallBodyBytes); err != nil {
		writeDecodeError(response, err)
		return
	}
	outcome, err := handler.service.ApproveSource(body.SourceID)
	if err != nil {
		writeDomainError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, approveResponse{
		OK:        true,
		SourceID:  outcome.SourceID,
		AppliedAt: outcome.AppliedAt,
		Quotes:    outcome.Quotes,
	})
}

func (handler *Handler) handleReject(response http.ResponseWriter, request *http.Request) {
	var body sourceActionRequest
	if err := httpjson.DecodeRequest(response, request, &body, smallBodyBytes); err != nil {
		writeDecodeError(response, err)
		return
	}
	outcome, err := handler.service.RejectSource(body.SourceID)
	if err != nil {
		writeDomainError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, rejectResponse{
		OK:       true,
		SourceID: outcome.SourceID,
		Rejected: outcome.Rejected,
	})
}

func (handler *Handler) handleMergeQuotes(response http.ResponseWriter, request *http.Request) {
	var body pricingcatalog.MergeQuotesRequest
	if err := httpjson.DecodeRequest(response, request, &body, largeBodyBytes); err != nil {
		writeDecodeError(response, err)
		return
	}
	merged, err := handler.service.MergeQuotes(body)
	if err != nil {
		writeDomainError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, mergeQuotesResponse{
		OK:              true,
		Quote:           merged.Quote,
		Contributions:   merged.Contributions,
		Snapshot:        merged.Snapshot,
		SourceSnapshots: merged.SourceSnapshots,
	})
}

// decodeOptionalJSONBody 允许空请求体视为零值对象；非空请求体则执行与 httpjson 相同的严格 JSON 校验。
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
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return httpjson.ErrUnsupportedMediaType
	}
	if err := httpjson.ValidateDocument(raw); err != nil {
		return httpjson.ErrInvalidDocument
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
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
	writeJSONError(response, http.StatusMethodNotAllowed, "method_not_allowed", "")
	return false
}

func writeDecodeError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, httpjson.ErrUnsupportedMediaType):
		writeJSONError(response, http.StatusUnsupportedMediaType, "unsupported_media_type", err.Error())
	case errors.Is(err, httpjson.ErrBodyTooLarge):
		writeJSONError(response, http.StatusRequestEntityTooLarge, "body_too_large", err.Error())
	default:
		writeJSONError(response, http.StatusBadRequest, "invalid_payload", "请求体 JSON 无效")
	}
}

func writeDomainError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, pricingcatalog.ErrStoreUnavailable):
		writeJSONError(response, http.StatusServiceUnavailable, "pricing_source_store_unavailable", err.Error())
	case errors.Is(err, pricingcatalog.ErrSourceIDInvalid):
		writeJSONError(response, http.StatusBadRequest, "source_id_invalid", err.Error())
	case errors.Is(err, pricingcatalog.ErrReviewPendingMissing):
		writeJSONError(response, http.StatusNotFound, "pricing_review_pending_missing", err.Error())
	case errors.Is(err, pricingcatalog.ErrCommunitySourceUnknown):
		writeJSONError(response, http.StatusBadRequest, "community_pricing_source_unknown", err.Error())
	case errors.Is(err, pricingcatalog.ErrCommunityParserUnknown):
		writeJSONError(response, http.StatusInternalServerError, "community_pricing_parser_unknown", err.Error())
	case errors.Is(err, pricingcatalog.ErrCommunityFetchFailed):
		writeJSONError(response, http.StatusBadGateway, "community_pricing_refresh_failed", err.Error())
	case errors.Is(err, pricingcatalog.ErrInvalidMergeRequest):
		writeJSONError(response, http.StatusBadRequest, "invalid_payload", err.Error())
	default:
		writeJSONError(response, http.StatusInternalServerError, "pricing_catalog_failed", err.Error())
	}
}

func writeJSONError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{
		OK:      false,
		Error:   code,
		Message: message,
	})
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		http.Error(response, `{"ok":false,"error":"internal_error"}`, http.StatusInternalServerError)
		return
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_, _ = response.Write(encoded)
}
