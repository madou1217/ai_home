package pluginruntime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

type fakeInvoker struct {
	results map[string]string
	errs    map[string]error
	calls   []string
	bodies  []string
}

func (invoker *fakeInvoker) Invoke(_ context.Context, generation int64, id string, value any, _ time.Duration) (json.RawMessage, error) {
	invoker.calls = append(invoker.calls, id)
	encoded, _ := json.Marshal(value)
	invoker.bodies = append(invoker.bodies, string(encoded))
	if err := invoker.errs[id]; err != nil {
		return nil, err
	}
	return json.RawMessage(invoker.results[id]), nil
}

func projectionOf(items ...Contribution) Projection {
	return Projection{Generation: 7, Contributions: items}
}

func request(id string, order int, policy string) Contribution {
	return Contribution{ID: id, Capability: CapabilityGatewayRequest, Order: order, FailurePolicy: policy, InstanceID: "inst-" + id}
}

const sampleBody = `{"model":"gpt-6","n":9007199254740993,"previous_response_id":"resp_1","input":[{"type":"reasoning","encrypted_content":"opaque"}]}`

func TestRequestStageRunsInSnapshotOrderAndSeesThePreviousOutput(t *testing.T) {
	invoker := &fakeInvoker{results: map[string]string{
		"b": `{"body":{"model":"gpt-6","n":9007199254740993,"previous_response_id":"resp_1","input":[{"type":"reasoning","encrypted_content":"opaque"}],"tag":"b"}}`,
		"a": `null`,
	}}
	outcome, err := RunRequestStage(context.Background(), invoker, projectionOf(request("b", 2, "deny"), request("a", 1, "deny")), RequestInput{Protocol: "openai_responses", Path: "/v1/responses", Body: json.RawMessage(sampleBody)})
	if err != nil || outcome.Reject != nil || !outcome.Changed {
		t.Fatalf("outcome=%+v err=%v", outcome, err)
	}
	if strings.Join(invoker.calls, ",") != "a,b" {
		t.Fatalf("calls=%v", invoker.calls)
	}
	if !strings.Contains(string(outcome.Body), `"tag":"b"`) || !strings.Contains(string(outcome.Body), "9007199254740993") {
		t.Fatalf("body=%s", outcome.Body)
	}
	if !strings.Contains(invoker.bodies[0], `"model":"gpt-6"`) || !strings.Contains(invoker.bodies[0], `"protocol":"openai_responses"`) {
		t.Fatalf("plugin input=%s", invoker.bodies[0])
	}
}

func TestUnchangedRequestKeepsTheOriginalBytes(t *testing.T) {
	original := `{ "model" : "x",  "n": 1.50 }`
	outcome, err := RunRequestStage(context.Background(), &fakeInvoker{results: map[string]string{"a": "null"}}, projectionOf(request("a", 0, "deny")), RequestInput{Body: json.RawMessage(original)})
	if err != nil || outcome.Changed || string(outcome.Body) != original {
		t.Fatalf("outcome=%+v err=%v", outcome, err)
	}
}

func TestRequestStageRejectsIdentityChangesAndClampsRejectStatus(t *testing.T) {
	for name, result := range map[string]string{
		"continuation": `{"body":{"model":"gpt-6","previous_response_id":"resp_2","input":[{"type":"reasoning","encrypted_content":"opaque"}]}}`,
		"encrypted":    `{"body":{"model":"gpt-6","previous_response_id":"resp_1","input":[{"type":"reasoning","encrypted_content":"forged"}]}}`,
		"metadata":     `{"body":{"model":"gpt-6","previous_response_id":"resp_1","metadata":{"session_id":"s"},"input":[{"type":"reasoning","encrypted_content":"opaque"}]}}`,
	} {
		_, err := RunRequestStage(context.Background(), &fakeInvoker{results: map[string]string{"a": result}}, projectionOf(request("a", 0, "deny")), RequestInput{Body: json.RawMessage(sampleBody)})
		var stageErr *StageError
		if !errors.As(err, &stageErr) || stageErr.Code != "plugin_identity_modified" {
			t.Fatalf("%s: err=%v", name, err)
		}
	}
	outcome, err := RunRequestStage(context.Background(), &fakeInvoker{results: map[string]string{"a": `{"reject":{"status":503,"message":"nope"}}`}}, projectionOf(request("a", 0, "deny")), RequestInput{Body: json.RawMessage(sampleBody)})
	if err != nil || outcome.Reject == nil || outcome.Reject.Status != 403 || outcome.Reject.Message != "nope" {
		t.Fatalf("reject=%+v err=%v", outcome.Reject, err)
	}
	outcome, _ = RunRequestStage(context.Background(), &fakeInvoker{results: map[string]string{"a": `{"reject":{"status":451}}`}}, projectionOf(request("a", 0, "deny")), RequestInput{Body: json.RawMessage(sampleBody)})
	if outcome.Reject == nil || outcome.Reject.Status != 451 {
		t.Fatalf("451 reject=%+v", outcome.Reject)
	}
}

func TestFailuresDenyByDefaultAndDelegateSkipsOnlyThatPlugin(t *testing.T) {
	invoker := &fakeInvoker{
		results: map[string]string{"b": `{"body":{"model":"rewritten","previous_response_id":"resp_1","input":[{"type":"reasoning","encrypted_content":"opaque"}]}}`},
		errs:    map[string]error{"a": errors.New("boom")},
	}
	outcome, err := RunRequestStage(context.Background(), invoker, projectionOf(request("a", 0, "delegate"), request("b", 1, "deny")), RequestInput{Body: json.RawMessage(sampleBody)})
	if err != nil || !strings.Contains(string(outcome.Body), "rewritten") {
		t.Fatalf("delegate outcome=%+v err=%v", outcome, err)
	}
	_, err = RunRequestStage(context.Background(), &fakeInvoker{errs: map[string]error{"a": errors.New("boom")}}, projectionOf(request("a", 0, "deny")), RequestInput{Body: json.RawMessage(sampleBody)})
	var stageErr *StageError
	if !errors.As(err, &stageErr) || stageErr.Code != "plugin_failed" || stageErr.ContributionID != "a" {
		t.Fatalf("deny err=%v", err)
	}
	_, err = RunRequestStage(context.Background(), &fakeInvoker{results: map[string]string{"a": `[1]`}}, projectionOf(request("a", 0, "deny")), RequestInput{Body: json.RawMessage(sampleBody)})
	if !errors.As(err, &stageErr) || stageErr.Code != "plugin_result_invalid" {
		t.Fatalf("invalid err=%v", err)
	}
}

func TestRegistryReplacesTheLiveSetAtomically(t *testing.T) {
	registry := NewRegistry()
	accepted, err := registry.Replace(HostAccess{Address: "/tmp/h.sock", Token: "t"}, []Projection{projectionOf(request("a", 0, "deny"))})
	if err != nil || len(accepted) != 1 || accepted[0] != 7 {
		t.Fatalf("accepted=%v err=%v", accepted, err)
	}
	if _, err := registry.Replace(HostAccess{Address: "/tmp/h.sock", Token: "t"}, []Projection{{Generation: 9, Contributions: []Contribution{{ID: "x", Capability: "c", InstanceID: "i", FailurePolicy: "bogus"}}}}); err == nil {
		t.Fatal("invalid projection must be refused")
	}
	if _, ok := registry.Get(7); !ok {
		t.Fatal("a refused replace must keep the previous set")
	}
	if _, err := registry.Replace(HostAccess{}, nil); err != nil {
		t.Fatal(err)
	}
	if _, ok := registry.Get(7); ok {
		t.Fatal("an empty push clears every generation")
	}
}
