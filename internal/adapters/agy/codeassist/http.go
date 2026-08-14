package codeassist

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/oauthutil"
)

const (
	defaultBaseURL  = "https://daily-cloudcode-pa.googleapis.com/v1internal"
	clientVersion   = "1.15.8"
	clientSessionID = "00000000-0000-4000-8000-000000000000"
	maxProjectBytes = 2 * 1024 * 1024
)

func loadProject(
	ctx context.Context,
	client HTTPClient,
	auth *agy.OAuthAuth,
) (string, error) {
	payload, err := json.Marshal(map[string]any{
		"metadata": map[string]string{
			"ideType":    "ANTIGRAVITY",
			"platform":   "PLATFORM_UNSPECIFIED",
			"pluginType": "GEMINI",
		},
	})
	if err != nil {
		return "", ErrInvalidDependencies
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		defaultBaseURL+":loadCodeAssist",
		strings.NewReader(string(payload)),
	)
	if err != nil {
		return "", ErrInvalidDependencies
	}
	applyHeaders(request, auth, false)
	response, err := client.Do(request)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return "", ctxErr
		}
		return "", err
	}
	if response == nil || response.Body == nil {
		return "", ErrInvalidDependencies
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK ||
		response.StatusCode >= http.StatusMultipleChoices {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return "", fmt.Errorf("AGY Code Assist load project HTTP %d", response.StatusCode)
	}
	var document struct {
		Project string `json:"cloudaicompanionProject"`
	}
	if err := oauthutil.DecodeJSONResponse(
		response.Body,
		maxProjectBytes,
		&document,
	); err != nil || !validOpaque(document.Project) {
		return "", errors.New("AGY Code Assist project 响应无效")
	}
	return document.Project, nil
}

func applyHeaders(request *http.Request, auth *agy.OAuthAuth, claudeModel bool) {
	request.Header.Set("Authorization", "Bearer "+auth.AccessToken())
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Accept-Encoding", "identity")
	request.Header.Set("User-Agent", "antigravity/"+clientVersion+" darwin/arm64")
	request.Header.Set("x-client-name", "antigravity")
	request.Header.Set("x-client-version", clientVersion)
	request.Header.Set("x-vscode-sessionid", clientSessionID)
	if claudeModel {
		request.Header.Set("anthropic-beta", "claude-code-20250219")
	}
}

func validOpaque(value string) bool {
	return value != "" && value == strings.TrimSpace(value) &&
		len(value) <= 1024 && !strings.ContainsAny(value, "\r\n\x00")
}
