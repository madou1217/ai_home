package modelcatalog

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/qodercred"
)

// fakeSigner 记录调用次数并返回固定签名结果；单测不能依赖本机 qoder CLI。
type fakeSigner struct {
	contextCalls int
	prepareCalls int
	decryptCalls int
	decrypted    string
}

func (signer *fakeSigner) NewContext(context.Context, string, string, string) (uint32, error) {
	signer.contextCalls++
	return 7, nil
}

func (signer *fakeSigner) PrepareRequest(
	_ context.Context, _ uint32, endpoint, path, _, _ string,
) (qodercred.PreparedRequest, error) {
	signer.prepareCalls++
	return qodercred.PreparedRequest{
		URL:     endpoint + path,
		Headers: map[string]string{"Authorization": "Bearer token", "Cosy-Version": "1.1.81"},
	}, nil
}

func (signer *fakeSigner) DecryptServerResponse(context.Context, string) (string, error) {
	signer.decryptCalls++
	return signer.decrypted, nil
}

func (*fakeSigner) FreeContext(uint32)    {}
func (*fakeSigner) Close(context.Context) {}

// withFakes 安装假签名器与假解密；测试结束自动恢复。
func withFakes(t *testing.T, decrypt func(string, map[string]any, qodercred.Options) (string, bool)) *fakeSigner {
	t.Helper()
	signer := &fakeSigner{decrypted: `{"assistant":[{"key":"auto","display_name":"Auto"}]}`}
	previousSigner, previousDecrypt, previousVersion := newSigner, decryptNative, resolveVersion
	newSigner = func(string) (Signer, error) { return signer, nil }
	decryptNative = decrypt
	resolveVersion = func(string, qodercred.Options) string { return "1.1.81" }
	t.Cleanup(func() {
		newSigner = previousSigner
		decryptNative = previousDecrypt
		resolveVersion = previousVersion
	})
	return signer
}

func nativeCredential(t *testing.T, providerID string, payload map[string]any) *accountcore.NativeCredential {
	t.Helper()
	identity, err := accountcore.NewNativeQoderIdentity(providerID, "uid-1")
	if err != nil {
		t.Fatalf("构造身份失败: %v", err)
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("编码 payload 失败: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, encoded)
	if err != nil {
		t.Fatalf("构造凭据失败: %v", err)
	}
	return credential
}

func decryptOK(string, map[string]any, qodercred.Options) (string, bool) {
	return `{"uid":"uid-1","security_oauth_token":"token"}`, true
}

func TestDiscoverModelsFromPlaintextCatalog(t *testing.T) {
	withFakes(t, decryptOK)
	var authorization string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		authorization = request.Header.Get("Authorization")
		_, _ = writer.Write([]byte(`{"assistant":[
			{"key":"auto","display_name":"Auto","is_default":true},
			{"key":"deepseek","display_name":"DeepSeek"},
			{"display_name":"没有 key 的条目要丢弃"},
			{"key":"deepseek","display_name":"DeepSeek"}
		]}`))
	}))
	defer server.Close()
	source, err := New(server.Client(), "qoder")
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	// 用 httptest 地址替换端点，避免单测打真实站点。
	source.baseURL = server.URL
	names, err := source.DiscoverModels(context.Background(), nativeCredential(t, "qoder", map[string]any{
		"credentials": "opaque", "machineId": "11111111-2222-3333-4444-555555555555",
	}))
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if strings.Join(names, ",") != "Auto,DeepSeek" {
		t.Fatalf("names = %v, want [Auto DeepSeek]", names)
	}
	if authorization != "Bearer token" {
		t.Fatalf("Authorization = %q, want Bearer token", authorization)
	}
}

func TestDiscoverModelsFallsBackToDecryptedResponse(t *testing.T) {
	signer := withFakes(t, decryptOK)
	signer.decrypted = `{"assistant":[{"key":"sonus","display_name":"Sonus"}]}`
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte("ENCODED-BYTES"))
	}))
	defer server.Close()
	source, err := New(server.Client(), "qoder")
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	source.baseURL = server.URL
	names, err := source.DiscoverModels(context.Background(), nativeCredential(t, "qoder", map[string]any{
		"credentials": "opaque", "machineId": "11111111-2222-3333-4444-555555555555",
	}))
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if len(names) != 1 || names[0] != "Sonus" {
		t.Fatalf("names = %v, want [Sonus]", names)
	}
	if signer.decryptCalls != 1 {
		t.Fatalf("DecryptServerResponse calls = %d, want 1", signer.decryptCalls)
	}
}

func TestDiscoverModelsHTTPFailure(t *testing.T) {
	withFakes(t, decryptOK)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	source, err := New(server.Client(), "qoder")
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	source.baseURL = server.URL
	_, err = source.DiscoverModels(context.Background(), nativeCredential(t, "qoder", map[string]any{
		"credentials": "opaque", "machineId": "11111111-2222-3333-4444-555555555555",
	}))
	if err == nil || !errors.Is(err, ErrEmptyCatalog) {
		t.Fatalf("error = %v, want ErrEmptyCatalog", err)
	}
}

func TestDiscoverModelsEmptyCatalog(t *testing.T) {
	withFakes(t, decryptOK)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{"assistant":[]}`))
	}))
	defer server.Close()
	source, err := New(server.Client(), "qoder")
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	source.baseURL = server.URL
	_, err = source.DiscoverModels(context.Background(), nativeCredential(t, "qoder", map[string]any{
		"credentials": "opaque", "machineId": "11111111-2222-3333-4444-555555555555",
	}))
	if !errors.Is(err, ErrEmptyCatalog) {
		t.Fatalf("error = %v, want ErrEmptyCatalog", err)
	}
}

func TestDiscoverModelsRejectsWrongProvider(t *testing.T) {
	withFakes(t, decryptOK)
	source, err := New(http.DefaultClient, "qoder")
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	_, err = source.DiscoverModels(context.Background(), nativeCredential(t, "qodercn", map[string]any{
		"credentials": "opaque", "machineId": "11111111-2222-3333-4444-555555555555",
	}))
	if !errors.Is(err, ErrUnsupportedCredential) {
		t.Fatalf("error = %v, want ErrUnsupportedCredential", err)
	}
}

func TestDecodeCatalogRejectsGarbage(t *testing.T) {
	if _, err := decodeCatalog([]byte("not-json"), func(string) (string, error) {
		return "still-not-json", nil
	}); err == nil {
		t.Fatal("期望解码失败")
	}
}
