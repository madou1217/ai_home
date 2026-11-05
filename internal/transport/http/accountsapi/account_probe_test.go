package accountsapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

type fakeProbeStates struct {
	ref   string
	state ProbeState
	err   error
}

func (fake *fakeProbeStates) UpsertProbeState(_ context.Context, ref string, state ProbeState) error {
	fake.ref = ref
	fake.state = state
	return fake.err
}

func mustProbeRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return ref
}

func TestAccountProbeAcceptsPush(t *testing.T) {
	fake := &fakeProbeStates{}
	handler := &Handler{probeStates: fake}
	request := httptest.NewRequest(
		http.MethodPatch,
		CollectionPath+"/acct_0123456789abcdef0123/probe",
		strings.NewReader("{\"status\":\"ok\",\"checked_at_ms\":123}"),
	)
	recorder := httptest.NewRecorder()
	handler.handleAccountProbe(recorder, request, mustProbeRef(t))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if fake.ref == "" || fake.state.Status != "ok" || fake.state.CheckedAtMS != 123 {
		t.Fatalf("写入 = %q %+v", fake.ref, fake.state)
	}
}

func TestAccountProbeRejectsWrongMethod(t *testing.T) {
	handler := &Handler{probeStates: &fakeProbeStates{}}
	request := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader("{}"))
	recorder := httptest.NewRecorder()
	handler.handleAccountProbe(recorder, request, mustProbeRef(t))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", recorder.Code)
	}
}

func TestAccountProbeWithoutStoreReturns503(t *testing.T) {
	handler := &Handler{}
	request := httptest.NewRequest(http.MethodPatch, "/x", strings.NewReader("{}"))
	recorder := httptest.NewRecorder()
	handler.handleAccountProbe(recorder, request, mustProbeRef(t))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
}

func TestAccountProbeRejectsInvalidBody(t *testing.T) {
	handler := &Handler{probeStates: &fakeProbeStates{}}
	request := httptest.NewRequest(http.MethodPatch, "/x", strings.NewReader("not-json"))
	recorder := httptest.NewRecorder()
	handler.handleAccountProbe(recorder, request, mustProbeRef(t))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
}

func TestAttachProbeStates(t *testing.T) {
	views := []accountView{
		{AccountRef: "acct_0123456789abcdef0123"},
		{AccountRef: "acct_ffffffffffffffffffff"},
	}
	attached := attachProbeStates(views, map[string]ProbeState{
		"acct_0123456789abcdef0123": {Status: "ok", CheckedAtMS: 1000},
	})
	if attached[0].Probe == nil || attached[0].Probe.Status != "ok" {
		t.Fatalf("第一个账号应带 probe: %+v", attached[0].Probe)
	}
	if attached[1].Probe != nil {
		t.Fatalf("没有探针结果的账号不应带 probe: %+v", attached[1].Probe)
	}
	if attachProbeStates(views, nil)[0].Probe != nil {
		t.Fatal("空状态表不应改动视图")
	}
}
