// Package accountoutcomesapi 暴露账号请求结果时间桶（账号页状态条）的只读管理接口。
package accountoutcomesapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/madou1217/ai_home/application/accountoutcomes"
)

// Path 是账号结果时间桶的只读管理路径。
//
//	GET /v1/management/account-outcomes?granularity=day|hour&from_ms=<epoch ms>
const Path = "/v1/management/account-outcomes"

// ErrInvalidDependencies 表示 Handler 缺少查询端口或管理鉴权。
var ErrInvalidDependencies = errors.New("账号结果 Handler 依赖无效")

// Authorizer 是管理密钥鉴权端口。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Handler 只接受带管理密钥的 GET。
type Handler struct {
	authorizer Authorizer
	store      accountoutcomes.Reader
}

// NewHandler 创建只读 Handler。
func NewHandler(authorizer Authorizer, store accountoutcomes.Reader) (*Handler, error) {
	if authorizer == nil || store == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{authorizer: authorizer, store: store}, nil
}

type bucketView struct {
	AccountRef    string `json:"account_ref"`
	BucketStartMS int64  `json:"bucket_start_ms"`
	Outcome       string `json:"outcome"`
	Count         int64  `json:"count"`
}

type errorView struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ServeHTTP 返回指定粒度自 from_ms 起的全部计数行。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeJSON(response, http.StatusUnauthorized, map[string]errorView{"error": {Code: "unauthorized", Message: "管理密钥无效"}})
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeJSON(response, http.StatusMethodNotAllowed, map[string]errorView{"error": {Code: "method_not_allowed", Message: "只支持 GET"}})
		return
	}
	granularity := accountoutcomes.Granularity(request.URL.Query().Get("granularity"))
	fromMS, err := strconv.ParseInt(request.URL.Query().Get("from_ms"), 10, 64)
	if err != nil {
		fromMS = -1
	}
	buckets, err := accountoutcomes.Query(request.Context(), handler.store, granularity, fromMS)
	if errors.Is(err, accountoutcomes.ErrInvalidQuery) {
		writeJSON(response, http.StatusBadRequest, map[string]errorView{"error": {Code: "invalid_query", Message: "granularity 必须是 day 或 hour，from_ms 必须是非负毫秒时间戳"}})
		return
	}
	if err != nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]errorView{"error": {Code: "outcomes_unavailable", Message: "账号结果暂不可用"}})
		return
	}
	views := make([]bucketView, 0, len(buckets))
	for _, bucket := range buckets {
		views = append(views, bucketView{
			AccountRef:    bucket.AccountRef.String(),
			BucketStartMS: bucket.BucketStartMS,
			Outcome:       bucket.Outcome,
			Count:         bucket.Count,
		})
	}
	writeJSON(response, http.StatusOK, map[string]any{"data": views})
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}
