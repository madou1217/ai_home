package accountsapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

type fakeRoutingExclusions struct {
	accountRef accountcore.AccountRef
	excluded   bool
	reason     string
	err        error
}

func (fake *fakeRoutingExclusions) SetRoutingExclusion(
	_ context.Context,
	accountRef accountcore.AccountRef,
	excluded bool,
	reason string,
	_ time.Time,
) error {
	fake.accountRef = accountRef
	fake.excluded = excluded
	fake.reason = reason
	return fake.err
}

func newRoutingRequest(body string) *http.Request {
	request := httptest.NewRequest(
		http.MethodPut,
		CollectionPath+"/acct_0123456789abcdef0123/routing",
		strings.NewReader(body),
	)
	request.Header.Set("Content-Type", "application/json")
	return request
}

func TestAccountRoutingAcceptsExclusion(t *testing.T) {
	fake := &fakeRoutingExclusions{}
	handler := &Handler{routingExclusions: fake}
	recorder := httptest.NewRecorder()
	handler.handleAccountRouting(
		recorder,
		newRoutingRequest(`{"excluded":true,"reason":"  自定义上游  "}`),
		mustProbeRef(t),
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"excluded":true`) ||
		!strings.Contains(recorder.Body.String(), `"account_ref":"acct_0123456789abcdef0123"`) {
		t.Fatalf("body = %s", recorder.Body.String())
	}
	if fake.accountRef != mustProbeRef(t) || !fake.excluded || fake.reason != "自定义上游" {
		t.Fatalf("写入 = %q %v %q", fake.accountRef, fake.excluded, fake.reason)
	}
}

// 账号在 Node 标记之前被删掉是常态：必须回 404，Node 才能按终态处理而不是重试。
func TestAccountRoutingReturnsNotFound(t *testing.T) {
	fake := &fakeRoutingExclusions{err: accountapp.ErrAccountNotFound}
	handler := &Handler{routingExclusions: fake}
	recorder := httptest.NewRecorder()
	handler.handleAccountRouting(recorder, newRoutingRequest(`{"excluded":true}`), mustProbeRef(t))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", recorder.Code)
	}
}

func TestAccountRoutingRejectsInvalidBody(t *testing.T) {
	handler := &Handler{routingExclusions: &fakeRoutingExclusions{}}
	recorder := httptest.NewRecorder()
	handler.handleAccountRouting(recorder, newRoutingRequest("not-json"), mustProbeRef(t))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
}

func TestAccountRoutingRejectsLongReason(t *testing.T) {
	fake := &fakeRoutingExclusions{}
	handler := &Handler{routingExclusions: fake}
	recorder := httptest.NewRecorder()
	handler.handleAccountRouting(
		recorder,
		newRoutingRequest(`{"excluded":true,"reason":"`+strings.Repeat("排", 201)+`"}`),
		mustProbeRef(t),
	)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
	if fake.accountRef != "" {
		t.Fatal("拒绝请求时不应写入存储")
	}
}

func TestAccountRoutingWithoutStoreReturns503(t *testing.T) {
	handler := &Handler{}
	recorder := httptest.NewRecorder()
	handler.handleAccountRouting(recorder, newRoutingRequest(`{"excluded":true}`), mustProbeRef(t))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
}

func TestAccountRoutingRejectsWrongMethod(t *testing.T) {
	handler := &Handler{routingExclusions: &fakeRoutingExclusions{}}
	request := httptest.NewRequest(http.MethodGet, "/x", strings.NewReader("{}"))
	recorder := httptest.NewRecorder()
	handler.handleAccountRouting(recorder, request, mustProbeRef(t))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", recorder.Code)
	}
}

func TestParseMemberResourceRouting(t *testing.T) {
	resource, err := parseMemberResource(CollectionPath + "/acct_0123456789abcdef0123/routing")
	if err != nil {
		t.Fatalf("parseMemberResource() error = %v", err)
	}
	if resource.kind != memberResourceRouting {
		t.Fatalf("kind = %v, want memberResourceRouting", resource.kind)
	}
	if resource.accountRef != mustProbeRef(t) {
		t.Fatalf("accountRef = %q", resource.accountRef)
	}
	if _, err := parseMemberResource(CollectionPath + "/acct_0123456789abcdef0123/routing/x"); !errors.Is(err, accountcore.ErrInvalidAccountRef) {
		t.Fatalf("多余路径段 error = %v, want ErrInvalidAccountRef", err)
	}
}
