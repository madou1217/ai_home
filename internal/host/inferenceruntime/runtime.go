// Package inferenceruntime 装配 Canonical 推理所需的应用服务。
//
// 该组合根不拥有数据库、HTTP 路由或账号运行态策略；调用方必须注入同一个
// 完整运行态端口，供账号征召读取资格并供 Coordinator 记录终态。
package inferenceruntime

import (
	"errors"
	"fmt"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/core/providers"
)

var (
	// ErrInvalidDependencies 表示 Runtime 缺少必要端口或子组件构造失败。
	ErrInvalidDependencies = errors.New("推理 Runtime 依赖无效")
)

// AccountStore 组合推理热路径所需的候选读取和版本化凭据端口。
//
// 该接口不包含账号管理、Profile、Usage 或模型维护写入，避免组合根依赖胖接口。
type AccountStore interface {
	accountrouting.CandidateSource
	accountapp.CredentialVersionStore
}

// AccountRuntime 是账号征召与推理终态共享的完整运行态边界。
//
// 实现必须处理全部 FailureAction；只保存模型 cooldown、却忽略 credential、
// quota 或 policy 阻塞的实现不满足该端口的语义。
type AccountRuntime interface {
	accountrouting.RuntimeEligibilitySource
	inferencegateway.AttemptRecorder
}

// Dependencies 声明 Canonical Runtime 的最小生产组合边界。
type Dependencies struct {
	// Catalog 校验 Provider，并供账号征召构造规范查询。
	Catalog *providers.Catalog
	// Store 延迟读取模型倒排候选与版本化凭据。
	Store AccountStore
	// Runtime 同时负责征召资格读取和完整失败状态记录。
	Runtime AccountRuntime
	// Routes 负责客户端模型到真实上游路由计划的解析。
	Routes inferencegateway.RouteResolver
	// CredentialStrategies 注册当前 Provider 的凭据刷新策略。
	CredentialStrategies []accountcredentials.RefreshStrategy
	// Upstreams 注册按真实线协议区分的上游 Adapter。
	Upstreams []inferencegateway.UpstreamAdapter
	// ModelRefreshes 接收模型不支持后的异步本地目录修复信号。
	ModelRefreshes inferencegateway.ModelRefreshScheduler
	// Clock 提供 OAuth 过期判断和凭据版本时间。
	Clock accountapp.Clock
	// AccountScanLimit 为零时使用 Coordinator 的安全默认值。
	AccountScanLimit int
}

// New 创建共享同一账号运行态和凭据解析器的 Canonical Executor。
func New(dependencies Dependencies) (*inferencegateway.Coordinator, error) {
	if err := validateDependencies(dependencies); err != nil {
		return nil, err
	}
	credentials, err := accountcredentials.NewResolver(
		accountcredentials.Dependencies{
			Store:      dependencies.Store,
			Strategies: dependencies.CredentialStrategies,
			Clock:      dependencies.Clock,
		},
	)
	if err != nil {
		return nil, wrapDependencyError("创建账号凭据解析器失败", err)
	}
	recruiter, err := accountrouting.NewRecruiter(
		accountrouting.Dependencies{
			Candidates:  dependencies.Store,
			Runtime:     dependencies.Runtime,
			Credentials: credentials,
		},
	)
	if err != nil {
		return nil, wrapDependencyError("创建账号征召器失败", err)
	}
	upstreams, err := inferencegateway.NewUpstreamRegistry(
		dependencies.Upstreams...,
	)
	if err != nil {
		return nil, wrapDependencyError("创建上游协议注册表失败", err)
	}
	coordinator, err := inferencegateway.NewCoordinator(
		inferencegateway.Dependencies{
			Catalog:          dependencies.Catalog,
			Routes:           dependencies.Routes,
			Recruiter:        recruiter,
			Upstreams:        upstreams,
			Attempts:         dependencies.Runtime,
			ModelRefreshes:   dependencies.ModelRefreshes,
			AccountScanLimit: dependencies.AccountScanLimit,
		},
	)
	if err != nil {
		return nil, wrapDependencyError("创建 Canonical Coordinator 失败", err)
	}
	return coordinator, nil
}

// validateDependencies 在创建任何有状态子组件前拒绝不完整组合。
func validateDependencies(dependencies Dependencies) error {
	if dependencies.Catalog == nil ||
		dependencies.Store == nil ||
		dependencies.Runtime == nil ||
		dependencies.Routes == nil ||
		len(dependencies.CredentialStrategies) == 0 ||
		len(dependencies.Upstreams) == 0 ||
		dependencies.ModelRefreshes == nil ||
		dependencies.Clock == nil {
		return ErrInvalidDependencies
	}
	return nil
}

// wrapDependencyError 同时保留组合根错误和具体子组件错误身份。
func wrapDependencyError(message string, err error) error {
	return fmt.Errorf("%w: %s: %w", ErrInvalidDependencies, message, err)
}
