package accountoutcomesapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/madou1217/ai_home/application/accountoutcomes"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

type allowAll bool

func (allowed allowAll) Authorized(*http.Request) bool { return bool(allowed) }

type fakeReader struct{ buckets []accountoutcomes.Bucket }

func (reader fakeReader) ListAccountOutcomes(context.Context, accountoutcomes.Granularity, int64) ([]accountoutcomes.Bucket, error) {
	return reader.buckets, nil
}

// TestHandlerServesBucketsBehindManagementAuth 验证鉴权、参数校验与返回形状。
func TestHandlerServesBucketsBehindManagementAuth(t *testing.T) {
	t.Parallel()

	ref, _ := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	reader := fakeReader{buckets: []accountoutcomes.Bucket{{AccountRef: ref, BucketStartMS: 1000, Outcome: "success", Count: 7}}}
	authorized, _ := NewHandler(allowAll(true), reader)
	denied, _ := NewHandler(allowAll(false), reader)

	serve := func(handler http.Handler, method, target string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(method, target, nil))
		return recorder
	}
	if got := serve(denied, http.MethodGet, Path+"?granularity=day&from_ms=0").Code; got != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", got)
	}
	if got := serve(authorized, http.MethodPost, Path+"?granularity=day&from_ms=0").Code; got != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d", got)
	}
	for _, query := range []string{"?granularity=week&from_ms=0", "?granularity=day", "?granularity=hour&from_ms=-5"} {
		if got := serve(authorized, http.MethodGet, Path+query).Code; got != http.StatusBadRequest {
			t.Fatalf("%s status = %d", query, got)
		}
	}
	response := serve(authorized, http.MethodGet, Path+"?granularity=hour&from_ms=0")
	var body struct {
		Data []bucketView `json:"data"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &body) != nil ||
		len(body.Data) != 1 || body.Data[0].Count != 7 || body.Data[0].AccountRef != ref.String() {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}
