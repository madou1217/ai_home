package codeassist

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/accounts/agy"
)

func TestLoadProjectUsesAgyHeadersAndStrictResponse(t *testing.T) {
	t.Parallel()

	client := recordingClient{do: func(request *http.Request) (*http.Response, error) {
		if request.URL.String() != defaultBaseURL+":loadCodeAssist" ||
			request.Header.Get("Authorization") != "Bearer access-secret" ||
			request.Header.Get("x-client-name") != "antigravity" ||
			request.Header.Get("x-client-version") == "" ||
			request.Header.Get("x-vscode-sessionid") == "" ||
			request.Header.Get("User-Agent") == "" {
			t.Fatalf("request = %s %#v", request.URL, request.Header)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": {"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"cloudaicompanionProject":"project-123"}`)),
		}, nil
	}}
	project, err := loadProject(context.Background(), client, testAgyAuth(t))
	if err != nil {
		t.Fatalf("loadProject() error = %v", err)
	}
	if project != "project-123" {
		t.Fatalf("project = %q", project)
	}
}

func testAgyAuth(t *testing.T) *agy.OAuthAuth {
	t.Helper()
	auth, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         "agy@example.com",
		AccessToken:   "access-secret",
		RefreshToken:  "refresh-secret",
		ExpiresAtMS:   fixedClock().Add(10_000_000_000).UnixMilli(),
		RefreshedAtMS: fixedClock().UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	return auth
}

type recordingClient struct {
	do func(*http.Request) (*http.Response, error)
}

func (client recordingClient) Do(request *http.Request) (*http.Response, error) {
	return client.do(request)
}
