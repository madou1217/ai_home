package responses

import (
	"bytes"
	"context"
	"net/http"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/internal/adapters/codex/codexidentity"
)

const NativeHopHeader = "X-Aih-Codex-Relay-Hop"

func (adapter *Adapter) RoundTripNative(ctx context.Context, credential accountapp.Credential, payload []byte, header http.Header, localAuthority string) (*http.Response, error) {
	auth, err := projectAuth(credential)
	if err != nil || adapter == nil || adapter.client == nil {
		return nil, ErrInvalidInvocation
	}
	endpoint, err := responsesEndpoint(auth.baseURL)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil || request.URL.User != nil || (request.URL.Scheme != "https" && request.URL.Scheme != "http") || strings.EqualFold(request.URL.Host, localAuthority) || len(header.Values(NativeHopHeader)) != 0 {
		return nil, ErrInvalidInvocation
	}
	auth.clientVersion = adapter.versions.Current()
	if err := applyAuthenticationHeaders(request, auth); err != nil {
		return nil, err
	}
	if identity, ok := codexidentity.ClientHeaders(header); ok {
		request.Header.Del("Version")
		for name, values := range identity {
			request.Header[name] = values
		}
	}
	for _, name := range []string{"Content-Type", "Content-Encoding", "Accept", "OpenAI-Beta", "X-Client-Request-Id", "Session-Id", "Thread-Id", "X-Codex-Routing-Hint", "Traceparent", "Tracestate"} {
		if value, ok := codexidentity.SingleSafeHeader(header, name); ok {
			request.Header.Set(name, value)
		}
	}
	request.Header.Set(NativeHopHeader, "1")
	return adapter.client.Do(request)
}
