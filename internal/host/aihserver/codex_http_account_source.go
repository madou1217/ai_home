package aihserver

import (
	"context"
	"errors"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/transport/http/codexresponseshttp"
)

var _ codexresponseshttp.RateLimitReacquirer = codexHTTPAccountSource{}

type codexHTTPAccountSource struct {
	catalog   *providers.Catalog
	routes    inferencegateway.ProtocolRouteResolver
	recruiter *accountrouting.Recruiter
	transport accountrouting.CredentialTransportPolicy
}

func (source codexHTTPAccountSource) Open(ctx context.Context, model string) (codexresponseshttp.Cursor, error) {
	route, err := source.routes.ResolveProtocolRoute(ctx, inference.ClientProtocolOpenAIResponses, model, inference.ProviderCodex, inference.ProtocolCodexResponses)
	if err != nil || route.EffectiveModel() != model {
		return nil, codexresponseshttp.ErrNotNativeRoute
	}
	request, err := accountrouting.NewRequest(source.catalog, "codex", model)
	if ref, pinned := inferencegateway.PinnedAccount(ctx); pinned {
		request, err = accountrouting.NewPinnedRequest(source.catalog, "codex", model, ref)
	}
	if err != nil {
		return nil, err
	}
	session, err := source.recruiter.Begin(ctx, request, source.transport)
	if err != nil {
		return nil, err
	}
	pinned, _ := inferencegateway.PinnedAccount(ctx)
	return &codexHTTPCursor{session: session, source: source, model: model, pinned: pinned}, nil
}

type codexHTTPCursor struct {
	session *accountrouting.RecruitmentSession
	source  codexHTTPAccountSource
	model   string
	pinned  accountcore.AccountRef
}

func (cursor *codexHTTPCursor) Next(ctx context.Context) (codexresponseshttp.Selection, bool, error) {
	result, err := cursor.session.Next(ctx)
	if errors.Is(err, accountrouting.ErrNoRoutableAccount) && cursor.pinned.IsValid() {
		request, requestErr := accountrouting.NewRequestExcluding(cursor.source.catalog, "codex", cursor.model, []accountcore.AccountRef{cursor.pinned})
		cursor.pinned = ""
		if requestErr != nil {
			return codexresponseshttp.Selection{}, false, requestErr
		}
		cursor.session, err = cursor.source.recruiter.Begin(ctx, request, cursor.source.transport)
		if err != nil {
			return codexresponseshttp.Selection{}, false, err
		}
		result, err = cursor.session.Next(ctx)
	}
	if errors.Is(err, accountrouting.ErrNoRoutableAccount) {
		return codexresponseshttp.Selection{}, false, nil
	}
	if err != nil {
		return codexresponseshttp.Selection{}, false, err
	}
	return codexresponseshttp.Selection{AccountRef: result.Account().Ref(), Credential: result.Credential(), Observation: result.CredentialObservation()}, true, nil
}

// OpenPinnedOnly opens a Phase 0 cursor strictly for the pinned Codex account
// without silently falling back to the rest of the pool before 429 retries.
func (source codexHTTPAccountSource) OpenPinnedOnly(
	ctx context.Context,
	model string,
	accountRef accountcore.AccountRef,
) (codexresponseshttp.Cursor, error) {
	route, err := source.routes.ResolveProtocolRoute(ctx, inference.ClientProtocolOpenAIResponses, model, inference.ProviderCodex, inference.ProtocolCodexResponses)
	if err != nil || route.EffectiveModel() != model {
		return nil, codexresponseshttp.ErrNotNativeRoute
	}
	request, err := accountrouting.NewPinnedRequest(source.catalog, "codex", model, accountRef)
	if err != nil {
		return nil, err
	}
	session, err := source.recruiter.Begin(ctx, request, source.transport)
	if err != nil {
		return nil, err
	}
	return &codexHTTPCursor{session: session, source: source, model: model}, nil
}

// OpenFallbackPool opens the Phase 1 pool cursor excluding the pinned account.
func (source codexHTTPAccountSource) OpenFallbackPool(
	ctx context.Context,
	model string,
	excluded accountcore.AccountRef,
) (codexresponseshttp.Cursor, error) {
	request, err := accountrouting.NewRequestExcluding(source.catalog, "codex", model, []accountcore.AccountRef{excluded})
	if err != nil {
		return nil, err
	}
	session, err := source.recruiter.Begin(ctx, request, source.transport)
	if err != nil {
		return nil, err
	}
	return &codexHTTPCursor{session: session, source: source, model: model}, nil
}

// ReacquireFor429Retry runs fresh candidate loading, usage gate, hard-block and
// atomic CooldownWaiver (receipt + original credential generation) checks, plus
// fresh credential resolution after wait.
func (source codexHTTPAccountSource) ReacquireFor429Retry(
	ctx context.Context,
	model string,
	pinned bool,
	accountRef accountcore.AccountRef,
	cooldownReceipt runtimecore.CooldownReceipt,
	originObservation accountcredentials.CredentialObservation,
) (codexresponseshttp.Selection, bool, bool, error) {
	if !pinned {
		if poolReq, err := accountrouting.NewRequest(source.catalog, "codex", model); err == nil {
			if session, beginErr := source.recruiter.Begin(ctx, poolReq, source.transport); beginErr == nil {
				if result, nextErr := session.Next(ctx); nextErr == nil {
					return codexresponseshttp.Selection{
						AccountRef:  result.Account().Ref(),
						Credential:  result.Credential(),
						Observation: result.CredentialObservation(),
					}, false, true, nil
				} else if !errors.Is(nextErr, accountrouting.ErrNoRoutableAccount) {
					return codexresponseshttp.Selection{}, false, false, nextErr
				}
			}
		}
	}
	pinnedReq, err := accountrouting.NewPinnedRequest(source.catalog, "codex", model, accountRef)
	if err != nil {
		return codexresponseshttp.Selection{}, false, false, err
	}
	waiver := accountrouting.RateLimitCooldownWaiver{
		Receipt:     cooldownReceipt,
		Observation: originObservation,
	}
	if waiver.IsValid() {
		pinnedReq = pinnedReq.WithRateLimitCooldownWaiver(waiver)
	}
	session, err := source.recruiter.Begin(ctx, pinnedReq, source.transport)
	if err != nil {
		return codexresponseshttp.Selection{}, false, false, err
	}
	result, err := session.Next(ctx)
	if errors.Is(err, accountrouting.ErrNoRoutableAccount) {
		return codexresponseshttp.Selection{}, false, false, nil
	}
	if err != nil {
		return codexresponseshttp.Selection{}, false, false, err
	}
	return codexresponseshttp.Selection{
		AccountRef:  result.Account().Ref(),
		Credential:  result.Credential(),
		Observation: result.CredentialObservation(),
	}, result.UsedRateLimitCooldownWaiver(), true, nil
}
