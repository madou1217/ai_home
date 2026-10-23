// Package codexwebsocket 为 Codex Responses WebSocket 选择精确路由和账号。
//
// 该应用层不处理 HTTP Upgrade、WebSocket 帧或网络连接，只组合原子路由目录
// 与统一账号 Recruiter。
package codexwebsocket

import (
	"context"
	"errors"
	"strings"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
)

var (
	// ErrInvalidDependencies 表示选择器缺少路由、征召或传输端口。
	ErrInvalidDependencies = errors.New("Codex WebSocket 选择器依赖无效")
	// ErrInvalidRequest 表示客户端协议或模型不满足原生传输合同。
	ErrInvalidRequest = errors.New("Codex WebSocket 选择请求无效")
	// ErrInvalidPinnedAccount 表示客户端携带的钉选账号引用格式无效。
	ErrInvalidPinnedAccount = errors.New("Codex WebSocket 钉选账号引用无效")
	// ErrModelRewriteRequired 表示别名必须改写模型，不能继续原始帧透传。
	ErrModelRewriteRequired = errors.New("Codex WebSocket 原生传输要求精确模型")
	// ErrInvalidSelection 表示路由、账号或凭据的 Provider 身份不一致。
	ErrInvalidSelection = errors.New("Codex WebSocket 账号选择结果无效")
)

// AccountRecruiter 是选择器执行一次公平账号征召所需的窄端口。
type AccountRecruiter interface {
	Recruit(
		ctx context.Context,
		request accountrouting.Request,
		transport accountrouting.CredentialTransportPolicy,
	) (accountrouting.Result, error)
}

// Dependencies 声明原生 Responses WS 选择所需的稳定端口。
type Dependencies struct {
	Catalog    *providers.Catalog
	Routes     inferencegateway.ProtocolRouteResolver
	Recruiter  AccountRecruiter
	Transports accountrouting.CredentialTransportPolicy
	// Eligibility 判定钉选账号对目标模型是否仍然可用；为空时钉选不做回落，
	// 保持旧行为（仅用于不关心钉选语义的测试装配）。
	Eligibility accountrouting.RuntimeEligibilitySource
}

// Request 包含决定路由和账号亲和所需的客户端协议、模型和可选钉选账号。
type Request struct {
	ClientProtocol   inference.ClientProtocolID
	Model            string
	PinnedAccountRef string
}

// Selection 保存一个连接固定使用的路由、账号和临时凭据。
//
// 凭据只在当前调用链内存中流转，不得记录、序列化或持久化。
type Selection struct {
	route       inferencegateway.Route
	accountRef  accountcore.AccountRef
	credential  accountapp.Credential
	observation accountcredentials.CredentialObservation
}

// NewSelection 创建经过 Provider、协议、账号和凭据复核的连接级选择。
func NewSelection(
	route inferencegateway.Route,
	accountRef accountcore.AccountRef,
	credential accountapp.Credential,
	observation accountcredentials.CredentialObservation,
) (Selection, error) {
	selection := Selection{
		route:       route,
		accountRef:  accountRef,
		credential:  credential,
		observation: observation,
	}
	if !selection.IsValid() {
		return Selection{}, ErrInvalidSelection
	}
	return selection, nil
}

// Route 返回别名解析后的精确 Codex Responses 路由。
func (selection Selection) Route() inferencegateway.Route {
	return selection.route
}

// AccountRef 返回当前连接唯一绑定的稳定账号身份。
func (selection Selection) AccountRef() accountcore.AccountRef {
	return selection.accountRef
}

// Credential 返回当前连接建连所需的临时领域凭据。
func (selection Selection) Credential() accountapp.Credential {
	return selection.credential
}

// CredentialObservation 返回连接建连时读取凭据的低敏持久化观察。
func (selection Selection) CredentialObservation() accountcredentials.CredentialObservation {
	return selection.observation
}

// IsValid 复核路由、账号和凭据仍属于同一个 Codex 域。
func (selection Selection) IsValid() bool {
	return selection.route.IsValid() &&
		selection.route.ProviderID() == inference.ProviderCodex &&
		selection.route.ProtocolID() == inference.ProtocolCodexResponses &&
		selection.accountRef.IsValid() &&
		selection.credential != nil &&
		selection.credential.ProviderID() == codexauth.ProviderID &&
		selection.observation.IsValid() &&
		selection.observation.AccountRef() == selection.accountRef &&
		selection.observation.ProviderID() == codexauth.ProviderID
}

// Selector 使用同一生产路由快照和 Recruiter 生成连接级固定选择。
type Selector struct {
	catalog     *providers.Catalog
	routes      inferencegateway.ProtocolRouteResolver
	recruiter   AccountRecruiter
	transports  accountrouting.CredentialTransportPolicy
	eligibility accountrouting.RuntimeEligibilitySource
}

// NewSelector 创建不缓存模型、账号或凭据的选择器。
func NewSelector(dependencies Dependencies) (*Selector, error) {
	if dependencies.Catalog == nil ||
		dependencies.Routes == nil ||
		dependencies.Recruiter == nil ||
		dependencies.Transports == nil {
		return nil, ErrInvalidDependencies
	}
	return &Selector{
		catalog:     dependencies.Catalog,
		routes:      dependencies.Routes,
		recruiter:   dependencies.Recruiter,
		transports:  dependencies.Transports,
		eligibility: dependencies.Eligibility,
	}, nil
}

// Select 先解析精确 Codex Responses 路由，再公平征召一个当前可用账号。
func (selector *Selector) Select(
	ctx context.Context,
	request Request,
) (Selection, error) {
	if selector == nil ||
		selector.catalog == nil ||
		selector.routes == nil ||
		selector.recruiter == nil ||
		selector.transports == nil ||
		ctx == nil ||
		request.ClientProtocol != inference.ClientProtocolOpenAIResponses ||
		request.Model == "" {
		return Selection{}, ErrInvalidRequest
	}
	if err := ctx.Err(); err != nil {
		return Selection{}, err
	}
	route, err := selector.routes.ResolveProtocolRoute(
		ctx,
		request.ClientProtocol,
		request.Model,
		inference.ProviderCodex,
		inference.ProtocolCodexResponses,
	)
	if err != nil {
		return Selection{}, err
	}
	// 原生 WS 的核心合同是除观察字段外不重写客户端帧。若别名解析改变模型，
	// 应让调用方走 Canonical HTTP 路径，而不是悄悄修改原始 JSON。
	if route.EffectiveModel() != request.Model {
		return Selection{}, ErrModelRewriteRequired
	}
	var recruitment accountrouting.Request
	pinnedAccountRef := strings.TrimSpace(request.PinnedAccountRef)
	if pinnedAccountRef != "" {
		accountRef, parseErr := accountcore.ParseAccountRef(pinnedAccountRef)
		if parseErr != nil {
			return Selection{}, errors.Join(ErrInvalidPinnedAccount, parseErr)
		}
		// 钉选是亲和偏好而不是独占：钉住的账号若对目标模型已进入 (账号,模型) 冷却，
		// 就不能再把它当成唯一候选。
		//
		// 不回落会怎样（实测��）：WebUI 会话把账号钉在请求头里，该账号容量不足被记入
		// (账号,模型) 冷却后，钉选请求的候选池只剩这一个 —— 扫描落空触发软冷却逃生阀
		// 重放同一个候选，冷却账号被**强制再次选中**，每次重连都回到同一个已耗尽的
		// 账号，会话里反复出现 "Selected model is at capacity. Please try a different
		// model."。回落语义与 Node 的 resolvePinnedCodexPool 一致（见
		// lib/server/codex-adapter.js）。
		//
		// 只有软冷却才回落：凭据/额度/策略是硬阻塞，钉选账号在这种情况下本来就不会被
		// 选中，回落到整池会让客户端拿到与钉选无关的账号��。
		pinUsable, usableErr := selector.pinnedAccountUsable(
			ctx,
			accountRef,
			route.EffectiveModel(),
		)
		if usableErr != nil {
			return Selection{}, usableErr
		}
		if pinUsable {
			recruitment, err = accountrouting.NewPinnedRequest(
				selector.catalog,
				codexauth.ProviderID,
				route.EffectiveModel(),
				accountRef,
			)
		} else {
			recruitment, err = accountrouting.NewRequest(
				selector.catalog,
				codexauth.ProviderID,
				route.EffectiveModel(),
			)
		}
	} else {
		recruitment, err = accountrouting.NewRequest(
			selector.catalog,
			codexauth.ProviderID,
			route.EffectiveModel(),
		)
	}
	if err != nil {
		return Selection{}, errors.Join(ErrInvalidRequest, err)
	}
	result, err := selector.recruiter.Recruit(
		ctx,
		recruitment,
		selector.transports,
	)
	if err != nil {
		return Selection{}, err
	}
	return NewSelection(
		route,
		result.Account().Ref(),
		result.Credential(),
		result.CredentialObservation(),
	)
}

// pinnedAccountUsable 判定钉选账号对目标模型是否还能继续服务。
//
// 只有明确的「(账号,模型) 软冷却」才算不可用并触发回落：软冷却会随时间自动恢复，
// 钉选在这段时间里必须让位给池里其它账号。凭据失效、额度耗尽、策略阻塞这些硬阻塞
// 返回可用（true），让钉选请求照旧只作用于目标账号 —— 客户端钉的是一个具体账号，
// 这种情况下的失败是账号自身状态，不该被静默替换成别的账号来服务。
//
// 未装配 Eligibility 端口时返回可用，保持钉选「只用目标账号」的原有语义。
func (selector *Selector) pinnedAccountUsable(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	modelID string,
) (bool, error) {
	if selector.eligibility == nil {
		return true, nil
	}
	route, err := runtimecore.NewModelRoute(accountRef, modelID)
	if err != nil {
		return false, errors.Join(ErrInvalidPinnedAccount, err)
	}
	eligibility, err := selector.eligibility.CheckEligibility(ctx, route)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return false, ctxErr
		}
		return false, errors.Join(ErrInvalidRequest, err)
	}
	if !eligibility.IsValid() {
		return false, ErrInvalidSelection
	}
	return eligibility.Status() != runtimecore.EligibilityModelCooldown, nil
}
