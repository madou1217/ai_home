package aihserver

import (
	"context"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencecatalog"
	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	agycodeassist "github.com/madou1217/ai_home/internal/adapters/agy/codeassist"
	claudemessages "github.com/madou1217/ai_home/internal/adapters/claude/messages"
	codexresponses "github.com/madou1217/ai_home/internal/adapters/codex/responses"
	"github.com/madou1217/ai_home/internal/host/inferencehttp"
	"github.com/madou1217/ai_home/internal/host/inferenceruntime"
)

var errInvalidInferenceComposition = errors.New("生产推理组合依赖无效")

const (
	inferenceHTTPTimeout    = 10 * time.Minute
	modelRefreshTimeout     = 20 * time.Second
	modelRefreshBaseBackoff = time.Second
	modelRefreshMaxBackoff  = time.Minute
	modelRefreshConcurrency = 1
)

// inferenceComposition 保存推理 HTTP、原子模型目录及其内部生命周期。
type inferenceComposition struct {
	handler        http.Handler
	models         *inferencecatalog.AtomicCatalog
	recruiter      *accountrouting.Recruiter
	codexUpstream  *codexresponses.Adapter
	claudeUpstream *claudemessages.Adapter
	agyUpstream    *agycodeassist.Adapter
	modelRefreshes inferencegateway.ModelRefreshScheduler
	closers        []io.Closer
}

// inferenceCompositionDependencies 集中声明生产推理组合所需的窄端口。
type inferenceCompositionDependencies struct {
	catalog              *providers.Catalog
	store                *sqliteaccount.Store
	runtime              inferenceruntime.AccountRuntime
	models               accountapp.AccountModelRefresher
	modelRefreshes       inferencegateway.ModelRefreshScheduler
	credentialRefresh    []accountcredentials.RefreshStrategy
	authorizer           inferencehttp.Authorizer
	httpClient           InferenceHTTPClient
	decodeErrors         func(error)
	upstreamDecodeErrors func(error)
	clock                func() time.Time
}

// newInferenceComposition 装配模型快照、共享刷新调度器、Canonical Runtime 和 HTTP。
func newInferenceComposition(
	ctx context.Context,
	dependencies inferenceCompositionDependencies,
) (_ *inferenceComposition, resultErr error) {
	if !validInferenceDependencies(ctx, dependencies) {
		return nil, errInvalidInferenceComposition
	}
	composition := &inferenceComposition{}
	defer func() {
		if resultErr != nil {
			_ = composition.Close()
		}
	}()

	client := dependencies.httpClient
	if client == nil {
		client = &http.Client{
			Timeout:       inferenceHTTPTimeout,
			CheckRedirect: rejectOAuthRedirect,
		}
	}
	codexAdapter, err := codexresponses.NewAdapter(client, dependencies.clock)
	if err != nil {
		return nil, err
	}
	claudeAdapter, err := claudemessages.NewAdapter(
		client,
		dependencies.clock,
		dependencies.upstreamDecodeErrors,
	)
	if err != nil {
		return nil, err
	}
	agyAdapter, err := agycodeassist.NewAdapter(client, dependencies.clock)
	if err != nil {
		return nil, err
	}
	activeCatalog, err := inferencecatalog.NewAtomicCatalog(dependencies.clock)
	if err != nil {
		return nil, err
	}
	builder, err := inferencecatalog.NewBuilder(
		dependencies.store,
		codexAdapter,
		claudeAdapter,
		agyAdapter,
	)
	if err != nil {
		return nil, err
	}
	catalogRefresh, err := inferencecatalog.NewRefreshCoordinator(
		inferencecatalog.RefreshCoordinatorOptions{
			Builder: builder,
			Catalog: activeCatalog,
		},
	)
	if err != nil {
		return nil, err
	}
	composition.closers = append(composition.closers, catalogRefresh)
	if err := dependencies.store.SetRoutableModelObserver(
		catalogRefresh,
	); err != nil {
		return nil, err
	}
	// 初次失败只关闭推理目录；账号管理仍可通过后续成功写入触发恢复。
	_ = catalogRefresh.Refresh(ctx)
	poolRetries, err := inferencegateway.NewDefaultRequestPoolRetryPolicy()
	if err != nil {
		return nil, err
	}

	runtimeComponents, err := inferenceruntime.NewComponents(inferenceruntime.Dependencies{
		Catalog:              dependencies.catalog,
		Store:                dependencies.store,
		Runtime:              dependencies.runtime,
		Routes:               activeCatalog,
		CredentialStrategies: dependencies.credentialRefresh,
		Upstreams: []inferencegateway.UpstreamAdapter{
			codexAdapter,
			claudeAdapter,
			agyAdapter,
		},
		ModelRefreshes: dependencies.modelRefreshes,
		Clock:          dependencies.clock,
		PoolRetries:    poolRetries,
	})
	if err != nil {
		return nil, err
	}
	handler, err := inferencehttp.New(inferencehttp.Dependencies{
		Executor:                    runtimeComponents.Executor(),
		Authorizer:                  dependencies.authorizer,
		Clock:                       dependencies.clock,
		MessagesDecodeErrorObserver: dependencies.decodeErrors,
	})
	if err != nil {
		return nil, err
	}
	composition.handler = handler
	composition.models = activeCatalog
	composition.recruiter = runtimeComponents.Recruiter()
	composition.codexUpstream = codexAdapter
	composition.claudeUpstream = claudeAdapter
	composition.agyUpstream = agyAdapter
	composition.modelRefreshes = dependencies.modelRefreshes
	return composition, nil
}

// Close 先停止账号模型 worker，再停止目录刷新 worker。
func (composition *inferenceComposition) Close() error {
	if composition == nil {
		return nil
	}
	var closeErrors []error
	for index := len(composition.closers) - 1; index >= 0; index-- {
		if err := composition.closers[index].Close(); err != nil {
			closeErrors = append(closeErrors, err)
		}
	}
	composition.closers = nil
	return errors.Join(closeErrors...)
}

// validInferenceDependencies 在启动任何后台 worker 前拒绝不完整依赖。
func validInferenceDependencies(
	ctx context.Context,
	dependencies inferenceCompositionDependencies,
) bool {
	return ctx != nil &&
		dependencies.catalog != nil &&
		dependencies.store != nil &&
		dependencies.runtime != nil &&
		dependencies.models != nil &&
		dependencies.modelRefreshes != nil &&
		len(dependencies.credentialRefresh) > 0 &&
		dependencies.authorizer != nil &&
		dependencies.clock != nil
}
