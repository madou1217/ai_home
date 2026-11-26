package webuiaccountoutcomesapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/madou1217/ai_home/application/accountoutcomes"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	_ "modernc.org/sqlite"
)

type stubAuthorizer struct{ allowed bool }

func (stub stubAuthorizer) Authorized(*http.Request) bool { return stub.allowed }

type stubReader struct {
	dayBuckets  []accountoutcomes.Bucket
	hourBuckets []accountoutcomes.Bucket
	err         error
}

func (s stubReader) ListAccountOutcomes(_ context.Context, g accountoutcomes.Granularity, _ int64) ([]accountoutcomes.Bucket, error) {
	if s.err != nil {
		return nil, s.err
	}
	if g == accountoutcomes.Hour {
		return s.hourBuckets, nil
	}
	return s.dayBuckets, nil
}

func mustRef(t *testing.T, hexSuffix string) accountcore.AccountRef {
	t.Helper()
	ref, err := accountcore.ParseAccountRef("acct_" + hexSuffix)
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return ref
}

func TestNewHandlerValidationAndHTTPGuards(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("err = %v, want %v", err, ErrInvalidDependencies)
	}
	unauth, _ := NewHandler(Dependencies{Authorizer: stubAuthorizer{allowed: false}})
	rec := httptest.NewRecorder()
	unauth.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, Path, nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauth code = %d, want 401", rec.Code)
	}

	handler, _ := NewHandler(Dependencies{Authorizer: stubAuthorizer{allowed: true}, AIHomeDir: t.TempDir()})
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, Path, nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("post code = %d, want 405", rec.Code)
	}

	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, Path, nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unavailable code = %d, want 503", rec.Code)
	}
}
