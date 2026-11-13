package webuichatapi

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

// transformTestProvider 在基础 Provider 上补一个 ResponseTransformer：模拟 kiro 这类
// 「上游不是 OpenAI 协议」的通道。
type transformTestProvider struct {
	*testProvider
	output string
	err    error
}

func (provider *transformTestProvider) TransformResponse(
	response http.ResponseWriter,
	_ *http.Response,
	_ bool,
) (bool, error) {
	if provider.output != "" {
		_, _ = io.WriteString(response, provider.output)
	}
	return true, provider.err
}

func TestTransformStreamBridgesProviderSSE(t *testing.T) {
	provider := &transformTestProvider{
		testProvider: newTestProvider("http://example.invalid"),
		output:       "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n",
	}
	reader, handled := transformStream(provider, &http.Response{
		Body: io.NopCloser(strings.NewReader("")),
	})
	if !handled || reader == nil {
		t.Fatalf("handled = %v, reader = %v", handled, reader)
	}
	defer func() { _ = reader.Close() }()
	payload, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("ReadAll() error = %v", err)
	}
	if !strings.Contains(string(payload), "[DONE]") || !strings.Contains(string(payload), "\"hi\"") {
		t.Fatalf("payload = %q", payload)
	}
}

func TestTransformStreamSkipsPlainProviders(t *testing.T) {
	provider := newTestProvider("http://example.invalid")
	reader, handled := transformStream(provider, &http.Response{
		Body: io.NopCloser(strings.NewReader("")),
	})
	if handled || reader != nil {
		t.Fatalf("handled = %v, reader = %v", handled, reader)
	}
}

func TestTransformStreamPropagatesTransformErrors(t *testing.T) {
	provider := &transformTestProvider{
		testProvider: newTestProvider("http://example.invalid"),
		err:          errors.New("transform boom"),
	}
	reader, handled := transformStream(provider, &http.Response{
		Body: io.NopCloser(strings.NewReader("")),
	})
	if !handled || reader == nil {
		t.Fatalf("handled = %v, reader = %v", handled, reader)
	}
	defer func() { _ = reader.Close() }()
	if _, err := io.ReadAll(reader); err == nil || !strings.Contains(err.Error(), "transform boom") {
		t.Fatalf("err = %v", err)
	}
}
