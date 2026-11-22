package aihserver

import (
	"fmt"
	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	inferencegateway "github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/application/upstreamretry"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/claude/transportpolicy"
	"github.com/madou1217/ai_home/internal/adapters/clientversion"
	"github.com/madou1217/ai_home/internal/adapters/upstreamfailure/configured"
	"github.com/madou1217/ai_home/internal/transport/http/claudenativerelay"
	"log"
	"net/http"
	"time"
)

// claudeNativeRelayInputs 是 Claude Native Relay 的稳定依赖。
type claudeNativeRelayInputs struct {
	catalog          *providers.Catalog
	recruiter        *accountrouting.Recruiter
	claudePolicy     *transportpolicy.GatewayPolicy
	authorizer       claudenativerelay.Authorizer
	credentials      *accountcredentials.Resolver
	client           claudenativerelay.HTTPClient
	egress           claudenativerelay.AccountEgress
	attempts         inferencegateway.AttemptRecorder
	modelRefreshes   inferencegateway.ModelRefreshScheduler
	upstream429      *upstreamretry.Controller
	rules            configured.Rules
	errorLog         *log.Logger
	fallback         http.Handler
	messagesUpstream transportpolicy.MessagesUpstream
	clientVersions   *clientversion.Resolver
}

func newClaudeNativeRelay(inputs claudeNativeRelayInputs) (*claudenativerelay.Handler, error) {
	relayAccounts, err := newRelayAccountSource(
		inputs.catalog,
		inputs.recruiter,
		inputs.claudePolicy,
	)
	if err != nil {
		return nil, fmt.Errorf(
			"创建 Claude Relay 账号来源失败: %w",
			err,
		)
	}
	nativeRelayHandler, err := claudenativerelay.NewHandler(
		claudenativerelay.Dependencies{
			Authorizer:         inputs.authorizer,
			Accounts:           relayAccounts,
			Fallback:           inputs.fallback,
			Credentials:        inputs.credentials,
			Client:             inputs.client,
			AccountEgress:      inputs.egress,
			Attempts:           inputs.attempts,
			ModelRefreshes:     inputs.modelRefreshes,
			Upstream429Retries: inputs.upstream429,
			Clock:              time.Now,
			Rules:              inputs.rules,
			StreamDisconnects:  newRelayDisconnectObserver(inputs.errorLog),
			Upstream:           inputs.messagesUpstream,
			ClientVersions:     inputs.clientVersions,
		},
	)
	if err != nil {
		return nil, fmt.Errorf(
			"创建 Claude Native Relay Handler 失败: %w",
			err,
		)
	}
	return nativeRelayHandler, nil
}
