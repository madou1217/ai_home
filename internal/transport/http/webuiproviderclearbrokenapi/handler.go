// Package webuiproviderclearbrokenapi 提供 provider CLI 自动升级熔断的人工清除入口。
//
// 路由（由共享 wiring 注册，本包只导出模式常量）：
//
//	POST /v1/management/webui/provider-cli-upgrade/{provider}/clear-broken
//
// 这是升级状态面唯一的写操作：熔断是 runner 的终局状态，代码不会自愈重试，只能人工
// 清除。语义与 Node 的 clearBrokenProvider 对齐——先确认账本确实处于熔断，再（可选）
// 验证当前会被启动的那份 CLI，只有明确通过才解除，并把它记为新的回退锚点。本切片只
// 改账本，不安装任何东西。
package webuiproviderclearbrokenapi

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/runtime/providercliupgrade"
)

const (
	// Path 与只读接口 webuiprovidercliupgradeapi.Path 相同：本包只挂它的子路径。
	//
	//	GET  /v1/management/webui/provider-cli-upgrade
	//	POST /v1/management/webui/provider-cli-upgrade/{provider}/clear-broken
	Path = "/v1/management/webui/provider-cli-upgrade"

	// ClearBrokenSuffix 由共享 wiring 拼在 Path 之后，构成管理路由模式。
	ClearBrokenSuffix = "/{provider}/clear-broken"

	// 业务原因码，与 Node clearBrokenProvider / scheduler.clearBroken 的取值一致。
	ReasonCleared                 = "cleared"
	ReasonNotBroken               = "not_broken"
	ReasonAlreadyRunning          = "already_running"
	ReasonUnknownProvider         = "unknown_provider"
	ReasonInstalledVersionUnknown = "installed_version_unknown"
	ReasonVerifyFailed            = "verify_failed"
	ReasonVerifyInconclusive      = "verify_inconclusive"
	ReasonLedgerWriteFailed       = "ledger_write_failed"
)

// providerPattern 与 Node 的 CLEAR_BROKEN_PATTERN（[a-z0-9_-]+）一致。
var providerPattern = regexp.MustCompile(`^[a-z0-9_-]+$`)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("解除熔断接口依赖无效")

// Authorizer 校验管理密钥（与其它 /v1/management 接口同一权限域）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Verdict 是一次安装验证的结论，取值与 Node 的 VERDICTS 一致。
type Verdict string

const (
	// VerdictPass 明确通过：只有它能解除熔断。
	VerdictPass Verdict = "pass"
	// VerdictFail 明确不可用。
	VerdictFail Verdict = "fail"
	// VerdictInconclusive 没能确证可用；贸然解除等于没有安全网，按失败处理。
	VerdictInconclusive Verdict = "inconclusive"
)

// Verification 是验证器对「当前会被启动的那份 CLI」的结论。
type Verification struct {
	// Verdict 是验证结论。
	Verdict Verdict
	// Detail 是给人看的原因，会进响应 detail 与账本 history。
	Detail string
}

// Verifier 验证当前安装的 CLI 是否真的可用。
//
// 与 Node 的 deps.probeInstalledVersion + deps.verify 两步对齐：先探测当前版本，再对
// 该版本验证。两步分开是为了让写进账本的 installedVersion 与被验证的版本是同一个值。
type Verifier interface {
	// ProbeInstalledVersion 返回当前会被启动的版本号；空串表示探测不到。
	ProbeInstalledVersion(ctx context.Context, provider string) (string, error)
	// Verify 验证指定版本的可用性。
	Verify(ctx context.Context, provider string, version string) (Verification, error)
}

// Dependencies 汇总解除熔断的依赖。
type Dependencies struct {
	Authorizer Authorizer
	AIHomeDir  string
	// Catalog 判定 provider 是否是升级候选（声明了 CLI 包），与只读接口同一真值源。
	Catalog *providers.Catalog
	// Scheduler 可选：注入后与后台周期升级串行互斥，并默认提供真实 CLI 验证器与含调度态的 status 快照。
	Scheduler *providercliupgrade.Scheduler
	// Verifier 可选：nil 且 Scheduler 也为 nil 时跳过验证（响应 verified=false），直接清除熔断。
	Verifier Verifier
	// Status 可选：返回与只读接口一致的账本视图，原样嵌入响应的 status 字段。
	// nil 时若注入了 Scheduler 则自动返回其含实时调度态的快照，否则 status 为 null。
	Status func(ctx context.Context) (any, error)
	// Now 是测试时钟；nil 时使用 time.Now。
	Now func() time.Time
}

// Handler 处理熔断的人工清除。
type Handler struct {
	authorizer Authorizer
	aiHomeDir  string
	catalog    *providers.Catalog
	scheduler  *providercliupgrade.Scheduler
	verifier   Verifier
	status     func(context.Context) (any, error)
	now        func() time.Time
}

type schedulerVerifierAdapter struct {
	inner providercliupgrade.ClearBrokenVerifier
}

func (a schedulerVerifierAdapter) ProbeInstalledVersion(ctx context.Context, provider string) (string, error) {
	return a.inner.ProbeInstalledVersion(ctx, provider)
}

func (a schedulerVerifierAdapter) Verify(ctx context.Context, provider string, version string) (Verification, error) {
	res, err := a.inner.Verify(ctx, provider, version)
	if err != nil {
		return Verification{}, err
	}
	return Verification{
		Verdict: Verdict(res.Verdict),
		Detail:  res.Detail,
	}, nil
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || strings.TrimSpace(dependencies.AIHomeDir) == "" || dependencies.Catalog == nil {
		return nil, ErrInvalidDependencies
	}
	now := dependencies.Now
	if now == nil {
		now = time.Now
	}
	verifier := dependencies.Verifier
	if verifier == nil && dependencies.Scheduler != nil {
		if sv := dependencies.Scheduler.Verifier(); sv != nil {
			verifier = schedulerVerifierAdapter{inner: sv}
		}
	}
	status := dependencies.Status
	if status == nil && dependencies.Scheduler != nil {
		sched := dependencies.Scheduler
		status = func(context.Context) (any, error) {
			return sched.StatusSnapshot(), nil
		}
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		aiHomeDir:  strings.TrimSpace(dependencies.AIHomeDir),
		catalog:    dependencies.Catalog,
		scheduler:  dependencies.Scheduler,
		verifier:   verifier,
		status:     status,
		now:        now,
	}, nil
}

// clearBrokenView 是解除熔断的响应体：字段与 Node 的 handleClearBrokenRoute 对齐，
// 另加 verified 标注本次是否真的跑过验证。
type clearBrokenView struct {
	OK       bool   `json:"ok"`
	Reason   string `json:"reason"`
	Detail   string `json:"detail"`
	Version  string `json:"version"`
	Verified bool   `json:"verified"`
	Status   any    `json:"status"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 只接受 POST。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.catalog == nil {
		writeError(response, http.StatusServiceUnavailable, "provider_cli_clear_broken_unavailable", "解除熔断服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 POST")
		return
	}

	provider := strings.ToLower(strings.TrimSpace(request.PathValue("provider")))
	if !providerPattern.MatchString(provider) {
		writeError(response, http.StatusBadRequest, "invalid_provider", "")
		return
	}
	if !handler.isUpgradeCandidate(provider) {
		writeError(response, http.StatusBadRequest, ReasonUnknownProvider, "")
		return
	}

	ctx := request.Context()
	execClear := func() {
		handler.executeClearBroken(ctx, response, provider)
	}
	if handler.scheduler != nil {
		if err := handler.scheduler.TryRunExclusive(func() error {
			execClear()
			return nil
		}); err != nil {
			if errors.Is(err, providercliupgrade.ErrAlreadyRunning) {
				handler.respond(ctx, response, http.StatusConflict, clearBrokenView{Reason: ReasonAlreadyRunning})
				return
			}
			handler.respond(ctx, response, http.StatusInternalServerError, clearBrokenView{Reason: ReasonLedgerWriteFailed, Detail: err.Error()})
			return
		}
		return
	}
	execClear()
}

func (handler *Handler) executeClearBroken(ctx context.Context, response http.ResponseWriter, provider string) {
	current := readLedger(handler.aiHomeDir)
	record := current.record(provider)
	// 熔断在账本里落三处（state=broken、enabled=false、拉黑失败版本），只看 state 会
	// 漏掉「状态已改回但 enabled 仍为 false」的半解除账本——自动升级照样停着。
	if !isBroken(record) {
		handler.respond(ctx, response, http.StatusConflict, clearBrokenView{Reason: ReasonNotBroken})
		return
	}

	// 没有验证器就跳过验证：账本里的 installedVersion 是唯一已知的版本事实。
	version := text(record["installedVersion"])
	detail := ""
	verified := false
	if handler.verifier != nil {
		probed, err := handler.verifier.ProbeInstalledVersion(ctx, provider)
		if err != nil {
			handler.respond(ctx, response, http.StatusUnprocessableEntity, clearBrokenView{
				Reason: ReasonInstalledVersionUnknown, Detail: err.Error(),
			})
			return
		}
		version = strings.TrimSpace(probed)
		if version == "" {
			handler.respond(ctx, response, http.StatusUnprocessableEntity, clearBrokenView{
				Reason: ReasonInstalledVersionUnknown,
			})
			return
		}
		verification, err := handler.verifier.Verify(ctx, provider, version)
		if err != nil {
			handler.respond(ctx, response, http.StatusUnprocessableEntity, clearBrokenView{
				Reason: ReasonVerifyInconclusive, Detail: err.Error(), Version: version,
			})
			return
		}
		if verification.Verdict != VerdictPass {
			reason := ReasonVerifyInconclusive
			if verification.Verdict == VerdictFail {
				reason = ReasonVerifyFailed
			}
			handler.respond(ctx, response, http.StatusUnprocessableEntity, clearBrokenView{
				Reason: reason, Detail: verification.Detail, Version: version,
			})
			return
		}
		detail = verification.Detail
		verified = true
	}

	next := current.clearBroken(provider, clearPatch{
		version:  version,
		detail:   detail,
		verified: verified,
		at:       handler.now(),
	})
	if err := writeLedger(handler.aiHomeDir, next); err != nil {
		// 落盘失败必须如实报错：返回 ok=true 会让界面显示已解除，而账本里仍是熔断。
		handler.respond(ctx, response, http.StatusInternalServerError, clearBrokenView{
			Reason: ReasonLedgerWriteFailed, Detail: err.Error(), Version: version, Verified: verified,
		})
		return
	}
	handler.respond(ctx, response, http.StatusOK, clearBrokenView{
		OK: true, Reason: ReasonCleared, Detail: detail, Version: version, Verified: verified,
	})
}

// respond 统一补上 status 后写响应：业务结果也带 status，前端据此刷新面板。
func (handler *Handler) respond(
	ctx context.Context,
	response http.ResponseWriter,
	status int,
	view clearBrokenView,
) {
	view.Status = handler.statusView(ctx)
	writeJSON(response, status, view)
}

// statusView 读调用方注入的账本视图；读不出来按缺席处理，不盖掉写操作本身的结果。
func (handler *Handler) statusView(ctx context.Context) any {
	if handler.status == nil {
		return nil
	}
	view, err := handler.status(ctx)
	if err != nil {
		return nil
	}
	return view
}

// isUpgradeCandidate 与只读接口枚举候选 provider 的口径一致：声明了 CLI 包。
func (handler *Handler) isUpgradeCandidate(provider string) bool {
	definition, ok := handler.catalog.Get(provider)
	if !ok {
		return false
	}
	return definition.CLI != nil && strings.TrimSpace(definition.CLI.Package) != ""
}
