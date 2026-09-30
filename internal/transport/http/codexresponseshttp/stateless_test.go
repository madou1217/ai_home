package codexresponseshttp

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

type countingUpstream struct{ calls int }

func (upstream *countingUpstream) RoundTripNative(context.Context, accountapp.Credential, []byte, http.Header, string) (*http.Response, error) {
	upstream.calls++
	return nil, errors.New("synthetic upstream")
}

// ChatGPT 登录账号的上游只接受 codex CLI 形状的请求：stream=true、store 非 true、input 为列表、
// 无 previous_response_id。其他形状原样发出必然 400（真实故障："Store must be set to false"、
// "Input must be a list"、"Stream must be set to true"），必须交回 Node 归一化。
func TestChatGPTCredentialsOnlyPassThroughCodexShapedRequests(t *testing.T) {
	claims := base64.RawURLEncoding.EncodeToString([]byte(`{"https://api.openai.com/auth":{"chatgpt_user_id":"user-1","chatgpt_account_id":"account-1"}}`))
	idToken := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`)) + "." + claims + ".signature"
	oauth, err := codexauth.NewOAuthAuth(codexauth.OAuthInput{AccessToken: "oauth-access", RefreshToken: "oauth-refresh", IDToken: idToken, RefreshedAtMS: 1})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name        string
		payload     string
		passthrough bool
	}{
		{"codex shaped", `{"model":"gpt-native","stream":true,"store":false,"input":[]}`, true},
		{"store true", `{"model":"gpt-native","stream":true,"store":true,"input":[]}`, false},
		{"string input", `{"model":"gpt-native","stream":true,"input":"hi"}`, false},
		{"not streaming", `{"model":"gpt-native","input":[]}`, false},
		{"chained", `{"model":"gpt-native","stream":true,"store":false,"previous_response_id":"resp_old","input":[]}`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			handler, _, source := fixture(t, "http://upstream.invalid", 1)
			source.selections[0].Credential = oauth
			upstream := &countingUpstream{}
			handler.Upstream = upstream
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, nativeRequestFor([]byte(tc.payload)))
			if tc.passthrough && upstream.calls != 1 {
				t.Fatalf("codex-shaped request was not passed through: calls=%d status=%d", upstream.calls, response.Code)
			}
			// 交回 Node 的约定：带 X-AIH-Decode-Rejected 的 400，且未联系上游（Node 才能安全重放）。
			if !tc.passthrough && (upstream.calls != 0 || response.Code != http.StatusBadRequest || response.Header().Get(inferenceapi.DecodeRejectedHeader) != "1") {
				t.Fatalf("request should be handed to Node: calls=%d status=%d", upstream.calls, response.Code)
			}
		})
	}
}
