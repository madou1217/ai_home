package webuigeoresourcesapi

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	runtimegeo "github.com/madou1217/ai_home/internal/runtime/geo"
)

type stubAuthorizer bool

func (a stubAuthorizer) Authorized(*http.Request) bool { return bool(a) }

func sampleGzipMMDB(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	raw := append([]byte("test-data"), []byte("\xab\xcd\xefMaxMind.com")...)
	if _, err := gz.Write(raw); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestGeoResourcesOverviewAndJobsFlow(t *testing.T) {
	t.Parallel()
	validGz := sampleGzipMMDB(t)
	release := make(chan struct{})
	downloadServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
		_, _ = w.Write(validGz)
	}))
	defer downloadServer.Close()

	manager := runtimegeo.NewJobManager(runtimegeo.JobManagerOptions{
		AIHomeDir:   t.TempDir(),
		HomeDir:     t.TempDir(),
		URLTemplate: downloadServer.URL + "/dbip-city-lite-%s.mmdb.gz",
		HTTPClient:  downloadServer.Client(),
	})
	handler, err := NewHandler(Dependencies{
		Authorizer: stubAuthorizer(true),
		Manager:    manager,
	})
	if err != nil {
		t.Fatalf("NewHandler 失败: %v", err)
	}

	mux := http.NewServeMux()
	mux.Handle("GET "+Path, handler)
	mux.Handle("GET "+JobsPath, handler)
	mux.Handle("POST "+JobsPath, handler)
	mux.Handle("GET "+JobPath, handler)
	mux.Handle("GET "+JobWatchPath, handler)
	mux.Handle("POST "+JobCancelPath, handler)

	// 1. 概览返回 resources / providers / jobs。
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, Path, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET %s 状态 = %d，期望 200", Path, rec.Code)
	}
	var overview map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &overview); err != nil {
		t.Fatal(err)
	}
	if overview["ok"] != true {
		t.Fatalf("overview ok != true: %v", overview)
	}
	if _, ok := overview["resources"].([]any); !ok {
		t.Fatalf("resources 类型异常: %T", overview["resources"])
	}
	if _, ok := overview["providers"].([]any); !ok {
		t.Fatalf("providers 类型异常: %T", overview["providers"])
	}

	// 2. 非法 JSON 返回 400。
	badRec := httptest.NewRecorder()
	mux.ServeHTTP(badRec, httptest.NewRequest(http.MethodPost, JobsPath, strings.NewReader("{bad")))
	if badRec.Code != http.StatusBadRequest {
		t.Fatalf("非法 JSON 状态 = %d，期望 400", badRec.Code)
	}

	// 3. 未知资源返回 409。
	unknownRec := httptest.NewRecorder()
	mux.ServeHTTP(unknownRec, httptest.NewRequest(http.MethodPost, JobsPath, strings.NewReader(`{"resourceId":"none","action":"install"}`)))
	if unknownRec.Code != http.StatusConflict {
		t.Fatalf("未知资源状态 = %d，期望 409", unknownRec.Code)
	}

	// 4. 启动合法作业并通过 SSE 观察直到成功。
	startRec := httptest.NewRecorder()
	mux.ServeHTTP(startRec, httptest.NewRequest(http.MethodPost, JobsPath, strings.NewReader(`{"resourceId":"dbip-city","action":"install"}`)))
	if startRec.Code != http.StatusOK {
		t.Fatalf("POST jobs 状态 = %d，期望 200: %s", startRec.Code, startRec.Body.String())
	}
	var startBody struct {
		OK  bool               `json:"ok"`
		Job runtimegeo.JobView `json:"job"`
	}
	if err := json.Unmarshal(startRec.Body.Bytes(), &startBody); err != nil {
		t.Fatal(err)
	}
	jobID := startBody.Job.ID

	httpSrv := httptest.NewServer(mux)
	defer httpSrv.Close()

	watchResp, err := http.Get(httpSrv.URL + JobsPath + "/" + jobID + "/watch")
	if err != nil {
		t.Fatalf("请求 SSE 失败: %v", err)
	}
	defer watchResp.Body.Close()
	if ct := watchResp.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("SSE Content-Type = %q", ct)
	}
	close(release)

	buf := make([]byte, 8192)
	var sseText strings.Builder
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		n, readErr := watchResp.Body.Read(buf)
		if n > 0 {
			sseText.Write(buf[:n])
			if strings.Contains(sseText.String(), `"status":"succeeded"`) {
				break
			}
		}
		if readErr != nil {
			break
		}
	}
	if !strings.Contains(sseText.String(), `"type":"connected"`) || !strings.Contains(sseText.String(), `"status":"succeeded"`) {
		t.Fatalf("SSE 输出缺少预期事件:\n%s", sseText.String())
	}

	// 5. 未授权拦截。
	unauthHandler, _ := NewHandler(Dependencies{Authorizer: stubAuthorizer(false), Manager: manager})
	unauthRec := httptest.NewRecorder()
	unauthHandler.ServeHTTP(unauthRec, httptest.NewRequest(http.MethodGet, Path, nil))
	if unauthRec.Code != http.StatusUnauthorized {
		t.Fatalf("未授权状态 = %d，期望 401", unauthRec.Code)
	}
}
