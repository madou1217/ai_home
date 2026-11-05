package qoderrelay

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/qodercred"
	"github.com/madou1217/ai_home/internal/adapters/qoder/modelcatalog"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

// fakeSigner 返回固定的签名结果；单测不碰 wasm。
type fakeSigner struct {
	contexts int
	body     string
	url      string
}

func (signer *fakeSigner) NewContext(context.Context, string, string, string) (uint32, error) {
	signer.contexts++
	return 5, nil
}

func (signer *fakeSigner) PrepareInferRequest(
	_ context.Context, _ uint32, endpoint, bodyJSON, _, _ string,
) (qodercred.PreparedRequest, error) {
	signer.body = bodyJSON
	return qodercred.PreparedRequest{
		URL:     endpoint + "/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1",
		Headers: map[string]string{"Authorization": "Bearer signed", "Cosy-Version": "1.1.81"},
		Body:    "ENCODED-" + bodyJSON,
	}, nil
}

func (*fakeSigner) FreeContext(uint32) {}

func installFakes(t *testing.T) *fakeSigner {
	t.Helper()
	signer := &fakeSigner{url: "https://openapi.qoder.sh"}
	previousSigner, previousEntries := newSigner, cachedEntries
	previousDecrypt, previousVersion := decryptNative, cliVersion
	newSigner = func(string) (Signer, error) { return signer, nil }
	cachedEntries = func(string, map[string]any) ([]modelcatalog.Entry, bool) {
		return []modelcatalog.Entry{{
			Key: "auto", DisplayName: "Auto", Format: "openai", Source: "system",
			IsVl: true, MaxInputTokens: 200000,
		}, {
			Key: "qfmodel", DisplayName: "Qwen3.8-Flash", Format: "openai", Source: "system",
			IsReasoning: true, MaxInputTokens: 128000,
		}}, true
	}
	decryptNative = func(string, map[string]any, qodercred.Options) (string, bool) {
		return `{"uid":"uid-1","security_oauth_token":"token"}`, true
	}
	cliVersion = func(string, qodercred.Options) string { return "1.1.81" }
	t.Cleanup(func() {
		newSigner = previousSigner
		cachedEntries = previousEntries
		decryptNative = previousDecrypt
		cliVersion = previousVersion
	})
	return signer
}

func nativeCredential(t *testing.T, providerID string) *accountcore.NativeCredential {
	t.Helper()
	identity, err := accountcore.NewNativeQoderIdentity(providerID, "uid-1")
	if err != nil {
		t.Fatalf("构造身份失败: %v", err)
	}
	payload, err := json.Marshal(map[string]any{
		"credentials": "opaque", "machineId": "11111111-2222-3333-4444-555555555555",
	})
	if err != nil {
		t.Fatalf("编码 payload 失败: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, payload)
	if err != nil {
		t.Fatalf("构造凭据失败: %v", err)
	}
	return credential
}

func TestResolveClaimsQoderFamily(t *testing.T) {
	provider := NewProvider()
	for _, providerID := range []string{"qoder", "qodercn", " QODER "} {
		resolved, ok := provider.Resolve(relaycore.ResolveInput{
			ProviderID: providerID,
			Credential: nativeCredential(t, "qoder"),
		})
		if !ok {
			t.Fatalf("Resolve(%q) 未认领", providerID)
		}
		if _, ok := resolved.(*Provider); !ok {
			t.Fatalf("Resolve(%q) 返回类型 %T", providerID, resolved)
		}
	}
	if _, ok := provider.Resolve(relaycore.ResolveInput{ProviderID: "cline", Credential: nativeCredential(t, "qoder")}); ok {
		t.Fatal("不应认领 cline")
	}
}

func TestRewriteRequestSignsAndCompresses(t *testing.T) {
	signer := installFakes(t)
	provider := &Provider{BaseProvider: relaycore.NewBaseProvider("qoder", ""), providerID: "qoder", credential: nativeCredential(t, "qoder")}
	body := []byte(`{"model":"Qwen3.8-Flash","stream":true,"messages":[{"role":"user","content":"ping"}]}`)
	rewritten, err := provider.RewriteRequest(body)
	if err != nil {
		t.Fatalf("RewriteRequest() error = %v", err)
	}
	if signer.contexts != 1 {
		t.Fatalf("NewContext calls = %d, want 1", signer.contexts)
	}
	if !strings.Contains(signer.body, `"qfmodel"`) {
		t.Fatalf("签名 body 未使用目录 key: %s", signer.body)
	}
	decoder, err := zstd.NewReader(nil)
	if err != nil {
		t.Fatalf("zstd reader: %v", err)
	}
	decoded, err := decoder.DecodeAll(rewritten.Body, nil)
	if err != nil {
		t.Fatalf("解压失败: %v", err)
	}
	if string(decoded) != "ENCODED-"+signer.body {
		t.Fatalf("压缩内容不对: %s", decoded)
	}
	endpoint, ok := provider.Endpoint()
	if !ok || !strings.HasPrefix(endpoint, "https://") || !strings.Contains(endpoint, "/algo/api/v2/service/pro/sse/agent_chat_generation") {
		t.Fatalf("Endpoint() = %q, %v", endpoint, ok)
	}
	request, _ := http.NewRequest(http.MethodPost, endpoint, nil)
	provider.DecorateUpstream(request, "")
	if request.Header.Get("Content-Encoding") != "zstd" {
		t.Fatalf("缺少 Content-Encoding: %v", request.Header)
	}
	if request.Header.Get("Authorization") != "Bearer signed" {
		t.Fatalf("缺少签名头: %v", request.Header)
	}
}

func TestRewriteRequestFailsClosedWithoutCatalog(t *testing.T) {
	installFakes(t)
	cachedEntries = func(string, map[string]any) ([]modelcatalog.Entry, bool) { return nil, false }
	provider := &Provider{BaseProvider: relaycore.NewBaseProvider("qoder", ""), providerID: "qoder", credential: nativeCredential(t, "qoder")}
	_, err := provider.RewriteRequest([]byte(`{"model":"Qwen3.8-Flash","messages":[{"role":"user","content":"ping"}]}`))
	if !errors.Is(err, ErrModelCatalogUnavailable) {
		t.Fatalf("error = %v, want ErrModelCatalogUnavailable", err)
	}
}

func TestRewriteRequestRejectsUnknownModel(t *testing.T) {
	installFakes(t)
	provider := &Provider{BaseProvider: relaycore.NewBaseProvider("qoder", ""), providerID: "qoder", credential: nativeCredential(t, "qoder")}
	_, err := provider.RewriteRequest([]byte(`{"model":"not-in-catalog","messages":[{"role":"user","content":"ping"}]}`))
	if err == nil {
		t.Fatal("期望拒绝目录外模型")
	}
}

func TestTransformResponseStreamsUnwrappedChunks(t *testing.T) {
	installFakes(t)
	provider := &Provider{BaseProvider: relaycore.NewBaseProvider("qoder", ""), providerID: "qoder", requestModel: "Qwen3.8-Flash"}
	upstreamBody := strings.Join([]string{
		`data: {"statusCodeValue":200,"body":"{\"id\":\"c1\",\"model\":\"qwen-internal\",\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}"}`,
		"",
		"data: [DONE]",
		"",
	}, "\n")
	upstream := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader(upstreamBody)),
	}
	recorder := httptest.NewRecorder()
	handled, err := provider.TransformResponse(recorder, upstream, true)
	if !handled || err != nil {
		t.Fatalf("TransformResponse() = %v, %v", handled, err)
	}
	output := recorder.Body.String()
	if !strings.Contains(output, `"content":"hi"`) {
		t.Fatalf("缺少内层 chunk: %s", output)
	}
	if !strings.Contains(output, `"model":"Qwen3.8-Flash"`) {
		t.Fatalf("model 未对齐: %s", output)
	}
	if !strings.Contains(output, "data: [DONE]") {
		t.Fatalf("缺少 DONE: %s", output)
	}
	if strings.Contains(output, "statusCodeValue") {
		t.Fatalf("信封未拆干净: %s", output)
	}
}
