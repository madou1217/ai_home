package aihserver

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/effortalign"
	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/application/upstreamretry"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	agycodeassist "github.com/madou1217/ai_home/internal/adapters/agy/codeassist"
	"github.com/madou1217/ai_home/internal/adapters/clientversion"
	"github.com/madou1217/ai_home/internal/adapters/upstreamfailure/configured"
	"github.com/madou1217/ai_home/internal/host/inferencehttp"
	"github.com/madou1217/ai_home/internal/host/inferenceruntime"
	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
)

// inferenceRuntimeInputs 是生产推理组合的稳定依赖。
//
// 字段与 inferenceCompositionDependencies 同名同义；这里只多带 errorLog 与
// egressManager，用于派生诊断观察器和账号出口解析器。
type inferenceRuntimeInputs struct {
	ctx                       context.Context
	catalog                   *providers.Catalog
	store                     *sqliteaccount.Store
	runtime                   inferenceruntime.AccountRuntime
	weights                   accountrouting.AccountWeightSource
	usageGate                 accountrouting.UsageGate
	strategy                  accountrouting.SelectionStrategy
	models                    accountapp.AccountModelRefresher
	modelRefreshes            inferencegateway.ModelRefreshScheduler
	credentials               inferenceruntime.CredentialResolver
	delegateCredentialRefresh bool
	ownsCredentialRefresh     func(accountcore.AccountRef) bool
	authorizer                inferencehttp.Authorizer
	httpClient                InferenceHTTPClient
	decodeErrors              func(error)
	upstreamDecodeErrors      func(error)
	errorLog                  *log.Logger
	requestRewriter           inferencegateway.RequestRewriter
	effortLadders             effortalign.LadderReader
	codexVersions             clientversion.Source
	claudeVersions            clientversion.Source
	agyModelWires             agycodeassist.ModelWireReader
	upstreamRules             configured.Rules
	upstream429Retries        *upstreamretry.Controller
	egressManager             func() *runtimeegress.Manager
}

// newInferenceRuntime 装配生产推理组合。
//
// 从 newHandlers 拆出：推理依赖的字段来源固定，派生部分（响应解码观察器、
// Codex 拒绝观察器、账号出口与账号提示解析器）集中在这里，主流水线只保留
// 调用与失败清理。
func newInferenceRuntime(inputs inferenceRuntimeInputs) (*inferenceComposition, error) {
	inference, err := newInferenceComposition(
		inputs.ctx,
		inferenceCompositionDependencies{
			catalog:                   inputs.catalog,
			store:                     inputs.store,
			runtime:                   inputs.runtime,
			weights:                   inputs.weights,
			usageGate:                 inputs.usageGate,
			strategy:                  inputs.strategy,
			models:                    inputs.models,
			modelRefreshes:            inputs.modelRefreshes,
			credentials:               inputs.credentials,
			delegateCredentialRefresh: inputs.delegateCredentialRefresh,
			ownsCredentialRefresh:     inputs.ownsCredentialRefresh,
			authorizer:                inputs.authorizer,
			httpClient:                inputs.httpClient,
			decodeErrors:              inputs.decodeErrors,
			responsesDecodeErrors:     newResponsesDecodeErrorObserver(inputs.errorLog),
			upstreamDecodeErrors:      inputs.upstreamDecodeErrors,
			clock:                     time.Now,
			requestRewriter:           inputs.requestRewriter,
			effortLadders:             inputs.effortLadders,
			codexVersions:             inputs.codexVersions,
			claudeVersions:            inputs.claudeVersions,
			codexRejections:           newCodexRejectionObserver(inputs.errorLog),
			agyModelWires:             inputs.agyModelWires,
			upstreamRules:             inputs.upstreamRules,
			upstream429Retries:        inputs.upstream429Retries,
			componentLog:              inputs.errorLog,
			accountEgress:             inferenceEgressResolver{manager: inputs.egressManager},
			accountHints:              inferenceAccountHintResolver{store: inputs.store},
		},
	)
	if err != nil {
		return nil, fmt.Errorf("创建生产推理组合失败: %w", err)
	}
	return inference, nil
}
