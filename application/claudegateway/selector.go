// Package claudegateway 负责为 Claude CLI 的单次原生请求选择账号和传输方式。
//
// 该应用层复用统一账号 Recruiter，不解析 HTTP，也不读取数据库或长期凭据。
package claudegateway

import (
	"context"
	"errors"

	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/clauderelay"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/providers"
)

// Transport 是 Server 已确认的互斥 Claude 上游传输方式。
type Transport string

const (
	// TransportCanonical 表示凭据可以由 Go Canonical Messages Adapter 承载。
	TransportCanonical Transport = "canonical"
	// TransportNativeOAuth 表示必须保留 Claude Code 的原生 OAuth 请求证明。
	TransportNativeOAuth Transport = "native_oauth"
)

var (
	// ErrInvalidDependencies 表示选择器缺少 Catalog、Recruiter、策略或租约端口。
	ErrInvalidDependencies = errors.New("Claude Gateway 选择器依赖无效")
	// ErrInvalidRequest 表示模型或可选固定账号不满足征召合同。
	ErrInvalidRequest = errors.New("Claude Gateway 选择请求无效")
	// ErrInvalidTransport 表示策略返回的传输与凭据或租约不一致。
	ErrInvalidTransport = errors.New("Claude Gateway 传输决策无效")
)

// AccountRecruiter 是选择器所需的单次账号征召端口。
type AccountRecruiter interface {
	Recruit(
		ctx context.Context,
		request accountrouting.Request,
		transport accountrouting.CredentialTransportPolicy,
	) (accountrouting.Result, error)
}

// TransportPolicy 同时声明可征召凭据集合和选中后的唯一传输方式。
type TransportPolicy interface {
	accountrouting.CredentialTransportPolicy
	TransportFor(credential accountapp.Credential) (Transport, error)
}

// LeaseIssuer 只为必须走 Native OAuth 的账号签发短期不透明租约。
type LeaseIssuer interface {
	Issue(
		accountRef accountcore.AccountRef,
		modelID runtimecore.ModelID,
	) (clauderelay.Lease, error)
}

// Dependencies 声明请求级选择所需的四个稳定端口。
type Dependencies struct {
	Catalog    *providers.Catalog
	Recruiter  AccountRecruiter
	Transports TransportPolicy
	Leases     LeaseIssuer
}

// Request 只包含正文中的真实模型和可选固定账号。
type Request struct {
	ModelID          string
	AccountRef       accountcore.AccountRef
	ExcludedAccounts []accountcore.AccountRef
}

// Decision 是不包含长期凭据的请求级稳定选择结果。
type Decision struct {
	transport  Transport
	accountRef accountcore.AccountRef
	lease      clauderelay.Lease
}

// NewDecision 创建经过互斥关系校验的传输值对象。
func NewDecision(
	transport Transport,
	accountRef accountcore.AccountRef,
	lease clauderelay.Lease,
) (Decision, error) {
	decision := Decision{
		transport:  transport,
		accountRef: accountRef,
		lease:      lease,
	}
	if !decision.IsValid() {
		return Decision{}, ErrInvalidTransport
	}
	return decision, nil
}

// Transport 返回 Server 已确认的互斥传输方式。
func (decision Decision) Transport() Transport {
	return decision.transport
}

// AccountRef 返回本次请求唯一绑定的稳定账号身份。
func (decision Decision) AccountRef() accountcore.AccountRef {
	return decision.accountRef
}

// Lease 只在 Native OAuth 传输时返回有效租约。
func (decision Decision) Lease() (clauderelay.Lease, bool) {
	return decision.lease, decision.lease.IsValid()
}

// IsValid 复核传输、账号和可选租约之间的互斥关系。
func (decision Decision) IsValid() bool {
	if !decision.accountRef.IsValid() {
		return false
	}
	switch decision.transport {
	case TransportCanonical:
		return !decision.lease.IsValid()
	case TransportNativeOAuth:
		return decision.lease.IsValid() &&
			decision.lease.AccountRef() == decision.accountRef
	default:
		return false
	}
}

// Selector 使用统一 Recruiter 生成请求级传输决策。
type Selector struct {
	catalog    *providers.Catalog
	recruiter  AccountRecruiter
	transports TransportPolicy
	leases     LeaseIssuer
}

// NewSelector 创建不缓存账号、凭据或模型的选择器。
func NewSelector(dependencies Dependencies) (*Selector, error) {
	if dependencies.Catalog == nil ||
		dependencies.Recruiter == nil ||
		dependencies.Transports == nil ||
		dependencies.Leases == nil {
		return nil, ErrInvalidDependencies
	}
	return &Selector{
		catalog:    dependencies.Catalog,
		recruiter:  dependencies.Recruiter,
		transports: dependencies.Transports,
		leases:     dependencies.Leases,
	}, nil
}

// Select 先按 Provider、模型和运行态公平征召，再决定 Canonical 或 Native。
func (selector *Selector) Select(
	ctx context.Context,
	request Request,
) (Decision, error) {
	if selector == nil || selector.catalog == nil ||
		selector.recruiter == nil || selector.transports == nil ||
		selector.leases == nil || ctx == nil ||
		(request.AccountRef != "" && !request.AccountRef.IsValid()) ||
		(request.AccountRef.IsValid() && len(request.ExcludedAccounts) > 0) {
		return Decision{}, ErrInvalidRequest
	}
	if err := ctx.Err(); err != nil {
		return Decision{}, err
	}
	recruitment, err := selector.newRecruitmentRequest(request)
	if err != nil {
		return Decision{}, err
	}
	result, err := selector.recruiter.Recruit(
		ctx,
		recruitment,
		selector.transports,
	)
	if err != nil {
		return Decision{}, err
	}
	transport, err := selector.transports.TransportFor(result.Credential())
	if err != nil {
		return Decision{}, errors.Join(ErrInvalidTransport, err)
	}
	accountRef := result.Account().Ref()
	var lease clauderelay.Lease
	if transport == TransportNativeOAuth {
		lease, err = selector.leases.Issue(
			accountRef,
			recruitment.ModelID(),
		)
		if err != nil {
			return Decision{}, err
		}
		if lease.ModelID() != recruitment.ModelID() {
			return Decision{}, ErrInvalidTransport
		}
	}
	return NewDecision(transport, accountRef, lease)
}

// newRecruitmentRequest 统一普通账号池和固定账号的 Claude 征召合同。
func (selector *Selector) newRecruitmentRequest(
	request Request,
) (accountrouting.Request, error) {
	if request.AccountRef.IsValid() {
		return accountrouting.NewPinnedRequest(
			selector.catalog,
			claudeauth.ProviderID,
			request.ModelID,
			request.AccountRef,
		)
	}
	return accountrouting.NewRequestExcluding(
		selector.catalog,
		claudeauth.ProviderID,
		request.ModelID,
		request.ExcludedAccounts,
	)
}
