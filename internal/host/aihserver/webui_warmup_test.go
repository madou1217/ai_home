package aihserver

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"
)

func TestWebUIWarmupHitsAllPathsSequentiallyInProcess(t *testing.T) {
	type capturedRequest struct {
		method string
		path   string
		auth   string
		warmup string
	}
	var (
		mu       sync.Mutex
		captured []capturedRequest
	)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		captured = append(captured, capturedRequest{
			method: r.Method,
			path:   r.URL.Path,
			auth:   r.Header.Get("Authorization"),
			warmup: r.Header.Get("X-AIH-Warmup"),
		})
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	done := startWebUIWarmupWithConfig(
		ctx,
		handler,
		func() string { return "secret-mgmt-token" },
		webuiWarmupConfig{
			settleDelay:    5 * time.Millisecond,
			gap:            5 * time.Millisecond,
			requestTimeout: time.Second,
			paths:          webuiWarmupPaths,
		},
	)
	<-done

	wantPaths := []string{
		"/v1/management/webui/toolkit/native-resources",
		"/v1/management/webui/toolkit/apps",
		"/v1/management/webui/toolkit/tools",
		"/v1/management/webui/toolkit/environments",
		"/v1/management/webui/toolkit/mirrors",
		"/v1/management/webui/toolkit/provider-configs",
		"/v1/management/webui/toolkit/terminals",
		"/v1/management/webui/management/usage/stats",
	}
	mu.Lock()
	defer mu.Unlock()
	if len(captured) != len(wantPaths) {
		t.Fatalf("captured = %d requests, want %d: %+v", len(captured), len(wantPaths), captured)
	}
	for i, want := range wantPaths {
		got := captured[i]
		if got.method != http.MethodGet || got.path != want {
			t.Fatalf("request[%d] = %s %s, want GET %s", i, got.method, got.path, want)
		}
		if got.auth != "Bearer secret-mgmt-token" {
			t.Fatalf("request[%d] Authorization = %q", i, got.auth)
		}
		if got.warmup != "1" {
			t.Fatalf("request[%d] X-AIH-Warmup = %q, want 1", i, got.warmup)
		}
	}
}

func TestWebUIWarmupSkipsWhenTokenMissing(t *testing.T) {
	called := 0
	handler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called++
		w.WriteHeader(http.StatusOK)
	})
	done := startWebUIWarmupWithConfig(
		context.Background(),
		handler,
		func() string { return "   " },
		webuiWarmupConfig{settleDelay: time.Millisecond, gap: time.Millisecond, requestTimeout: time.Second},
	)
	<-done
	if called != 0 {
		t.Fatalf("expected 0 requests when token is empty, got %d", called)
	}
}

func TestWebUIWarmupRespectsContextCancellation(t *testing.T) {
	firstHit := make(chan struct{}, 1)
	releaseHandler := make(chan struct{})
	var mu sync.Mutex
	paths := []string{}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.Path)
		mu.Unlock()
		select {
		case firstHit <- struct{}{}:
		default:
		}
		<-releaseHandler
		w.WriteHeader(http.StatusOK)
	})

	ctx, cancel := context.WithCancel(context.Background())
	done := startWebUIWarmupWithConfig(
		ctx,
		handler,
		func() string { return "tok" },
		webuiWarmupConfig{
			settleDelay:    time.Millisecond,
			gap:            50 * time.Millisecond,
			requestTimeout: time.Second,
			paths:          webuiWarmupPaths,
		},
	)

	<-firstHit
	cancel()
	close(releaseHandler)
	<-done

	mu.Lock()
	defer mu.Unlock()
	if len(paths) >= len(webuiWarmupPaths) {
		t.Fatalf("expected cancellation before completing all %d paths, got %d", len(webuiWarmupPaths), len(paths))
	}
}
