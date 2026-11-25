package acpclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHTTPToolClientSendsTokenAndParsesContent(t *testing.T) {
	var gotToken string
	var gotName string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		gotToken = request.Header.Get("X-AIH-Remote-Tools-Token")
		var body struct {
			Name string `json:"name"`
		}
		_ = json.NewDecoder(request.Body).Decode(&body)
		gotName = body.Name
		_ = json.NewEncoder(response).Encode(map[string]any{
			"content": []any{map[string]any{"type": "text", "text": "version: v1\nlines: 1-1 / 1\n1|hello"}},
		})
	}))
	defer server.Close()

	client := NewHTTPToolClient(server.URL, "tool-secret", server.Client())
	result, err := client.Call(context.Background(), "read_file", map[string]any{"path": "a.txt"})
	if err != nil {
		t.Fatalf("Call() error = %v", err)
	}
	if gotToken != "tool-secret" || gotName != "read_file" {
		t.Fatalf("token=%q name=%q", gotToken, gotName)
	}
	if !strings.Contains(result.Text, "hello") {
		t.Fatalf("text = %q", result.Text)
	}
}

func TestHTTPToolClientRejectsHTTPError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		http.Error(response, "offline", http.StatusConflict)
	}))
	defer server.Close()
	client := NewHTTPToolClient(server.URL, "x", server.Client())
	if _, err := client.Call(context.Background(), "read_file", nil); err == nil {
		t.Fatalf("HTTP error should fail")
	}
}
