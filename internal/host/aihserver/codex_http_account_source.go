package aihserver

import (
	"context"
	"errors"

	"github.com/madou1217/ai_home/application/accountrouting"
	"github.com/madou1217/ai_home/application/inferencegateway"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/transport/http/codexresponseshttp"
)

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
