// Package webuiaccountimportapi 提供账号导入作业的 WebUI 管理入口。
//
// 路由（由共享 wiring 注册，本包只导出模式常量）：
//
//	POST /v1/management/webui/account-import
//	GET  /v1/management/webui/account-import/jobs/{jobId}
//
// 作业状态机、上传解码、文档解析与逐条导入都在 Go；Node 只保留
// /v0/webui/accounts/import* 的协议外壳（鉴权、体积上限、转发），并消费 Go 广播的
// import-job 事件转发给浏览器。
//
// 路径刻意不挂在 /accounts/import 下：Go 的 ServeMux 会把
// GET /accounts/import/jobs/{jobId} 与 GET /accounts/{provider}/{accountRef}/quota-reset-events
// 判成互不包含的歧义模式（两者都能匹配 /accounts/import/jobs/quota-reset-events）。
// 与 account-add 使用独立前缀同理，浏览器看到的仍是 /v0/webui/accounts/import*。
//
// 错误信封刻意使用 WebUI 旧形状 {ok:false,error:<code>,message}：浏览器直接读
// data.error 做分支（import_job_already_running 要带 jobId 打开现有进度），
// 本包因此不套 {error:{code,message}} 的管理面信封。
package webuiaccountimportapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

const (
	// Path 是账号导入作业的 WebUI 契约前缀。
	//
	//	POST /v1/management/webui/account-import
	Path = "/v1/management/webui/account-import"
	// JobsSuffix 拼在 Path 之后，构成单作业资源模式。
	JobsSuffix = "/jobs/{jobId}"

	// maxImportBodyBytes 与 Node 的 WEBUI_ACCOUNT_IMPORT_MAX_BYTES 一致（80MB）。
	maxImportBodyBytes = 80 * 1024 * 1024
)

// ErrInvalidDependencies 表示 Handler 缺少导入端口、事件发布器或鉴权策略。
var ErrInvalidDependencies = errors.New("账号导入作业接口依赖无效")

// Authorizer 是管理面请求的鉴权策略（与其它 WebUI 管理接口共用）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// DocumentImporter 是 aih-accounts 文档的逐条导入端口。
//
// accountsapi 的账号 Handler 即实现：文档语义（静态 env / nativeAuth 的凭据构造、
// 同身份幂等）只有一份，管理面 HTTP 端点与这里的作业共用同一实现。
type DocumentImporter interface {
	ImportAihAccounts(
		ctx context.Context,
		entries []accountsapi.AihAccountsImportEntry,
	) accountsapi.AihAccountsImportResult
}

// EventPublisher 把作业事件广播到账号页事件流（由 account-live 的 Handler 实现）。
type EventPublisher interface {
	Publish(payload any)
}

// Dependencies 汇总账号导入作业的依赖。
type Dependencies struct {
	Authorizer Authorizer
	Importer   DocumentImporter
	Publisher  EventPublisher
	// Now 是测试时钟；空值时使用生产时间。
	Now func() time.Time
}

// Handler 是账号导入作业的 HTTP 入站适配器。
type Handler struct {
	authorizer Authorizer
	engine     *jobEngine
}

// NewHandler 校验依赖并创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil ||
		dependencies.Importer == nil ||
		dependencies.Publisher == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		engine: newJobEngine(
			dependencies.Importer,
			dependencies.Publisher.Publish,
			dependencies.Now,
		),
	}, nil
}

// ServeHTTP 分发作业创建与查询。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.engine == nil {
		writeWebUIError(response, http.StatusServiceUnavailable, "webui_accounts_import_unavailable", "账号导入不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeWebUIError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	path := request.URL.Path
	if path == Path {
		handler.serveStart(response, request)
		return
	}
	if jobID := strings.TrimPrefix(path, Path+"/jobs/"); jobID != path && jobID != "" &&
		!strings.Contains(jobID, "/") {
		handler.serveJob(response, request, jobID)
		return
	}
	writeWebUIError(response, http.StatusNotFound, "route_not_found", "请求的导入资源不存在")
}

// serveStart 接收导入负载并立刻返回 202；执行在后台完成。
func (handler *Handler) serveStart(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeWebUIError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持创建导入作业")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(response, request.Body, maxImportBodyBytes))
	if err != nil || len(body) == 0 {
		writeWebUIError(response, http.StatusBadRequest, "invalid_import_data", "导入数据不是有效的 JSON")
		return
	}
	payload, ok := decodeImportPayload(body)
	if !ok {
		writeWebUIError(response, http.StatusBadRequest, "invalid_import_data", "导入数据不是有效的 JSON")
		return
	}
	view, active := handler.engine.start(payload)
	if active != nil {
		writeWebUIJSON(response, http.StatusConflict, activeJobResponse{
			OK:    false,
			Error: "import_job_already_running",
			JobID: active.ID,
			Job:   *active,
		})
		return
	}
	writeWebUIJSON(response, http.StatusAccepted, startJobResponse{
		OK:       true,
		Status:   view.Status,
		JobID:    view.ID,
		Imported: view.Summary.Imported,
		Summary:  view.Summary,
		Result:   view.Result,
		Job:      view,
	})
}

// serveJob 返回作业快照；终态作业超过保留期后同样按不存在处理。
func (handler *Handler) serveJob(response http.ResponseWriter, request *http.Request, jobID string) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeWebUIError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持查询导入作业")
		return
	}
	view, ok := handler.engine.get(jobID)
	if !ok {
		writeWebUIError(response, http.StatusNotFound, "job_not_found", "导入作业不存在")
		return
	}
	writeWebUIJSON(response, http.StatusOK, jobResponse{OK: true, Job: view})
}

// decodeImportPayload 解析请求体。
//
// 只有「不是合法 JSON」才算 400；合法但不是对象（例如数组）时返回空负载，
// 由作业以 missing_import_content 结束——与旧实现的处理顺序一致。
func decodeImportPayload(body []byte) (importPayload, bool) {
	var payload importPayload
	if err := json.Unmarshal(body, &payload); err == nil {
		return payload, true
	}
	var probe any
	if err := json.Unmarshal(body, &probe); err != nil {
		return importPayload{}, false
	}
	return importPayload{}, true
}

// startJobResponse 是创建作业的成功 envelope（字段与前端 AccountImportResponse 一致）。
type startJobResponse struct {
	OK       bool          `json:"ok"`
	Status   string        `json:"status"`
	JobID    string        `json:"jobId"`
	Imported int           `json:"imported"`
	Summary  importSummary `json:"summary"`
	Result   *importResult `json:"result"`
	Job      importJobView `json:"job"`
}

// activeJobResponse 是「已有作业在跑」的 409 envelope（前端用它切换到现有进度）。
type activeJobResponse struct {
	OK    bool          `json:"ok"`
	Error string        `json:"error"`
	JobID string        `json:"jobId"`
	Job   importJobView `json:"job"`
}

// jobResponse 是作业查询的成功 envelope。
type jobResponse struct {
	OK  bool          `json:"ok"`
	Job importJobView `json:"job"`
}

// webUIErrorResponse 是浏览器直接消费的错误形状。
type webUIErrorResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

func writeWebUIJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeWebUIError(response http.ResponseWriter, status int, code, message string) {
	writeWebUIJSON(response, status, webUIErrorResponse{OK: false, Error: code, Message: message})
}
