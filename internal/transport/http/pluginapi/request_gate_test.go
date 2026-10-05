package pluginapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	appplugins "github.com/madou1217/ai_home/application/pluginruntime"
)

type keyAuthorizer struct{ key string }

func (authorizer keyAuthorizer) Authorized(request *http.Request) bool {
	return request.Header.Get("Authorization") == "Bearer "+authorizer.key
}

type scriptedInvoker struct {
	result string
	err    error
	calls  int
}

func (invoker *scriptedInvoker) Invoke(context.Context, int64, string, any, time.Duration) (json.RawMessage, error) {
	invoker.calls++
	if invoker.err != nil {
		return nil, invoker.err
	}
	return json.RawMessage(invoker.result), nil
}

type codedError struct{ code string }

func (err codedError) Error() string     { return err.code }
func (err codedError) ErrorCode() string { return err.code }

type fakeProbe struct{ err error }

func (probe *fakeProbe) Probe(context.Context, appplugins.HostAccess) error { return probe.err }

type recordedRequest struct {
	called bool
	body   string
	length int64
	header string
}

func gateFixture(t *testing.T, result string, generations ...appplugins.Projection) (*RequestGate, *scriptedInvoker, *appplugins.Registry) {
	t.Helper()
	registry := appplugins.NewRegistry()
	if _, err := registry.Replace(appplugins.HostAccess{Address: "/tmp/h.sock", Token: "t"}, generations); err != nil {
		t.Fatal(err)
	}
	invoker := &scriptedInvoker{result: result}
	gate, err := NewRequestGate(registry, invoker, keyAuthorizer{key: "internal"}, 4096)
	if err != nil {
		t.Fatal(err)
	}
	return gate, invoker, registry
}

func requestProjection(generation int64) appplugins.Projection {
	return appplugins.Projection{Generation: generation, Contributions: []appplugins.Contribution{
		{ID: "rw", Capability: appplugins.CapabilityGatewayRequest, FailurePolicy: "deny", InstanceID: "p"},
	}}
}

func serve(gate *RequestGate, request *http.Request) (*httptest.ResponseRecorder, *recordedRequest) {
	seen := &recordedRequest{}
	next := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		*seen = recordedRequest{called: true, body: string(body), length: request.ContentLength, header: request.Header.Get(GenerationHeader)}
		response.WriteHeader(299)
	})
	recorder := httptest.NewRecorder()
	gate.Wrap("openai_chat", next).ServeHTTP(recorder, request)
	return recorder, seen
}

func post(body string, generation string, key string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if key != "" {
		request.Header.Set("Authorization", "Bearer "+key)
	}
	if generation != "" {
		request.Header.Set(GenerationHeader, generation)
	}
	return request
}

const chatBody = `{"model":"gpt-6","messages":[{"role":"user","content":"hi"}]}`

func TestGateWithoutGenerationIsAPassThrough(t *testing.T) {
	gate, invoker, _ := gateFixture(t, `null`, requestProjection(3))
	recorder, seen := serve(gate, post(chatBody, "", "internal"))
	if recorder.Code != 299 || seen.body != chatBody || invoker.calls != 0 {
		t.Fatalf("code=%d body=%q calls=%d", recorder.Code, seen.body, invoker.calls)
	}
}

func TestGateRewritesRejectsAndStripsTheHeader(t *testing.T) {
	gate, invoker, _ := gateFixture(t, `{"body":{"model":"gpt-6","messages":[{"role":"user","content":"rewritten"}]}}`, requestProjection(3))
	recorder, seen := serve(gate, post(chatBody, "3", "internal"))
	if recorder.Code != 299 || !strings.Contains(seen.body, "rewritten") || seen.length != int64(len(seen.body)) || invoker.calls != 1 {
		t.Fatalf("code=%d seen=%+v", recorder.Code, seen)
	}
	if seen.header != "" {
		t.Fatal("the generation header must not reach the handler")
	}

	gate, _, _ = gateFixture(t, `{"reject":{"status":451,"message":"blocked"}}`, requestProjection(3))
	recorder, seen = serve(gate, post(chatBody, "3", "internal"))
	if recorder.Code != 451 || seen.called || !strings.Contains(recorder.Body.String(), `"code":"plugin_rejected"`) {
		t.Fatalf("reject code=%d body=%s called=%v", recorder.Code, recorder.Body.String(), seen.called)
	}

	gate, _, _ = gateFixture(t, `null`, requestProjection(3))
	original := `{ "model" : "gpt-6",  "n": 1.50 }`
	_, seen = serve(gate, post(original, "3", "internal"))
	if seen.body != original {
		t.Fatalf("an unchanged body must keep its bytes: %q", seen.body)
	}
}

func TestGateHandsBackWhatGoCannotServe(t *testing.T) {
	gate, invoker, _ := gateFixture(t, `null`, requestProjection(3))
	recorder, seen := serve(gate, post(chatBody, "4", "internal"))
	if recorder.Code != 400 || recorder.Header().Get("X-AIH-Decode-Rejected") != "1" || seen.called {
		t.Fatalf("unknown generation: code=%d", recorder.Code)
	}
	compressed := post(chatBody, "3", "internal")
	compressed.Header.Set("Content-Encoding", "gzip")
	recorder, seen = serve(gate, compressed)
	if recorder.Code != 400 || recorder.Header().Get("X-AIH-Decode-Rejected") != "1" || seen.called || invoker.calls != 0 {
		t.Fatalf("compressed: code=%d calls=%d", recorder.Code, invoker.calls)
	}
}

func TestGateHandsBackWhenTheHostIsUnreachableOrTheBodyIsTooLarge(t *testing.T) {
	gate, invoker, _ := gateFixture(t, `null`, requestProjection(3))
	invoker.err = codedError{code: "plugin_rpc_closed"}
	recorder, seen := serve(gate, post(chatBody, "3", "internal"))
	if recorder.Code != 400 || recorder.Header().Get("X-AIH-Decode-Rejected") != "1" || seen.called {
		t.Fatalf("unreachable host must hand back, not 502: code=%d body=%s", recorder.Code, recorder.Body.String())
	}
	invoker.err = nil
	large := `{"model":"gpt-6","input":"` + strings.Repeat("x", 5000) + `"}`
	recorder, seen = serve(gate, post(large, "3", "internal"))
	if recorder.Code != 400 || recorder.Header().Get("X-AIH-Decode-Rejected") != "1" || seen.called {
		t.Fatalf("oversized body must hand back: code=%d", recorder.Code)
	}
}

func TestGateIgnoresTheHeaderWithoutTheInternalKeyAndForGenerationsWithoutRequestPlugins(t *testing.T) {
	gate, invoker, _ := gateFixture(t, `{"reject":{"status":451}}`, requestProjection(3), appplugins.Projection{Generation: 5, Contributions: []appplugins.Contribution{
		{ID: "obs", Capability: "observe", FailurePolicy: "deny", InstanceID: "p"},
	}})
	recorder, seen := serve(gate, post(chatBody, "3", "forged"))
	if recorder.Code != 299 || seen.body != chatBody || seen.header != "" || invoker.calls != 0 {
		t.Fatalf("forged: code=%d calls=%d header=%q", recorder.Code, invoker.calls, seen.header)
	}
	recorder, seen = serve(gate, post(chatBody, "5", "internal"))
	if recorder.Code != 299 || seen.body != chatBody || invoker.calls != 0 {
		t.Fatalf("no request plugins: code=%d calls=%d", recorder.Code, invoker.calls)
	}
}

func TestProjectionEndpointRequiresTheManagementKeyAndReplacesTheLiveSet(t *testing.T) {
	registry := appplugins.NewRegistry()
	probe := &fakeProbe{}
	handler, err := NewProjectionHandler(keyAuthorizer{key: "management"}, registry, probe)
	if err != nil {
		t.Fatal(err)
	}
	push := func(key string, body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPut, ProjectionPath, bytes.NewBufferString(body))
		request.Header.Set("Authorization", "Bearer "+key)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder
	}
	valid := `{"host":{"address":"/tmp/h.sock","token":"secret-token"},"generations":[{"generation":3,"contributions":[{"id":"rw","capability":"gateway.request","order":0,"failurePolicy":"deny","instanceId":"p"}]}]}`
	if recorder := push("internal", valid); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("client key must not push projections: %d", recorder.Code)
	}
	recorder := push("management", valid)
	if recorder.Code != 200 || !strings.Contains(recorder.Body.String(), `"generations":[3]`) {
		t.Fatalf("push: %d %s", recorder.Code, recorder.Body.String())
	}
	if recorder := push("management", `{"host":{},"generations":[{"generation":0}]}`); recorder.Code != 400 {
		t.Fatalf("invalid push: %d", recorder.Code)
	}
	probe.err = codedError{code: "plugin_rpc_closed"}
	if recorder := push("management", valid); recorder.Code != 200 || !strings.Contains(recorder.Body.String(), `"generations":[]`) {
		t.Fatalf("an unreachable host must acknowledge nothing: %d %s", recorder.Code, recorder.Body.String())
	}
	if _, ok := registry.Get(3); ok {
		t.Fatal("an unreachable host clears the projection")
	}
	probe.err = nil
	push("management", valid)
	get := httptest.NewRequest(http.MethodGet, ProjectionPath, nil)
	get.Header.Set("Authorization", "Bearer management")
	listing := httptest.NewRecorder()
	handler.ServeHTTP(listing, get)
	if !strings.Contains(listing.Body.String(), `"generations":[3]`) || strings.Contains(listing.Body.String(), "secret-token") {
		t.Fatalf("listing: %s", listing.Body.String())
	}
}
