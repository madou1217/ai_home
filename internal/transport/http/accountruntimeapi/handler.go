// Package accountruntimeapi 暴露账号当前运行态（硬阻塞、模型 cooldown、最近结果）的只读管理接口。
//
// Go 的运行态只在本进程内存里；Node 账号页按它合成「调度状态」与「上次成功使用」，
// 否则由 Go 承接的流量产生的冷却 / 熔断在账号页永远看不到。
package accountruntimeapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

// Path 是账号运行态快照的只读管理路径。
//
//	GET /v1/management/account-runtime
const Path = "/v1/management/account-runtime"

// ErrInvalidDependencies 表示 Handler 缺少快照端口或管理鉴权。
var ErrInvalidDependencies = errors.New("账号运行态 Handler 依赖无效")

// Authorizer 是管理密钥鉴权端口。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Handler 只接受带管理密钥的 GET。
type Handler struct {
	authorizer Authorizer
	source     runtimeapp.Snapshotter
}

// NewHandler 创建只读 Handler。
func NewHandler(authorizer Authorizer, source runtimeapp.Snapshotter) (*Handler, error) {
	if authorizer == nil || source == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{authorizer: authorizer, source: source}, nil
}

type modelView struct {
	Model           string   `json:"model"`
	Blocks          []string `json:"blocks,omitempty"`
	CooldownKind    string   `json:"cooldown_kind,omitempty"`
	CooldownUntilMS int64    `json:"cooldown_until_ms,omitempty"`
}

type accountView struct {
	AccountRef      string      `json:"account_ref"`
	Blocks          []string    `json:"blocks,omitempty"`
	Models          []modelView `json:"models,omitempty"`
	LastSuccessMS   int64       `json:"last_success_ms,omitempty"`
	LastFailureMS   int64       `json:"last_failure_ms,omitempty"`
	LastFailureKind string      `json:"last_failure_kind,omitempty"`
}

type errorView struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ServeHTTP 返回当前全部有运行态记录的账号。
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
	snapshot := handler.source.RuntimeSnapshot()
	views := make([]accountView, 0, len(snapshot))
	for _, account := range snapshot {
		view := accountView{
			AccountRef:      account.AccountRef.String(),
			Blocks:          triggerStrings(account.Blocks),
			LastSuccessMS:   unixMilli(account.LastSuccessAt),
			LastFailureMS:   unixMilli(account.LastFailureAt),
			LastFailureKind: account.LastFailureKind,
		}
		for _, model := range account.Models {
			view.Models = append(view.Models, modelView{
				Model:           model.Model.String(),
				Blocks:          triggerStrings(model.Blocks),
				CooldownKind:    string(model.CooldownKind),
				CooldownUntilMS: unixMilli(model.CooldownUntil),
			})
		}
		views = append(views, view)
	}
	writeJSON(response, http.StatusOK, map[string]any{"data": views})
}

func triggerStrings(triggers []runtimecore.RecoveryTrigger) []string {
	if len(triggers) == 0 {
		return nil
	}
	values := make([]string, 0, len(triggers))
	for _, trigger := range triggers {
		values = append(values, string(trigger))
	}
	return values
}

func unixMilli(value time.Time) int64 {
	if value.IsZero() {
		return 0
	}
	return value.UnixMilli()
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}
