package inferencehttp

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeModelCatalog map[string]bool

func (catalog fakeModelCatalog) HasModel(model string) bool { return catalog[model] }

type fallbackProbe struct {
	upstreamCalls int
	nextCalls     int
	upstreamBody  string
	upstreamOwner string
}

func newFallbackProbe(catalog ModelCatalog) (http.Handler, *fallbackProbe) {
	probe := &fallbackProbe{}
	upstream := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		probe.upstreamCalls++
		body, _ := io.ReadAll(request.Body)
		probe.upstreamBody = string(body)
		probe.upstreamOwner = request.Header.Get(routeOwnerHeader)
		response.WriteHeader(http.StatusAccepted)
	})
	next := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		probe.nextCalls++
		_, _ = io.ReadAll(request.Body)
		response.WriteHeader(http.StatusOK)
	})
	return newModelFallback(catalog, upstream).wrap(next), probe
}

func serveFallback(t *testing.T, handler http.Handler, method, path, contentType, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer test")
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestFallbackRoutesUnknownModelToHost(t *testing.T) {
	handler, probe := newFallbackProbe(fakeModelCatalog{"gpt-5": true})
	body := `{"model":"gemini-2.5-pro","messages":[]}`
	recorder := serveFallback(t, handler, http.MethodPost, "/v1/chat/completions", "application/json", body)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d", recorder.Code)
	}
	if probe.upstreamCalls != 1 || probe.nextCalls != 0 {
		t.Fatalf("upstream=%d next=%d", probe.upstreamCalls, probe.nextCalls)
	}
	if probe.upstreamBody != body {
		t.Fatalf("body = %q", probe.upstreamBody)
	}
	if probe.upstreamOwner != routeOwnerNode {
		t.Fatalf("route owner = %q", probe.upstreamOwner)
	}
}

func TestFallbackKeepsKnownModelInGo(t *testing.T) {
	handler, probe := newFallbackProbe(fakeModelCatalog{"gpt-5": true})
	body := `{"model":"gpt-5"}`
	recorder := serveFallback(t, handler, http.MethodPost, "/v1/responses", "application/json", body)
	if recorder.Code != http.StatusOK || probe.nextCalls != 1 || probe.upstreamCalls != 0 {
		t.Fatalf("status=%d next=%d upstream=%d", recorder.Code, probe.nextCalls, probe.upstreamCalls)
	}
}

func TestFallbackPassesThroughWithoutModel(t *testing.T) {
	handler, probe := newFallbackProbe(fakeModelCatalog{"gpt-5": true})
	serveFallback(t, handler, http.MethodGet, "/v1/models", "", "")
	serveFallback(t, handler, http.MethodPost, "/v1/images/generations", "application/json", `{"prompt":"x"}`)
	serveFallback(t, handler, http.MethodPost, "/v1/chat/completions", "text/plain", `{"model":"gemini"}`)
	if probe.nextCalls != 3 || probe.upstreamCalls != 0 {
		t.Fatalf("next=%d upstream=%d", probe.nextCalls, probe.upstreamCalls)
	}
}

func TestFallbackReadsGeminiModelFromPath(t *testing.T) {
	handler, probe := newFallbackProbe(fakeModelCatalog{})
	recorder := serveFallback(t, handler, http.MethodPost, "/v1beta/models/gemini-2.5-pro:generateContent", "application/json", `{"contents":[]}`)
	if recorder.Code != http.StatusAccepted || probe.upstreamCalls != 1 {
		t.Fatalf("status=%d upstream=%d", recorder.Code, probe.upstreamCalls)
	}
}

func TestFallbackRestoresBodyBeyondProbeWindow(t *testing.T) {
	handler, probe := newFallbackProbe(fakeModelCatalog{})
	// model 在前缀内，后面跟一个超过探测窗口的大字段：宿主必须收到完整原文。
	padding := strings.Repeat("a", modelProbeBytes+1024)
	body := `{"model":"custom-model","pad":"` + padding + `"}`
	recorder := serveFallback(t, handler, http.MethodPost, "/v1/chat/completions", "application/json", body)
	if recorder.Code != http.StatusAccepted || probe.upstreamCalls != 1 {
		t.Fatalf("status=%d upstream=%d", recorder.Code, probe.upstreamCalls)
	}
	if len(probe.upstreamBody) != len(body) || probe.upstreamBody != body {
		t.Fatalf("body length = %d, want %d", len(probe.upstreamBody), len(body))
	}
}

func TestFallbackSkipsBodyProbeWithoutCredential(t *testing.T) {
	handler, probe := newFallbackProbe(fakeModelCatalog{})
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader("{\"model\":\"gemini-2.5-pro\"}"))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if probe.nextCalls != 1 || probe.upstreamCalls != 0 {
		t.Fatalf("next=%d upstream=%d", probe.nextCalls, probe.upstreamCalls)
	}
}
