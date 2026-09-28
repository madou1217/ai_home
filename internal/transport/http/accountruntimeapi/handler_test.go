package accountruntimeapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

type allowAll bool

func (allowed allowAll) Authorized(*http.Request) bool { return bool(allowed) }

type fakeSource []runtimeapp.AccountView

func (source fakeSource) RuntimeSnapshot() []runtimeapp.AccountView { return source }

// TestHandlerServesRuntimeSnapshotBehindManagementAuth 验证鉴权、方法限制与 JSON 投影。
func TestHandlerServesRuntimeSnapshotBehindManagementAuth(t *testing.T) {
	t.Parallel()

	ref, _ := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	until := time.UnixMilli(1_790_000_000_000)
	source := fakeSource{{
		AccountRef: ref,
		Blocks:     []runtimecore.RecoveryTrigger{runtimecore.RecoveryUsageSnapshot},
		Models: []runtimeapp.ModelView{{
			Model:         "gpt-5.4",
			CooldownKind:  runtimecore.FailureRateLimited,
			CooldownUntil: until,
		}},
		LastSuccessAt:   time.UnixMilli(1_789_999_000_000),
		LastFailureKind: "rate_limited",
		LastFailureAt:   time.UnixMilli(1_789_999_500_000),
	}}
	authorized, err := NewHandler(allowAll(true), source)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	denied, _ := NewHandler(allowAll(false), source)

	recorder := httptest.NewRecorder()
	denied.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", recorder.Code)
	}
	recorder = httptest.NewRecorder()
	authorized.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d", recorder.Code)
	}

	recorder = httptest.NewRecorder()
	authorized.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("GET status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var body struct {
		Data []accountView `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Data) != 1 {
		t.Fatalf("data = %+v", body.Data)
	}
	got := body.Data[0]
	if got.AccountRef != ref.String() ||
		len(got.Blocks) != 1 || got.Blocks[0] != "usage_snapshot" ||
		len(got.Models) != 1 || got.Models[0].Model != "gpt-5.4" ||
		got.Models[0].CooldownKind != "rate_limited" || got.Models[0].CooldownUntilMS != until.UnixMilli() ||
		got.LastSuccessMS != 1_789_999_000_000 || got.LastFailureMS != 1_789_999_500_000 ||
		got.LastFailureKind != "rate_limited" {
		t.Fatalf("projection = %+v", got)
	}
}

// TestNewHandlerRejectsMissingDependencies 验证装配期失败关闭。
func TestNewHandlerRejectsMissingDependencies(t *testing.T) {
	t.Parallel()

	if _, err := NewHandler(nil, fakeSource{}); err == nil {
		t.Fatal("missing authorizer accepted")
	}
	if _, err := NewHandler(allowAll(true), nil); err == nil {
		t.Fatal("missing source accepted")
	}
}
