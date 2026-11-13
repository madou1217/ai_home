package webuiloginjobsapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/host/aihloginjob"
)

type stubAuthorizer struct{}

func (stubAuthorizer) Authorized(request *http.Request) bool {
	return request.Header.Get("Authorization") == "Bearer test-key"
}

type stubJobs struct {
	snapshot  aihloginjob.Snapshot
	cancelled bool
}

func (jobs *stubJobs) Start(_ context.Context, providerID string) (aihloginjob.Snapshot, error) {
	snapshot := jobs.snapshot
	snapshot.Provider = providerID
	return snapshot, nil
}

func (jobs *stubJobs) Get(id string) (aihloginjob.Snapshot, bool) {
	if id != jobs.snapshot.ID {
		return aihloginjob.Snapshot{}, false
	}
	return jobs.snapshot, true
}

func (jobs *stubJobs) Cancel(id string) bool {
	if id != jobs.snapshot.ID {
		return false
	}
	jobs.cancelled = true
	return true
}

func newTestServer(t *testing.T) (*httptest.Server, *stubJobs) {
	t.Helper()
	jobs := &stubJobs{snapshot: aihloginjob.Snapshot{
		ID:        "login-1",
		Status:    aihloginjob.StatusRunning,
		StartedAt: time.Unix(1700000000, 0).UTC(),
		UpdatedAt: time.Unix(1700000000, 0).UTC(),
		AuthURL:   "https://www.codebuddy.ai/login?state=x",
	}}
	handler, err := NewHandler(Dependencies{Authorizer: stubAuthorizer{}, Jobs: jobs})
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("POST "+Path, handler)
	mux.Handle("GET "+Path+ItemSuffix, handler)
	mux.Handle("POST "+Path+CancelSuffix, handler)
	return httptest.NewServer(mux), jobs
}

func request(t *testing.T, server *httptest.Server, method, path, body string) *http.Response {
	t.Helper()
	request, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer test-key")
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	return response
}

// TestLoginJobsLifecycle 创建 202、查询 200、取消 200、未知 404。
func TestLoginJobsLifecycle(t *testing.T) {
	server, jobs := newTestServer(t)
	defer server.Close()

	created := request(t, server, http.MethodPost, Path, `{"provider":"codebuddycn"}`)
	if created.StatusCode != http.StatusAccepted {
		t.Fatalf("create status = %d", created.StatusCode)
	}
	var createdBody jobResponse
	_ = json.NewDecoder(created.Body).Decode(&createdBody)
	if !createdBody.OK || createdBody.Job.Provider != "codebuddycn" || createdBody.Job.Status != "running" {
		t.Fatalf("created = %#v", createdBody)
	}

	got := request(t, server, http.MethodGet, Path+"/login-1", "")
	if got.StatusCode != http.StatusOK {
		t.Fatalf("get status = %d", got.StatusCode)
	}
	var gotBody jobResponse
	_ = json.NewDecoder(got.Body).Decode(&gotBody)
	if gotBody.Job.AuthURL == "" {
		t.Fatalf("authURL 丢失: %#v", gotBody)
	}

	cancelled := request(t, server, http.MethodPost, Path+"/login-1/cancel", "")
	if cancelled.StatusCode != http.StatusOK || !jobs.cancelled {
		t.Fatalf("cancel status = %d cancelled=%v", cancelled.StatusCode, jobs.cancelled)
	}

	missing := request(t, server, http.MethodGet, Path+"/login-unknown", "")
	if missing.StatusCode != http.StatusNotFound {
		t.Fatalf("missing status = %d", missing.StatusCode)
	}
}

// TestLoginJobsRequiresManagementKey 无密钥一律 401。
func TestLoginJobsRequiresManagementKey(t *testing.T) {
	server, _ := newTestServer(t)
	defer server.Close()
	response, err := server.Client().Get(server.URL + Path + "/login-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d", response.StatusCode)
	}
}

// TestProbeContractUsesJobNotFound Node 的能力探测依赖这个错误码：路由存在时未知
// 作业必须回 job_not_found（旧 Server 缺路由时是 route_not_found）。
func TestProbeContractUsesJobNotFound(t *testing.T) {
	server, _ := newTestServer(t)
	defer server.Close()
	response := request(t, server, http.MethodGet, Path+"/__probe__", "")
	defer response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d", response.StatusCode)
	}
	var body errorResponse
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Error != "job_not_found" {
		t.Fatalf("error = %q, want job_not_found", body.Error)
	}
}
