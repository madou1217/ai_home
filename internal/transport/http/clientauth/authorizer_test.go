package clientauth_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/madou1217/ai_home/internal/transport/http/clientauth"
)

const testClientKey = "synthetic-client-auth-key-2026-07-30"

// TestAuthorizerAcceptsExactlyOneStandardClientHeader 验证 OpenAI Bearer、
// Anthropic x-api-key 和歧义拒绝规则。
func TestAuthorizerAcceptsExactlyOneStandardClientHeader(t *testing.T) {
	t.Parallel()

	authorizer, err := clientauth.NewAuthorizer(
		func() string { return testClientKey },
	)
	if err != nil {
		t.Fatalf("NewAuthorizer() error = %v", err)
	}
	testCases := []struct {
		name          string
		authorization []string
		apiKeys       []string
		want          bool
	}{
		{
			name:          "bearer",
			authorization: []string{"Bearer " + testClientKey},
			want:          true,
		},
		{
			name:    "anthropic",
			apiKeys: []string{testClientKey},
			want:    true,
		},
		{
			name:          "both",
			authorization: []string{"Bearer " + testClientKey},
			apiKeys:       []string{testClientKey},
		},
		{
			name:    "wrong",
			apiKeys: []string{"synthetic-wrong-client-key-2026"},
		},
		{
			name:    "whitespace",
			apiKeys: []string{testClientKey + " "},
		},
	}
	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			request := httptest.NewRequest(http.MethodPost, "/", nil)
			for _, value := range testCase.authorization {
				request.Header.Add("Authorization", value)
			}
			for _, value := range testCase.apiKeys {
				request.Header.Add("x-api-key", value)
			}
			if got := authorizer.Authorized(request); got != testCase.want {
				t.Fatalf("Authorized() = %t, want %t", got, testCase.want)
			}
		})
	}
}
