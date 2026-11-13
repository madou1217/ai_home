package webuitasksapi

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/taskhub"
)

type stubAuthorizer struct{ allowed bool }

func (stub stubAuthorizer) Authorized(*http.Request) bool { return stub.allowed }

func TestNewHandlerAndGuards(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("err = %v, want %v", err, ErrInvalidDependencies)
	}
	hub := taskhub.NewHub()
	unauth, _ := NewHandler(Dependencies{Authorizer: stubAuthorizer{allowed: false}, Hub: hub})
	rec := httptest.NewRecorder()
	unauth.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, Path, nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauth code = %d", rec.Code)
	}

	h, _ := NewHandler(Dependencies{Authorizer: stubAuthorizer{allowed: true}, Hub: hub})
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, Path, nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("method code = %d", rec.Code)
	}
}

func TestGetTasksAndWatchStream(t *testing.T) {
	hub := taskhub.NewHub()
	hub.RegisterSource("src", func() []taskhub.Task {
		return []taskhub.Task{{"id": "t1", "status": "running", "createdAt": int64(10)}}
	})
	h, _ := NewHandler(Dependencies{
		Authorizer:        stubAuthorizer{allowed: true},
		Hub:               hub,
		HeartbeatInterval: 35 * time.Millisecond,
	})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, Path, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var listResp struct {
		OK    bool           `json:"ok"`
		Tasks []taskhub.Task `json:"tasks"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listResp); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if !listResp.OK || len(listResp.Tasks) != 1 || listResp.Tasks[0]["id"] != "t1" {
		t.Fatalf("unexpected list response: %+v", listResp)
	}

	server := httptest.NewServer(h)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+WatchPath, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do() error = %v", err)
	}
	defer resp.Body.Close()

	scanner := bufio.NewScanner(resp.Body)
	if !scanner.Scan() || !strings.Contains(scanner.Text(), `"type":"connected"`) {
		t.Fatalf("expected connected frame, got %q", scanner.Text())
	}
	for scanner.Scan() {
		if line := scanner.Text(); strings.Contains(line, `"type":"snapshot"`) {
			if !strings.Contains(line, `"t1"`) {
				t.Fatalf("snapshot missing t1: %q", line)
			}
			break
		}
	}
	hub.Publish(taskhub.Task{"id": "t2", "status": "succeeded"})
	seenTask := false
	seenBeat := false
	for scanner.Scan() {
		line := scanner.Text()
		if strings.Contains(line, `"t2"`) {
			seenTask = true
		}
		if line == ": heartbeat" {
			seenBeat = true
		}
		if seenTask && seenBeat {
			break
		}
	}
	if !seenTask || !seenBeat {
		t.Fatalf("seenTask=%v seenBeat=%v", seenTask, seenBeat)
	}
}
