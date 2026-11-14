package aihserver

// 账号路径分发器：承接在 http.ServeMux 里互不更具体、无法同时注册的两类公开路径。
//
// 冲突来自这两个模式（Go 1.22 启动期会 panic）：
//
//	GET /v0/webui/accounts/activity/jobs/{jobId}
//	GET /v0/webui/accounts/{provider}/{accountRef}/quota-reset-events
//
// 二者在第 2/3 段与末段上各有字面量，谁都不比谁更具体。浏览器契约要求两条
// 路径都保留，所以用 /v0/webui/accounts/ 子树做一次显式分发：只匹配已知形状，
// 其余路径维持 404，不做任何兜底转发。

import (
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountactivityapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiquotaresetapi"
)

const (
	publicAccountsPrefix = "/v0/webui/accounts"
	activityJobsPrefix   = publicAccountsPrefix + "/activity/jobs/"
	quotaResetSuffix     = "quota-reset-events"
	resetHistorySuffix   = "reset-history"
)

// publicAccountsDispatcher 把账号活动任务与配额重置事件交给各自的处理器。
// 处理器的鉴权、方法与错误映射保持原样，分发器只负责路径改名。
type publicAccountsDispatcher struct {
	quotaReset http.Handler
	activity   http.Handler
}

func newPublicAccountsDispatcher(quotaReset, activity http.Handler) http.Handler {
	return publicAccountsDispatcher{quotaReset: quotaReset, activity: activity}
}

func (dispatcher publicAccountsDispatcher) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		response.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	path := request.URL.Path

	// /v0/webui/accounts/activity/jobs/{jobId} → account-activity/jobs/{jobId}
	if jobID, ok := strings.CutPrefix(path, activityJobsPrefix); ok {
		if jobID != "" && !strings.Contains(jobID, "/") && dispatcher.activity != nil {
			cloned := request.Clone(request.Context())
			cloned.URL.Path = webuiaccountactivityapi.Path + "/jobs/" + jobID
			cloned.URL.RawPath = ""
			dispatcher.activity.ServeHTTP(response, cloned)
			return
		}
		handleRouteNotFound(response, request)
		return
	}

	// /v0/webui/accounts/{provider}/{accountRef}/(quota-reset-events|reset-history)
	if rest, ok := strings.CutPrefix(path, publicAccountsPrefix+"/"); ok {
		parts := strings.Split(rest, "/")
		if len(parts) == 3 && parts[0] != "" && parts[1] != "" &&
			(parts[2] == quotaResetSuffix || parts[2] == resetHistorySuffix) &&
			dispatcher.quotaReset != nil {
			cloned := request.Clone(request.Context())
			cloned.URL.Path = webuiquotaresetapi.Path + "/" + parts[0] + "/" + parts[1] + "/" + parts[2]
			cloned.URL.RawPath = ""
			cloned.SetPathValue("provider", parts[0])
			cloned.SetPathValue("accountRef", parts[1])
			dispatcher.quotaReset.ServeHTTP(response, cloned)
			return
		}
	}
	handleRouteNotFound(response, request)
}
