package webuiplugintrustapi

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

type fakeAuthorizer struct {
	allowed bool
}

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

func newTrustServer(t *testing.T, allowed bool) (*httptest.Server, string) {
	t.Helper()
	home := t.TempDir()
	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: allowed},
		AIHomeDir:  home,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle(TrustedPath, handler)
	mux.Handle(TrustPath, handler)
	mux.Handle(UntrustPath, handler)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server, home
}

func trustFilePath(home string) string {
	return filepath.Join(home, "plugins", "trusted-keys.json")
}

func generateEd25519PEM(t *testing.T) string {
	t.Helper()
	publicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("生成 Ed25519 密钥失败: %v", err)
	}
	der, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		t.Fatalf("编码 Ed25519 公钥失败: %v", err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

func keyIDOf(pemText string) string {
	digest := sha256.Sum256([]byte(pemText))
	return hex.EncodeToString(digest[:])[:24]
}

func requestJSON(t *testing.T, method string, url string, body any) (int, map[string]any) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		document, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("编码请求体失败: %v", err)
		}
		reader = bytes.NewReader(document)
	}
	request, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("读取响应失败: %v", err)
	}
	var payload map[string]any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatalf("响应不是 JSON: %s (%v)", raw, err)
		}
	}
	return response.StatusCode, payload
}

type trustFileRecord struct {
	PublicKeyPEM string `json:"publicKeyPem"`
	AddedAt      string `json:"addedAt"`
}

type trustFileDocument struct {
	SchemaVersion int                        `json:"schemaVersion"`
	Keys          map[string]trustFileRecord `json:"keys"`
}

func readTrustFile(t *testing.T, home string) (string, trustFileDocument) {
	t.Helper()
	raw, err := os.ReadFile(trustFilePath(home))
	if err != nil {
		t.Fatalf("读取信任根文件失败: %v", err)
	}
	var document trustFileDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatalf("信任根文件不是合法 JSON: %v (%s)", err, raw)
	}
	return string(raw), document
}

func requireKeysLen(t *testing.T, payload map[string]any, want int) []any {
	t.Helper()
	keys, ok := payload["keys"].([]any)
	if !ok {
		t.Fatalf("keys 不是数组: %#v", payload["keys"])
	}
	if len(keys) != want {
		t.Fatalf("keys 长度 = %d, want %d (%#v)", len(keys), want, keys)
	}
	return keys
}

// TestTrustListUntrustLifecycle 覆盖 trust → list → untrust 全链路，并锁住
// 文件权限（0600 / 0700）、schemaVersion、addedAt 格式与空列表形状。
func TestTrustListUntrustLifecycle(t *testing.T) {
	server, home := newTrustServer(t, true)
	pemText := generateEd25519PEM(t)

	status, payload := requestJSON(t, http.MethodPost, server.URL+TrustPath, map[string]any{"publicKey": pemText})
	if status != http.StatusOK {
		t.Fatalf("trust status = %d body=%#v", status, payload)
	}
	wantKeyID := keyIDOf(pemText)
	if payload["ok"] != true || payload["keyId"] != wantKeyID || payload["fingerprint"] != wantKeyID {
		t.Fatalf("trust payload = %#v, want keyId=fingerprint=%s", payload, wantKeyID)
	}
	if payload["file"] != trustFilePath(home) {
		t.Fatalf("file = %v, want %s", payload["file"], trustFilePath(home))
	}

	// 目录 0700 / 文件 0600：签名信任根不能被同机其它用户改写。
	directoryInfo, err := os.Stat(filepath.Join(home, "plugins"))
	if err != nil {
		t.Fatalf("stat 插件目录失败: %v", err)
	}
	if permission := directoryInfo.Mode().Perm(); permission != 0o700 {
		t.Fatalf("插件目录权限 = %o, want 700", permission)
	}
	fileInfo, err := os.Stat(trustFilePath(home))
	if err != nil {
		t.Fatalf("stat 信任根文件失败: %v", err)
	}
	if permission := fileInfo.Mode().Perm(); permission != 0o600 {
		t.Fatalf("信任根文件权限 = %o, want 600", permission)
	}

	raw, document := readTrustFile(t, home)
	if document.SchemaVersion != 1 {
		t.Fatalf("schemaVersion = %d, want 1", document.SchemaVersion)
	}
	record, ok := document.Keys[wantKeyID]
	if !ok {
		t.Fatalf("文件里没有 %s: %s", wantKeyID, raw)
	}
	if record.PublicKeyPEM != pemText {
		t.Fatalf("文件里的 PEM 与归一结果不一致: %q vs %q", record.PublicKeyPEM, pemText)
	}
	if !regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`).MatchString(record.AddedAt) {
		t.Fatalf("addedAt 不是 JS toISOString 形状: %q", record.AddedAt)
	}
	if !strings.HasPrefix(raw, "{\n  \"schemaVersion\": 1,\n  \"keys\": {\n") {
		t.Fatalf("文件不是 JSON.stringify(_, null, 2) 形状: %s", raw)
	}

	status, payload = requestJSON(t, http.MethodGet, server.URL+TrustedPath, nil)
	if status != http.StatusOK {
		t.Fatalf("list status = %d body=%#v", status, payload)
	}
	keys := requireKeysLen(t, payload, 1)
	entry := keys[0].(map[string]any)
	if entry["keyId"] != wantKeyID || entry["fingerprint"] != wantKeyID || entry["algorithm"] != "ed25519" {
		t.Fatalf("list entry = %#v", entry)
	}

	status, payload = requestJSON(t, http.MethodPost, server.URL+UntrustPath, map[string]any{"keyId": wantKeyID})
	if status != http.StatusOK {
		t.Fatalf("untrust status = %d body=%#v", status, payload)
	}
	if payload["removed"] != true || payload["keyId"] != wantKeyID {
		t.Fatalf("untrust payload = %#v", payload)
	}

	status, payload = requestJSON(t, http.MethodGet, server.URL+TrustedPath, nil)
	if status != http.StatusOK {
		t.Fatalf("list(empty) status = %d body=%#v", status, payload)
	}
	// 空数组不能退化成 null：WebUI 直接读 payload.keys.length。
	requireKeysLen(t, payload, 0)

	_, document = readTrustFile(t, home)
	if len(document.Keys) != 0 {
		t.Fatalf("撤销后仍有记录: %#v", document.Keys)
	}
	if leftovers, _ := filepath.Glob(trustFilePath(home) + ".*.tmp"); len(leftovers) != 0 {
		t.Fatalf("遗留临时文件: %v", leftovers)
	}
}

// TestDuplicateTrustIsIdempotent 验证重复登记同一把公钥只留一条记录。
func TestDuplicateTrustIsIdempotent(t *testing.T) {
	server, home := newTrustServer(t, true)
	pemText := generateEd25519PEM(t)

	for index := 0; index < 2; index++ {
		status, payload := requestJSON(t, http.MethodPost, server.URL+TrustPath, map[string]any{
			"publicKey": "\n" + pemText + "\n",
		})
		if status != http.StatusOK {
			t.Fatalf("第 %d 次 trust status = %d body=%#v", index+1, status, payload)
		}
	}
	_, document := readTrustFile(t, home)
	if len(document.Keys) != 1 {
		t.Fatalf("重复 trust 后 keys = %d, want 1", len(document.Keys))
	}
	if _, ok := document.Keys[keyIDOf(pemText)]; !ok {
		t.Fatalf("默认 keyId 不是 sha256(PEM) 前 24 位: %#v", document.Keys)
	}
}

// TestTrustKeyIDAndPublicKeyPemFallback 验证显式 keyId 保留、publicKeyPem 回落。
func TestTrustKeyIDAndPublicKeyPemFallback(t *testing.T) {
	server, home := newTrustServer(t, true)
	pemText := generateEd25519PEM(t)

	status, payload := requestJSON(t, http.MethodPost, server.URL+TrustPath, map[string]any{
		"publicKeyPem": pemText,
		"keyId":        "dev-key",
	})
	if status != http.StatusOK {
		t.Fatalf("trust status = %d body=%#v", status, payload)
	}
	if payload["keyId"] != "dev-key" || payload["fingerprint"] != keyIDOf(pemText) {
		t.Fatalf("payload = %#v", payload)
	}
	_, document := readTrustFile(t, home)
	if _, ok := document.Keys["dev-key"]; !ok {
		t.Fatalf("显式 keyId 未写入: %#v", document.Keys)
	}
}

// TestInvalidPublicKey 覆盖空、非 PEM、RSA、ECDSA 四类公钥。
func TestInvalidPublicKey(t *testing.T) {
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("生成 RSA 密钥失败: %v", err)
	}
	rsaPEM := string(pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PUBLIC KEY",
		Bytes: x509.MarshalPKCS1PublicKey(&rsaKey.PublicKey),
	}))
	ecdsaKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("生成 ECDSA 密钥失败: %v", err)
	}
	der, err := x509.MarshalPKIXPublicKey(&ecdsaKey.PublicKey)
	if err != nil {
		t.Fatalf("编码 ECDSA 公钥失败: %v", err)
	}
	ecdsaPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))

	tests := []struct {
		name    string
		input   string
		message string
	}{
		{name: "空公钥", input: "   ", message: "公钥不能为空"},
		{name: "非 PEM", input: "ssh-ed25519 AAAA", message: "公钥不是合法的 Ed25519 PEM"},
		{name: "RSA", input: rsaPEM, message: "只支持 Ed25519 公钥"},
		{name: "ECDSA", input: ecdsaPEM, message: "只支持 Ed25519 公钥"},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			server, home := newTrustServer(t, true)
			status, payload := requestJSON(t, http.MethodPost, server.URL+TrustPath, map[string]any{
				"publicKey": testCase.input,
			})
			if status != http.StatusBadRequest {
				t.Fatalf("status = %d body=%#v", status, payload)
			}
			if payload["error"] != CodeSignatureKeyInvalid || payload["message"] != testCase.message {
				t.Fatalf("payload = %#v", payload)
			}
			// Node writeError 的领域错误固定带 diagnostics: []，Node 代理层会原样透传。
			if diagnostics, ok := payload["diagnostics"].([]any); !ok || len(diagnostics) != 0 {
				t.Fatalf("diagnostics = %#v, want []", payload["diagnostics"])
			}
			if _, err := os.Stat(trustFilePath(home)); !os.IsNotExist(err) {
				t.Fatalf("非法公钥不应写文件: %v", err)
			}
		})
	}
}

// TestInvalidKeyID 验证 keyId 字符集与首字符规则。
func TestInvalidKeyID(t *testing.T) {
	server, _ := newTrustServer(t, true)
	pemText := generateEd25519PEM(t)
	for _, keyID := range []string{"bad key", "-leading", "trailing!", strings.Repeat("a", 129)} {
		status, payload := requestJSON(t, http.MethodPost, server.URL+TrustPath, map[string]any{
			"publicKey": pemText,
			"keyId":     keyID,
		})
		if status != http.StatusBadRequest || payload["error"] != CodeSignatureKeyIDInvalid {
			t.Fatalf("keyId %q: status=%d body=%#v", keyID, status, payload)
		}
	}
}

// TestCorruptStoreIsError 验证坏 JSON 是领域错误，且不会覆盖原文件。
func TestCorruptStoreIsError(t *testing.T) {
	server, home := newTrustServer(t, true)
	file := trustFilePath(home)
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	corrupt := []byte(`{"schemaVersion":1,"keys":`)
	if err := os.WriteFile(file, corrupt, 0o600); err != nil {
		t.Fatalf("写入坏文件失败: %v", err)
	}

	status, payload := requestJSON(t, http.MethodGet, server.URL+TrustedPath, nil)
	if status != http.StatusBadRequest || payload["error"] != CodeTrustStoreInvalid {
		t.Fatalf("list: status=%d body=%#v", status, payload)
	}
	if message, _ := payload["message"].(string); !strings.Contains(message, file) {
		t.Fatalf("错误消息应包含文件路径: %#v", payload)
	}

	status, payload = requestJSON(t, http.MethodPost, server.URL+TrustPath, map[string]any{
		"publicKey": generateEd25519PEM(t),
	})
	if status != http.StatusBadRequest || payload["error"] != CodeTrustStoreInvalid {
		t.Fatalf("trust: status=%d body=%#v", status, payload)
	}
	after, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("读取文件失败: %v", err)
	}
	if !bytes.Equal(after, corrupt) {
		t.Fatalf("坏文件被覆盖了: %s", after)
	}
}

// TestBadEntriesAreSkipped 验证坏条目跳过、好条目保留，且重写时坏条目被清掉。
func TestBadEntriesAreSkipped(t *testing.T) {
	server, home := newTrustServer(t, true)
	goodPEM := generateEd25519PEM(t)
	secondPEM := generateEd25519PEM(t)
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("生成 RSA 密钥失败: %v", err)
	}
	rsaPEM := string(pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PUBLIC KEY",
		Bytes: x509.MarshalPKCS1PublicKey(&rsaKey.PublicKey),
	}))
	file := trustFilePath(home)
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	document := map[string]any{
		"schemaVersion": 1,
		"keys": map[string]any{
			"alpha":   map[string]any{"publicKeyPem": goodPEM, "addedAt": "2026-01-01T00:00:00.000Z"},
			"bad key": map[string]any{"publicKeyPem": goodPEM},
			"no-pem":  map[string]any{"addedAt": "2026-01-01T00:00:00.000Z"},
			"rsa":     map[string]any{"publicKeyPem": rsaPEM},
			"number":  map[string]any{"publicKeyPem": 42},
		},
	}
	raw, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("编码测试文件失败: %v", err)
	}
	if err := os.WriteFile(file, raw, 0o600); err != nil {
		t.Fatalf("写入测试文件失败: %v", err)
	}

	status, payload := requestJSON(t, http.MethodGet, server.URL+TrustedPath, nil)
	if status != http.StatusOK {
		t.Fatalf("list status = %d body=%#v", status, payload)
	}
	keys := requireKeysLen(t, payload, 1)
	if keys[0].(map[string]any)["keyId"] != "alpha" {
		t.Fatalf("keys = %#v", keys)
	}

	status, payload = requestJSON(t, http.MethodPost, server.URL+TrustPath, map[string]any{"publicKey": secondPEM})
	if status != http.StatusOK {
		t.Fatalf("trust status = %d body=%#v", status, payload)
	}
	_, written := readTrustFile(t, home)
	if len(written.Keys) != 2 {
		t.Fatalf("重写后应只剩好条目 + 新条目: %#v", written.Keys)
	}
	if _, ok := written.Keys["alpha"]; !ok {
		t.Fatalf("好条目丢了: %#v", written.Keys)
	}
	if _, ok := written.Keys[keyIDOf(secondPEM)]; !ok {
		t.Fatalf("新条目没写入: %#v", written.Keys)
	}
}

// TestUntrustUnknownKeyDoesNotRewrite 验证不存在的 keyId 是 no-op（文件不变）。
func TestUntrustUnknownKeyDoesNotRewrite(t *testing.T) {
	server, home := newTrustServer(t, true)
	pemText := generateEd25519PEM(t)
	if status, payload := requestJSON(t, http.MethodPost, server.URL+TrustPath, map[string]any{"publicKey": pemText}); status != http.StatusOK {
		t.Fatalf("trust status = %d body=%#v", status, payload)
	}
	before, err := os.ReadFile(trustFilePath(home))
	if err != nil {
		t.Fatalf("读取文件失败: %v", err)
	}
	status, payload := requestJSON(t, http.MethodPost, server.URL+UntrustPath, map[string]any{"keyId": "missing"})
	if status != http.StatusOK || payload["removed"] != false {
		t.Fatalf("untrust: status=%d body=%#v", status, payload)
	}
	after, err := os.ReadFile(trustFilePath(home))
	if err != nil {
		t.Fatalf("读取文件失败: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Fatalf("不存在的 keyId 不应重写文件: %s vs %s", before, after)
	}
}

// TestUntrustEmptyKeyID 验证空 keyId 的错误码与 Node PluginError 默认 message。
func TestUntrustEmptyKeyID(t *testing.T) {
	server, _ := newTrustServer(t, true)
	status, payload := requestJSON(t, http.MethodPost, server.URL+UntrustPath, map[string]any{"keyId": "  "})
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d body=%#v", status, payload)
	}
	if payload["error"] != CodeSignatureKeyIDInvalid || payload["message"] != CodeSignatureKeyIDInvalid {
		t.Fatalf("payload = %#v", payload)
	}
}

// TestUnauthorized 验证没有管理密钥时不读不写。
func TestUnauthorized(t *testing.T) {
	server, home := newTrustServer(t, false)
	for _, testCase := range []struct {
		method string
		path   string
		body   any
	}{
		{method: http.MethodGet, path: TrustedPath},
		{method: http.MethodPost, path: TrustPath, body: map[string]any{"publicKey": "x"}},
		{method: http.MethodPost, path: UntrustPath, body: map[string]any{"keyId": "x"}},
	} {
		status, payload := requestJSON(t, testCase.method, server.URL+testCase.path, testCase.body)
		if status != http.StatusUnauthorized || payload["error"] != "unauthorized" {
			t.Fatalf("%s %s: status=%d body=%#v", testCase.method, testCase.path, status, payload)
		}
		// 鉴权错误与 Node 一样只有 ok/error，不带 message 与 diagnostics。
		for _, field := range []string{"message", "diagnostics"} {
			if _, exists := payload[field]; exists {
				t.Fatalf("401 不应带 %s: %#v", field, payload)
			}
		}
	}
	if _, err := os.Stat(trustFilePath(home)); !os.IsNotExist(err) {
		t.Fatalf("未鉴权请求不应创建文件: %v", err)
	}
}

// TestMethodNotAllowed 验证错误方法返回 405 与 Allow。
func TestMethodNotAllowed(t *testing.T) {
	server, _ := newTrustServer(t, true)
	response, err := http.Post(server.URL+TrustedPath, "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusMethodNotAllowed || response.Header.Get("Allow") != http.MethodGet {
		t.Fatalf("status=%d allow=%q", response.StatusCode, response.Header.Get("Allow"))
	}
	response, err = http.Get(server.URL + TrustPath)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusMethodNotAllowed || response.Header.Get("Allow") != http.MethodPost {
		t.Fatalf("status=%d allow=%q", response.StatusCode, response.Header.Get("Allow"))
	}
}

// TestRootShapeLooksLikeEmptyStore 验证语法合法但根不是对象时按空信任根处理（与 Node 一致）。
func TestRootShapeLooksLikeEmptyStore(t *testing.T) {
	server, home := newTrustServer(t, true)
	file := trustFilePath(home)
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	if err := os.WriteFile(file, []byte("[]"), 0o600); err != nil {
		t.Fatalf("写入文件失败: %v", err)
	}
	status, payload := requestJSON(t, http.MethodGet, server.URL+TrustedPath, nil)
	if status != http.StatusOK {
		t.Fatalf("status = %d body=%#v", status, payload)
	}
	requireKeysLen(t, payload, 0)
}

// TestKeysAreSortedInFile 验证写入按 keyId 排序。
func TestKeysAreSortedInFile(t *testing.T) {
	server, home := newTrustServer(t, true)
	for _, keyID := range []string{"gamma", "alpha", "beta"} {
		status, payload := requestJSON(t, http.MethodPost, server.URL+TrustPath, map[string]any{
			"publicKey": generateEd25519PEM(t),
			"keyId":     keyID,
		})
		if status != http.StatusOK {
			t.Fatalf("trust %s: status=%d body=%#v", keyID, status, payload)
		}
	}
	raw, _ := readTrustFile(t, home)
	alpha := strings.Index(raw, "\"alpha\"")
	beta := strings.Index(raw, "\"beta\"")
	gamma := strings.Index(raw, "\"gamma\"")
	if alpha < 0 || beta < 0 || gamma < 0 || !(alpha < beta && beta < gamma) {
		t.Fatalf("文件键顺序不是 alpha<beta<gamma: %s", raw)
	}
}
