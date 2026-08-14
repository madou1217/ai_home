package codeassist

import (
	"context"
	"crypto/rand"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

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
	recruiter, err := accountrouting.NewRecruiter(accountrouting.Dependencies{
		Candidates:  agyCandidateSource{account: account},
		Runtime:     agyAvailableRuntime{},
		Credentials: agyCredentialResolver{accountRef: accountRef, credential: credential},
	})
	if err != nil {
		t.Fatalf("NewRecruiter() error = %v", err)
	}
	adapter, err := NewAdapter(client, fixedClock)
	if err != nil {
		t.Fatalf("NewAdapter() error = %v", err)
	}
	modelID, _ := runtimecore.NewModelID("claude-opus-4-6-thinking")
	route, err := adapter.BuildRoute(modelID)
	if err != nil {
		t.Fatalf("BuildRoute() error = %v", err)
	}
	registry, _ := inferencegateway.NewUpstreamRegistry(adapter)
	recorder := &agyAttemptRecorder{}
	coordinator, err := inferencegateway.NewCoordinator(inferencegateway.Dependencies{
		Catalog:              catalog,
		Routes:               agyRouteResolver{route: route},
		Recruiter:            recruiter,
		Upstreams:            registry,
		Attempts:             recorder,
		ModelRefreshes:       agyModelRefreshScheduler{},
		UpstreamAttemptLimit: 1,
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

type agyRouteResolver struct{ route inferencegateway.Route }

func (resolver agyRouteResolver) Resolve(
	context.Context,
	inference.Request,
) (inferencegateway.RoutePlan, error) {
	return inferencegateway.NewRoutePlan(resolver.route)
}

type agyAttemptRecorder struct {
	successes int
	failures  []inferencegateway.AttemptFailure
}

func (recorder *agyAttemptRecorder) RecordSuccess(
	context.Context,
	runtimecore.ModelRoute,
) error {
	recorder.successes++
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
