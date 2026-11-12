// Package webuiaccountdeleteapi 提供账号页的删除写入口。
//
// 路由（由共享 wiring 注册）：
//
//	DELETE /v1/management/webui/accounts/{accountRef}?force=1
//
// 这条路是 Node 删除路由的唯一承接者：占用者探测与强制释放、宿主直连授权回收、
// 默认账号落点、账号持久化删除与投影收敛全部在这里完成，Node 只做协议外壳
// （解析路径、转管理密钥、透传状态码与响应体）。它不再反向调用 Node 的宿主
// 清理接口：tmux 会话由 Go 自己探测并终止。
//
// 失败关闭是这份契约的核心：探测不到 ≠ 没人。任何无法确认的运行时状态都必须
// 变成明确错误，绝不能静默放行一次「可能留下攥着已删凭据进程」的删除。
package webuiaccountdeleteapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// Path 是账号页集合资源的规范路径。
	Path = "/v1/management/webui/accounts"
	// DeleteSuffix 由共享 wiring 拼在 Path 之后。
	DeleteSuffix = "/{accountRef}"
)

// ErrInvalidDependencies 表示 Handler 缺少删除用例或鉴权策略。
var ErrInvalidDependencies = errors.New("账号删除接口依赖无效")

// Authorizer 校验管理密钥（与其它 /v1/management 接口同一权限域）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// AccountDeletion 是账号删除用例的最小端口。
type AccountDeletion interface {
	DeleteAccountWithOptions(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		options accountapp.DeletionOptions,
	) (accountapp.DeletionOutcome, error)
}

// Dependencies 汇总删除入口的依赖。
type Dependencies struct {
	Authorizer Authorizer
	Deletion   AccountDeletion
}

// Handler 是账号删除的 HTTP 入站适配器。
type Handler struct {
	authorizer Authorizer
	deletion   AccountDeletion
}

// NewHandler 校验依赖并创建 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Deletion == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		deletion:   dependencies.Deletion,
	}, nil
}

// successResponse 与 Node 删除路由的成功响应同形：ok + 两个可选投影结果。
type successResponse struct {
	OK               bool                            `json:"ok"`
	AIHServerDefault accountapp.ServerDefaultLanding `json:"aihServerDefault"`
	HostGrantRevoke  *accountapp.GrantRevocation     `json:"hostGrantRevoke,omitempty"`
}

// errorResponse 与 Node 的失败响应同形；occupants 只在 409 时出现。
type errorResponse struct {
	OK        bool                         `json:"ok"`
	Error     string                       `json:"error"`
	Message   string                       `json:"message,omitempty"`
	Occupants []accountapp.DeletionBlocker `json:"occupants,omitempty"`
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.deletion == nil {
		writeError(response, http.StatusServiceUnavailable, "webui_account_delete_unavailable", "账号删除接口不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodDelete {
		response.Header().Set("Allow", http.MethodDelete)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持删除账号")
		return
	}
	accountRef, ok := parseAccountRef(request.URL.Path)
	if !ok {
		writeError(response, http.StatusBadRequest, "invalid_account_path", "账号引用无效")
		return
	}
	force, ok := parseForce(request.URL.Query().Get("force"))
	if !ok {
		writeError(response, http.StatusBadRequest, "invalid_force", "force 只接受 1/true/0/false")
		return
	}
	outcome, err := handler.deletion.DeleteAccountWithOptions(
		request.Context(),
		accountRef,
		accountapp.DeletionOptions{Force: force},
	)
	if err != nil {
		writeDeleteError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, successResponse{
		OK:               true,
		AIHServerDefault: outcome.ServerDefault,
		HostGrantRevoke:  outcome.HostGrantRevoke,
	})
}

// parseAccountRef 从 /<prefix>/<accountRef> 里取出账号引用。
//
// 这里只做路径形状校验，账号是否存在由删除用例判定：协议外壳不该复制一份
// 账号库的知识。
func parseAccountRef(path string) (accountcore.AccountRef, bool) {
	trimmed := strings.TrimPrefix(path, Path)
	trimmed = strings.TrimPrefix(trimmed, "/")
	if trimmed == "" || strings.Contains(trimmed, "/") {
		return "", false
	}
	accountRef, err := accountcore.ParseAccountRef(trimmed)
	if err != nil {
		return "", false
	}
	return accountRef, true
}

// parseForce 复刻 Node 的 isForceDeleteRequest：缺省、1、true 为假/真，
// 其余值一律拒绝，避免把拼错的查询参数当成「不强杀」静默接受。
func parseForce(raw string) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "0", "false":
		return false, true
	case "1", "true":
		return true, true
	default:
		return false, false
	}
}

// writeDeleteError 把删除错误映射成稳定的状态码与 error 码。
//
// 409 / 503 都是真实语义，不能统一压成 500：前者要提示用户「有会话在跑，可以
// 确认后强杀」，后者是「状态无法确认或宿主清理通道不可用，稍后重试」。压平之后
// 前端只能二选一，必然把其中一种情况说错。
func writeDeleteError(response http.ResponseWriter, err error) {
	var runtimeActive *accountapp.RuntimeActiveError
	if errors.As(err, &runtimeActive) {
		writeJSON(response, http.StatusConflict, errorResponse{
			OK:        false,
			Error:     "account_runtime_active",
			Message:   buildOccupancyMessage(runtimeActive.Blockers),
			Occupants: runtimeActive.Blockers,
		})
		return
	}
	switch {
	case errors.Is(err, accountapp.ErrAccountNotFound):
		writeError(response, http.StatusNotFound, "account_not_found", "账号不存在")
	case errors.Is(err, accountapp.ErrAccountRuntimeActive):
		writeError(response, http.StatusConflict, "account_runtime_active", "账号仍有活跃会话，未被删除。")
	case errors.Is(err, accountapp.ErrAccountRuntimeUnverifiable):
		writeError(
			response,
			http.StatusServiceUnavailable,
			"account_runtime_unverifiable",
			"无法确认账号的运行时状态，账号未被删除。",
		)
	case errors.Is(err, accountapp.ErrAccountDeletionPreparationFailed):
		writeError(
			response,
			http.StatusServiceUnavailable,
			"account_deletion_preparation_failed",
			"无法安全收敛账号资源，账号未被删除。",
		)
	case errors.Is(err, accountapp.ErrAccountHostCleanupFailed):
		writeError(
			response,
			http.StatusServiceUnavailable,
			"account_host_cleanup_failed",
			"无法清理账号的宿主资源，账号未被删除。",
		)
	case errors.Is(err, accountapp.ErrInvalidDeletionRequest):
		writeError(response, http.StatusBadRequest, "invalid_account_delete_request", "删除请求无效")
	default:
		writeError(response, http.StatusBadGateway, "delete_account_failed", "账号删除失败，账号未被删除。")
	}
}

// buildOccupancyMessage 复刻 Node 的 buildOccupancyMessage：标签去重后列出，
// 明细取 session/detail 前 5 条，超过 5 条写「等」。前端把这段文案直接展示给
// 用户判断该不该强杀，措辞与截断规则必须和 Node 一致。
func buildOccupancyMessage(blockers []accountapp.DeletionBlocker) string {
	if len(blockers) == 0 {
		return "该账号仍被占用，无法删除。"
	}
	labels := make([]string, 0, len(blockers))
	seen := make(map[string]struct{}, len(blockers))
	details := make([]string, 0, len(blockers))
	for _, blocker := range blockers {
		label := strings.TrimSpace(blocker.Label)
		if label != "" {
			if _, found := seen[label]; !found {
				seen[label] = struct{}{}
				labels = append(labels, label)
			}
		}
		if detail := firstNonEmpty(blocker.Session, blocker.Detail); detail != "" {
			details = append(details, detail)
		}
	}
	suffix := ""
	if len(details) > 0 {
		shown := details
		ellipsis := ""
		if len(shown) > 5 {
			shown = shown[:5]
			ellipsis = " 等"
		}
		suffix = "（" + strings.Join(shown, "、") + ellipsis + "）"
	}
	if len(labels) == 0 {
		return "该账号仍被占用，无法删除。" + strings.TrimSuffix(suffix, "")
	}
	return "该账号有 " + strings.Join(labels, "、") + " 正在占用" + suffix + "，删除会终止它们。"
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	document, err := json.Marshal(payload)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "encode_failed", "响应编码失败")
		return
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_, _ = response.Write(document)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorResponse{OK: false, Error: code, Message: message})
}
