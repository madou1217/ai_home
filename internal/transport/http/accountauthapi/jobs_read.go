package accountauthapi

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/application/accountauth"
)

const (
	// JobsPath 是持久化 OAuth Job 公开快照的只读集合路径。
	//
	// 它与 CollectionPath 刻意分开：CollectionPath 后面接的是只活在进程内的
	// OAuth Flow（含 state/PKCE），重启即失效；这里的记录来自 aih.db，
	// 重启后仍然可查，两者的生命周期与安全边界不同，不能混在同一路径下。
	JobsPath = "/v1/management/oauth-jobs"
	// maxListedJobs 限制单次列表的返回条数。
	//
	// 持久化表只增不减，WebUI 每次刷新都全量拉取会随着重启次数线性变慢，
	// 因此在入站适配器这一层就裁掉尾部，客户端只看最近的快照。
	maxListedJobs = 100
)

// JobReader 是持久化 OAuth Job 快照的只读端口。
//
// 只暴露 Get/List：写入与过期收敛（Upsert/Expire）归应用服务和组合根所有，
// HTTP 适配器不该获得改动 Job 状态的能力，否则一次查询就可能把 Job 写坏。
type JobReader interface {
	GetJob(
		ctx context.Context,
		jobID string,
	) (accountauth.JobRecord, bool, error)
	ListJobs(
		ctx context.Context,
		activeOnly bool,
	) ([]accountauth.JobRecord, error)
}

// jobRecordView 是持久化快照的公开投影。
//
// 字段与 accountauth.JobRecord 一一对应，且只包含可公开的信息：
// 授权码、state、PKCE、Token 从未进入 JobRecord，自然也不会出现在响应里。
type jobRecordView struct {
	JobID        string `json:"job_id"`
	ProviderID   string `json:"provider_id"`
	Purpose      string `json:"purpose"`
	TargetRef    string `json:"target_ref,omitempty"`
	Status       string `json:"status"`
	CreatedAt    string `json:"created_at"`
	ExpiresAt    string `json:"expires_at"`
	UpdatedAt    string `json:"updated_at"`
	ErrorCode    string `json:"error_code,omitempty"`
	ErrorMessage string `json:"error_message,omitempty"`
}

// jobRecordResponse 是单条 Job 快照的成功 envelope，与现有 Job 查询保持一致。
type jobRecordResponse struct {
	Data jobRecordView `json:"data"`
}

// jobRecordListResponse 是 Job 列表的成功 envelope。
type jobRecordListResponse struct {
	Data []jobRecordView `json:"data"`
}

// handleJobCollection 返回最近的持久化 Job 快照。
func (handler *Handler) handleJobCollection(
	response http.ResponseWriter,
	request *http.Request,
) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeMethodNotAllowed(response)
		return
	}
	activeOnly, err := parseActiveOnlyQuery(request)
	if err != nil {
		writeAPIError(
			response,
			http.StatusBadRequest,
			"invalid_query",
			"查询参数 active 只支持 1",
		)
		return
	}
	if handler.records == nil {
		writeJobReaderUnavailable(response)
		return
	}
	records, err := handler.records.ListJobs(request.Context(), activeOnly)
	if err != nil {
		writeJobReadFailure(response)
		return
	}
	writeJSON(response, http.StatusOK, jobRecordListResponse{
		Data: newJobRecordViews(records),
	})
}

// handleJobRecord 返回单条持久化 Job 快照。
func (handler *Handler) handleJobRecord(
	response http.ResponseWriter,
	request *http.Request,
	jobID string,
) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeMethodNotAllowed(response)
		return
	}
	if rejectUnexpectedQuery(response, request) {
		return
	}
	if handler.records == nil {
		writeJobReaderUnavailable(response)
		return
	}
	record, found, err := handler.records.GetJob(request.Context(), jobID)
	if err != nil {
		writeJobReadFailure(response)
		return
	}
	if !found {
		// 未知与已清理的 Job 都收敛为 404：对读方而言没有区别，
		// 也不需要暴露「曾经存在但被删掉」这种内部状态。
		writeAPIError(
			response,
			http.StatusNotFound,
			"oauth_job_not_found",
			"OAuth Job 不存在",
		)
		return
	}
	writeJSON(
		response,
		http.StatusOK,
		jobRecordResponse{Data: newJobRecordView(record)},
	)
}

// parseJobRecordPath 只接受单个非空 ID 段。
//
// 这里不复制 32 位十六进制规则：读接口面向已持久化的历史记录，
// 若把当前生成器的形状固化成契约，换 ID 方案时旧记录就会被判成非法路径。
// 路径结构仍然校验，避免把 /jobs/a/b 这类请求当成 Job ID 去查库。
func parseJobRecordPath(path string) (string, error) {
	remainder := strings.TrimPrefix(path, JobsPath+"/")
	if remainder == "" || strings.Contains(remainder, "/") {
		return "", errors.New("OAuth Job 资源路径无效")
	}
	return remainder, nil
}

// parseActiveOnlyQuery 只接受 active=1。
//
// 用显式白名单而不是给 bool 参数做模糊解析：?active=true、?active=0 这类
// 输入一旦被猜错，客户端会拿到「全部 Job」却以为是活动列表，错误很难发现。
func parseActiveOnlyQuery(request *http.Request) (bool, error) {
	query := request.URL.Query()
	for key, values := range query {
		if key != "active" {
			return false, errors.New("不支持的查询参数")
		}
		if len(values) != 1 || values[0] != "1" {
			return false, errors.New("active 只支持 1")
		}
	}
	return query.Has("active"), nil
}

// newJobRecordViews 按 updated_at 倒序输出并裁剪到契约上限。
//
// 排序放在适配器兜底：ListJobs 的实现只承诺返回候选集合，
// 这里统一顺序后，换存储实现（sqlite/内存假件）时客户端观察到的次序不变。
func newJobRecordViews(records []accountauth.JobRecord) []jobRecordView {
	ordered := make([]accountauth.JobRecord, len(records))
	copy(ordered, records)
	sort.SliceStable(ordered, func(left int, right int) bool {
		if !ordered[left].UpdatedAt.Equal(ordered[right].UpdatedAt) {
			return ordered[left].UpdatedAt.After(ordered[right].UpdatedAt)
		}
		// 同一毫秒内的记录用 Job ID 兜底，避免列表顺序在两次刷新间抖动。
		return ordered[left].ID > ordered[right].ID
	})
	if len(ordered) > maxListedJobs {
		ordered = ordered[:maxListedJobs]
	}
	views := make([]jobRecordView, 0, len(ordered))
	for _, record := range ordered {
		views = append(views, newJobRecordView(record))
	}
	return views
}

// newJobRecordView 把持久化记录映射为跨语言稳定的 JSON 投影。
func newJobRecordView(record accountauth.JobRecord) jobRecordView {
	return jobRecordView{
		JobID:        record.ID,
		ProviderID:   record.ProviderID,
		Purpose:      string(record.Purpose),
		TargetRef:    record.TargetRef,
		Status:       string(record.Status),
		CreatedAt:    formatTime(record.CreatedAt),
		ExpiresAt:    formatTime(record.ExpiresAt),
		UpdatedAt:    formatTime(record.UpdatedAt),
		ErrorCode:    record.ErrorCode,
		ErrorMessage: record.ErrorMessage,
	}
}

// writeJobReaderUnavailable 表示部署没有装配读端口，而不是 Job 不存在。
//
// 用 503 而不是 404/500：这是可预期的接线缺失（例如精简二进制不带 sqlite），
// 客户端可以据此降级，也不会把「没接线」误读成「Job 丢了」。
func writeJobReaderUnavailable(response http.ResponseWriter) {
	writeAPIError(
		response,
		http.StatusServiceUnavailable,
		"job_store_unavailable",
		"OAuth Job 快照存储不可用",
	)
}

// writeJobReadFailure 隐藏存储错误的内部文本，只保留稳定错误码。
func writeJobReadFailure(response http.ResponseWriter) {
	writeAPIError(
		response,
		http.StatusInternalServerError,
		"internal_error",
		"OAuth Job 快照读取失败",
	)
}
