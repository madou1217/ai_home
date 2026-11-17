package aihserver

import (
	"context"
	"io"

	"github.com/madou1217/ai_home/internal/host/distribution"
	"github.com/madou1217/ai_home/internal/runtime/distributionupdate"
	"github.com/madou1217/ai_home/internal/transport/http/webuidistributionapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuipublicalias"
)

func buildDistributionUpdate(ctx context.Context, deps webuiRouteDependencies) ([]webuiRoute, io.Closer, error) {
	svc, err := distribution.New(deps.AIHomeDir, "")
	if err != nil {
		return nil, nil, err
	}
	handler := webuidistributionapi.Handler{Authorizer: deps.Authorizer, Service: svc}
	routes := []webuiRoute{}
	for _, verb := range []struct{ method, suffix string }{{"GET", ""}, {"POST", "/check"}, {"POST", "/schedule"}, {"POST", "/cancel"}} {
		routes = append(routes, webuiRoute{Pattern: verb.method + " " + webuidistributionapi.Path + verb.suffix, Handler: handler, SkipPublicAlias: true}, webuiRoute{Pattern: verb.method + " /v0/webui/distribution-update" + verb.suffix, Handler: webuipublicalias.Rewrite("/v0/webui/distribution-update", webuidistributionapi.Path, handler), SkipPublicAlias: true})
	}
	go distribution.Run(ctx, svc)
	return routes, distributionUpdateCloser{svc: svc}, nil
}

type distributionUpdateCloser struct{ svc *distributionupdate.Service }

func (c distributionUpdateCloser) Close() error { return c.svc.Close() }
