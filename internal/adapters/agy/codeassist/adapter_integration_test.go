package codeassist

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
)

func TestRequestIdentitiesRemainUniqueAtTheSameClockInstant(t *testing.T) {
	t.Parallel()

	firstRequest, firstSession, err := newRequestIdentities(fixedClock(), rand.Reader)
	if err != nil {
		t.Fatalf("newRequestIdentities(first) error = %v", err)
	}
	secondRequest, secondSession, err := newRequestIdentities(fixedClock(), rand.Reader)
	if err != nil {
		t.Fatalf("newRequestIdentities(second) error = %v", err)
	}
	if firstRequest == secondRequest || firstSession == secondSession {
		t.Fatalf(
			"identities collided: request=%q/%q session=%q/%q",
			firstRequest,
			secondRequest,
			firstSession,
			secondSession,
		)
	}
}

func TestAdapterExecutesLoadGenerateDecodeThroughCoordinator(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	urls := make([]string, 0, 2)
	client := recordingClient{do: func(request *http.Request) (*http.Response, error) {
		mu.Lock()
		urls = append(urls, request.URL.String())
		mu.Unlock()
		if strings.Contains(request.URL.String(), ":loadCodeAssist") {
			return jsonResponse(http.StatusOK, `{"cloudaicompanionProject":"project-123"}`), nil
		}
		if strings.Contains(request.URL.String(), ":streamGenerateContent?alt=sse") {
			if request.Header.Get("anthropic-beta") != "claude-code-20250219" {
				t.Fatalf("missing Claude Code Assist beta header: %#v", request.Header)
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": {"text/event-stream"}},
				Body: io.NopCloser(strings.NewReader(
					"data: {\"response\":{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"GO_AGY_OK\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":4,\"candidatesTokenCount\":3}}}\n\n",
				)),
			}, nil
		}
		t.Fatalf("unexpected URL %s", request.URL)
		return nil, nil
	}}
	fixture := newAgyCoordinatorFixture(t, client, testAgyAuth(t))
	events := make([]inference.StreamEvent, 0, 8)
	if err := fixture.coordinator.Execute(
		fixture.context,
		fixture.request,
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	); err != nil {
		t.Fatalf("Coordinator.Execute() error = %v", err)
	}
	if len(urls) != 2 || fixture.recorder.successes != 1 ||
		events[len(events)-1].Kind() != inference.EventResponseCompleted {
		t.Fatalf("urls=%v successes=%d events=%v", urls, fixture.recorder.successes, eventKinds(events))
	}
}

// 完整征召仍按公开 ID，只有发送到 Code Assist 的 model 被目录改写。
func TestAdapterUsesDiscoveredWireModelAndPreservesPublicResponseModel(t *testing.T) {
	t.Parallel()

	for _, test := range []struct{ model, wire string }{
		{"gemini-3.1-pro-high", "gemini-pro-agent"},
		{"gemini-pro-agent", "gemini-pro-agent"},
		{"gemini-3.1-pro-low", "gemini-3.1-pro-low"},
	} {
		t.Run(test.model, func(t *testing.T) {
			t.Parallel()
			calls := 0
			client := recordingClient{do: func(request *http.Request) (*http.Response, error) {
				calls++
				switch {
				case strings.Contains(request.URL.String(), ":loadCodeAssist"):
					return jsonResponse(http.StatusOK, `{"cloudaicompanionProject":"project-123"}`), nil
				case strings.Contains(request.URL.String(), ":fetchAvailableModels"):
					return jsonResponse(http.StatusOK, `{
						"models":{"gemini-3.1-pro-high":{},"gemini-pro-agent":{},"gemini-3.1-pro-low":{}},
						"deprecatedModelIds":{"gemini-3.1-pro-high":{"newModelId":"gemini-pro-agent"}}
					}`), nil
				case strings.Contains(request.URL.String(), ":streamGenerateContent"):
					var payload generateEnvelope
					if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
						t.Fatal(err)
					}
					if payload.Model != test.wire {
						t.Fatalf("upstream model = %q, want %q", payload.Model, test.wire)
					}
					return &http.Response{
						StatusCode: http.StatusOK,
						Header:     http.Header{"Content-Type": {"text/event-stream"}},
						Body:       io.NopCloser(strings.NewReader("data: {\"response\":{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"GO_AGY_OK\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":4,\"candidatesTokenCount\":3}}}\n\n")),
					}, nil
				default:
					t.Fatalf("unexpected request %s", request.URL)
					return nil, nil
				}
			}}
			wires := NewModelWireStore("")
			source, err := NewModelCatalogSourceWithWireModels(client, wires)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := source.DiscoverModels(context.Background(), testAgyAuth(t)); err != nil {
				t.Fatal(err)
			}
			fixture := newAgyCoordinatorFixtureWithWireModels(t, client, testAgyAuth(t), test.model, wires)
			var responseModel string
			if err := fixture.coordinator.Execute(fixture.context, fixture.request, func(event inference.StreamEvent) error {
				if started, ok := event.(inference.ResponseStartedEvent); ok {
					responseModel = started.Model()
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			usage, hasUsage := fixture.recorder.lastSuccess.Usage()
			if calls != 4 || fixture.recorder.successes != 1 || responseModel != test.model ||
				fixture.recorder.lastRoute.ModelID().String() != test.model || !hasUsage || usage.TotalTokens() != 7 {
				t.Fatalf("calls=%d successes=%d response model=%q route=%v usage=%v, want public model %q", calls, fixture.recorder.successes, responseModel, fixture.recorder.lastRoute, usage, test.model)
			}
		})
	}
}

func TestAdapterDefersNoHintResourceExhaustedAccountFailure(t *testing.T) {
	t.Parallel()

	client := recordingClient{do: func(request *http.Request) (*http.Response, error) {
		if strings.Contains(request.URL.String(), ":loadCodeAssist") {
			return jsonResponse(http.StatusOK, `{"cloudaicompanionProject":"project-123"}`), nil
		}
		return jsonResponse(http.StatusTooManyRequests, `{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"must never reach client"}}`), nil
	}}
	fixture := newAgyCoordinatorFixture(t, client, testAgyAuth(t))
	var failure inference.ResponseFailure
	if err := fixture.coordinator.Execute(
		fixture.context,
		fixture.request,
		func(event inference.StreamEvent) error {
			if failed, ok := event.(inference.ResponseFailedEvent); ok {
				failure = failed.Failure()
			}
			return nil
		},
	); err != nil {
		t.Fatalf("Coordinator.Execute() error = %v", err)
	}
	if failure.Code() != "rate_limited" || !failure.Retryable() ||
		len(fixture.recorder.failures) != 1 {
		t.Fatalf("failure=%#v recorded=%d", failure, len(fixture.recorder.failures))
	}
}

type agyCoordinatorFixture struct {
	coordinator *inferencegateway.Coordinator
	recorder    *agyAttemptRecorder
	context     context.Context
	request     inference.Request
}

func newAgyCoordinatorFixture(
	t *testing.T,
	client HTTPClient,
	credential *agy.OAuthAuth,
) agyCoordinatorFixture {
	return newAgyCoordinatorFixtureWithWireModels(t, client, credential, "claude-opus-4-6-thinking", nil)
}

func newAgyCoordinatorFixtureWithWireModels(
	t *testing.T,
	client HTTPClient,
	credential *agy.OAuthAuth,
	model string,
	wires ModelWireReader,
) agyCoordinatorFixture {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	alias, _ := accountcore.NewCLIAccountID(1)
	account, err := accountapp.NewRoutingAccount(catalog, accountapp.RoutingAccountInput{
		Ref: accountRef, ProviderID: agy.ProviderID, CLIAccountID: alias,
	})
	if err != nil {
		t.Fatalf("NewRoutingAccount() error = %v", err)
	}
	credentials := agyCredentialResolver{accountRef: accountRef, credential: credential}
	recruiter, err := accountrouting.NewRecruiter(accountrouting.Dependencies{
		Candidates:  agyCandidateSource{account: account},
		Runtime:     agyAvailableRuntime{},
		Credentials: credentials,
		Strategy:    accountrouting.StrategyRoundRobin,
	})
	if err != nil {
		t.Fatalf("NewRecruiter() error = %v", err)
	}
	adapter, err := NewAdapterWithWireModels(client, fixedClock, wires)
	if err != nil {
		t.Fatalf("NewAdapter() error = %v", err)
	}
	modelID, _ := runtimecore.NewModelID(model)
	route, err := adapter.BuildRoute(modelID)
	if err != nil {
		t.Fatalf("BuildRoute() error = %v", err)
	}
	registry, _ := inferencegateway.NewUpstreamRegistry(adapter)
	recorder := &agyAttemptRecorder{}
	coordinator, err := inferencegateway.NewCoordinator(inferencegateway.Dependencies{
		Catalog:                catalog,
		Routes:                 agyRouteResolver{route: route},
		Recruiter:              recruiter,
		Upstreams:              registry,
		Attempts:               recorder,
		CredentialObservations: credentials,
		Clock:                  fixedClock,
		ModelRefreshes:         agyModelRefreshScheduler{},
		UpstreamAttemptLimit:   1,
	})
	if err != nil {
		t.Fatalf("NewCoordinator() error = %v", err)
	}
	text, _ := inference.NewTextContent("reply briefly")
	message, _ := inference.NewMessage(inference.RoleUser, text)
	request, _ := inference.NewRequest(inference.RequestInput{
		ClientProtocol:  inference.ClientProtocolAnthropicMessages,
		Model:           modelID.String(),
		Messages:        []inference.Message{message},
		Stream:          true,
		MaxOutputTokens: 32,
	})
	return agyCoordinatorFixture{
		coordinator: coordinator,
		recorder:    recorder,
		context:     context.Background(),
		request:     request,
	}
}

type agyCandidateSource struct{ account accountapp.RoutingAccount }

func (source agyCandidateSource) LoadRoutingCandidates(
	context.Context,
	string,
	runtimecore.ModelID,
) (*accountapp.RoutingCandidates, error) {
	return accountapp.NewRoutingCandidates([]accountapp.RoutingAccount{source.account}), nil
}

type agyAvailableRuntime struct{}

func (agyAvailableRuntime) CheckEligibility(
	context.Context,
	runtimecore.ModelRoute,
) (runtimecore.Eligibility, error) {
	return runtimecore.AvailableEligibility(), nil
}

type agyCredentialResolver struct {
	accountRef accountcore.AccountRef
	credential accountapp.Credential
}

func (resolver agyCredentialResolver) ResolveCredentialBinding(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialBinding, error) {
	return accountapp.NewCredentialBinding(accountRef, agy.ProviderID, resolver.credential)
}

func (resolver agyCredentialResolver) ResolveObservedCredentialBinding(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (
	accountapp.CredentialBinding,
	accountcredentials.CredentialObservation,
	error,
) {
	binding, err := resolver.ResolveCredentialBinding(ctx, accountRef)
	if err != nil {
		return accountapp.CredentialBinding{}, accountcredentials.CredentialObservation{}, err
	}
	snapshot, err := accountapp.NewCredentialSnapshot(
		binding.AccountRef(),
		binding.ProviderID(),
		binding.Credential(),
		fixedClock(),
	)
	if err != nil {
		return accountapp.CredentialBinding{}, accountcredentials.CredentialObservation{}, err
	}
	observation, err := accountcredentials.NewCredentialObservation(snapshot)
	return binding, observation, err
}

func (agyCredentialResolver) IsCurrentCredentialObservation(
	_ context.Context,
	observation accountcredentials.CredentialObservation,
) (bool, error) {
	return observation.IsValid(), nil
}

type agyRouteResolver struct{ route inferencegateway.Route }

func (resolver agyRouteResolver) Resolve(
	context.Context,
	inference.Request,
) (inferencegateway.RoutePlan, error) {
	return inferencegateway.NewRoutePlan(resolver.route)
}

type agyAttemptRecorder struct {
	successes   int
	failures    []inferencegateway.AttemptFailure
	lastRoute   runtimecore.ModelRoute
	lastSuccess inferencegateway.AttemptSuccess
}

func (recorder *agyAttemptRecorder) RecordSuccess(
	_ context.Context,
	route runtimecore.ModelRoute,
	success inferencegateway.AttemptSuccess,
) error {
	recorder.successes++
	recorder.lastRoute = route
	recorder.lastSuccess = success
	return nil
}

func (recorder *agyAttemptRecorder) RecordFailure(
	_ context.Context,
	_ runtimecore.ModelRoute,
	failure inferencegateway.AttemptFailure,
) error {
	recorder.failures = append(recorder.failures, failure)
	return nil
}

type agyModelRefreshScheduler struct{}

func (agyModelRefreshScheduler) ScheduleModelRefresh(
	context.Context,
	accountcore.AccountRef,
	string,
) error {
	return nil
}

func eventKinds(events []inference.StreamEvent) []inference.EventKind {
	kinds := make([]inference.EventKind, len(events))
	for index, event := range events {
		kinds[index] = event.Kind()
	}
	return kinds
}

func jsonResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Content-Type": {"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}
