package pluginartifact

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/pluginerr"
)

type testSigner struct {
	key    ed25519.PrivateKey
	keyID  string
	public string
}

func newTestSigner(t *testing.T) *testSigner {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("生成测试密钥失败: %v", err)
	}
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatalf("编码测试公钥失败: %v", err)
	}
	return &testSigner{
		key:    private,
		keyID:  "test-key",
		public: string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})),
	}
}

func (signer *testSigner) trustedKeys() map[string]string {
	return map[string]string{signer.keyID: signer.public}
}

func number(value int) json.Number {
	return json.Number(strconv.Itoa(value))
}

func validTestManifest() map[string]any {
	return map[string]any{
		"manifestVersion": number(1),
		"protocolVersion": number(1),
		"pluginId":        "aih.test.echo",
		"version":         "1.0.0",
		"engines":         map[string]any{"aih": ">=1.0.0"},
		"runtime":         "node",
		"entry":           "index.mjs",
		"contributes": []any{
			map[string]any{"id": "aih.test.echo.run", "capability": "command", "version": number(1)},
		},
	}
}

func cloneJSON(t *testing.T, value map[string]any) map[string]any {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("克隆清单失败: %v", err)
	}
	var cloned map[string]any
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.UseNumber()
	if err := decoder.Decode(&cloned); err != nil {
		t.Fatalf("克隆清单失败: %v", err)
	}
	return cloned
}

type packageOptions struct {
	signer *testSigner
	// mutateBeforeSign 在签名前修改 metadata（用于构造非法包）。
	mutateBeforeSign func(metadata map[string]any)
	// mutateAfterSign 在签名后修改 metadata（用于构造签名失效）。
	mutateAfterSign func(metadata map[string]any)
	// trailing 追加包尾字节。
	trailing []byte
}

func buildTestPackage(t *testing.T, manifest map[string]any, files map[string]string, options packageOptions) []byte {
	t.Helper()
	paths := make([]string, 0, len(files))
	for path := range files {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	records := make([]any, 0, len(paths))
	for _, path := range paths {
		content := []byte(files[path])
		digest := sha256.Sum256(content)
		records = append(records, map[string]any{
			"path":   path,
			"size":   number(len(content)),
			"sha256": hex.EncodeToString(digest[:]),
		})
	}
	metadata := map[string]any{
		"formatVersion": number(1),
		"manifest":      manifest,
		"files":         records,
	}
	if options.mutateBeforeSign != nil {
		options.mutateBeforeSign(metadata)
	}
	if options.signer != nil {
		payload, err := canonicalJSON(map[string]any{
			"formatVersion": metadata["formatVersion"],
			"manifest":      metadata["manifest"],
			"files":         metadata["files"],
		})
		if err != nil {
			t.Fatalf("规范化签名载荷失败: %v", err)
		}
		signature := ed25519.Sign(options.signer.key, payload)
		metadata["signature"] = map[string]any{
			"algorithm": "ed25519",
			"keyId":     options.signer.keyID,
			"value":     base64.StdEncoding.EncodeToString(signature),
			"signedAt":  "2026-01-01T00:00:00.000Z",
		}
	}
	if options.mutateAfterSign != nil {
		options.mutateAfterSign(metadata)
	}
	encodedMetadata, err := json.Marshal(metadata)
	if err != nil {
		t.Fatalf("编码元数据失败: %v", err)
	}
	buffer := make([]byte, 0, headerBytes+len(encodedMetadata))
	buffer = append(buffer, []byte(Magic)...)
	length := make([]byte, 4)
	binary.BigEndian.PutUint32(length, uint32(len(encodedMetadata)))
	buffer = append(buffer, length...)
	buffer = append(buffer, encodedMetadata...)
	for _, path := range paths {
		buffer = append(buffer, []byte(files[path])...)
	}
	buffer = append(buffer, options.trailing...)
	return buffer
}

func writeTestPackage(t *testing.T, data []byte) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "plugin.aih-plugin")
	if err := os.WriteFile(file, data, 0o600); err != nil {
		t.Fatalf("写入测试插件包失败: %v", err)
	}
	return file
}

func testAcceptOptions() AcceptOptions {
	return AcceptOptions{HostVersion: "1.0.0", NodeVersion: "22.14.0", Target: "darwin-arm64"}
}

func requireErrorCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("期望错误 %s，实际成功", code)
	}
	coded, ok := pluginerr.From(err)
	if !ok {
		t.Fatalf("期望领域错误 %s，实际 %v", code, err)
	}
	if coded.Code != code {
		t.Fatalf("错误码 = %s，期望 %s（%s）", coded.Code, code, coded.Message)
	}
}

func TestAcceptUnsignedArtifact(t *testing.T) {
	home := t.TempDir()
	file := writeTestPackage(t, buildTestPackage(t, validTestManifest(), map[string]string{
		"index.mjs": "export const value = 1;\n",
	}, packageOptions{}))
	acceptor, err := NewAcceptor(home)
	if err != nil {
		t.Fatalf("创建接受器失败: %v", err)
	}
	accepted, err := acceptor.Accept(file, testAcceptOptions())
	if err != nil {
		t.Fatalf("接受未签名包失败: %v", err)
	}
	if accepted.Signature.Status != "unsigned" {
		t.Fatalf("签名状态 = %s，期望 unsigned", accepted.Signature.Status)
	}
	if len(accepted.Digest) != 64 {
		t.Fatalf("digest 长度 = %d", len(accepted.Digest))
	}
	if accepted.ArtifactPath != filepath.Join(home, "plugins", "accepted", accepted.Digest+".aih-plugin") {
		t.Fatalf("artifact 路径不符: %s", accepted.ArtifactPath)
	}
	if accepted.Directory != filepath.Join(home, "plugins", "extracted", accepted.Digest) {
		t.Fatalf("解压目录不符: %s", accepted.Directory)
	}
	content, err := os.ReadFile(filepath.Join(accepted.Directory, "index.mjs"))
	if err != nil || string(content) != "export const value = 1;\n" {
		t.Fatalf("解压内容不符: %q %v", content, err)
	}
	info, err := os.Stat(filepath.Join(accepted.Directory, "index.mjs"))
	if err != nil || info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("解压文件权限未收紧: %v %v", info, err)
	}
	if accepted.PermissionsFingerprint != "" {
		t.Fatalf("无权限声明的指纹应为空: %s", accepted.PermissionsFingerprint)
	}
}

func TestAcceptSignedArtifact(t *testing.T) {
	home := t.TempDir()
	signer := newTestSigner(t)
	manifest := validTestManifest()
	manifest["permissions"] = map[string]any{
		"network":    []any{"https://api.example.com"},
		"filesystem": map[string]any{"read": []any{"state"}, "write": []any{}},
		"secrets":    []any{"api_key"},
	}
	file := writeTestPackage(t, buildTestPackage(t, manifest, map[string]string{
		"index.mjs": "export const value = 2;\n",
	}, packageOptions{signer: signer}))
	acceptor, err := NewAcceptor(home)
	if err != nil {
		t.Fatalf("创建接受器失败: %v", err)
	}
	options := testAcceptOptions()
	options.TrustedKeys = signer.trustedKeys()
	accepted, err := acceptor.Accept(file, options)
	if err != nil {
		t.Fatalf("接受已签名包失败: %v", err)
	}
	if accepted.Signature.Status != "signed" || accepted.Signature.KeyID != signer.keyID {
		t.Fatalf("签名结论不符: %+v", accepted.Signature)
	}
	if accepted.Signature.SignedAt == nil || *accepted.Signature.SignedAt != "2026-01-01T00:00:00.000Z" {
		t.Fatalf("signedAt 不符: %+v", accepted.Signature.SignedAt)
	}
	if accepted.PermissionsFingerprint == "" {
		t.Fatal("有权限声明时指纹不能为空")
	}
	// permissions 归一：缺省的 environment 补空数组，供 Node 的指纹与 enable 复用。
	permissions, ok := accepted.ManifestValue["permissions"].(normalizedPermissions)
	if !ok || permissions.Environment == nil {
		t.Fatalf("permissions.environment 未归一: %+v", accepted.ManifestValue["permissions"])
	}
	encoded, _ := json.Marshal(accepted.ManifestValue)
	if !strings.Contains(string(encoded), "\"environment\":[]") {
		t.Fatalf("归一后的清单缺少 environment: %s", encoded)
	}
	// 指纹必须按 Node 的字段序计算：network、filesystem、secrets、environment。
	canonical := `{"network":["https://api.example.com"],"filesystem":{"read":["state"],"write":[]},"secrets":["api_key"],"environment":[]}`
	digest := sha256.Sum256([]byte(canonical))
	if accepted.PermissionsFingerprint != hex.EncodeToString(digest[:])[:16] {
		t.Fatalf("权限指纹与 Node 字段序不一致: %s", accepted.PermissionsFingerprint)
	}
}

func TestAcceptRejectsInvalidArtifacts(t *testing.T) {
	signer := newTestSigner(t)
	baseFiles := map[string]string{"index.mjs": "ok\n"}
	cases := []struct {
		name    string
		data    []byte
		options AcceptOptions
		code    string
	}{
		{
			name: "内容被篡改",
			data: func() []byte {
				data := buildTestPackage(t, validTestManifest(), baseFiles, packageOptions{})
				data[len(data)-1] ^= 0xff
				return data
			}(),
			code: codePackageDigestMismatch,
		},
		{
			name: "签名与内容不匹配",
			data: buildTestPackage(t, validTestManifest(), baseFiles, packageOptions{
				signer: signer,
				mutateAfterSign: func(metadata map[string]any) {
					manifest := metadata["manifest"].(map[string]any)
					manifest["version"] = "1.0.1"
				},
			}),
			options: AcceptOptions{HostVersion: "1.0.0", NodeVersion: "22.14.0", Target: "darwin-arm64", TrustedKeys: signer.trustedKeys()},
			code:    codeSignatureInvalid,
		},
		{
			name:    "公钥不在信任根",
			data:    buildTestPackage(t, validTestManifest(), baseFiles, packageOptions{signer: signer}),
			options: AcceptOptions{HostVersion: "1.0.0", NodeVersion: "22.14.0", Target: "darwin-arm64", TrustedKeys: map[string]string{}},
			code:    codeSignatureUntrusted,
		},
		{
			name:    "要求签名但包未签名",
			data:    buildTestPackage(t, validTestManifest(), baseFiles, packageOptions{}),
			options: AcceptOptions{HostVersion: "1.0.0", NodeVersion: "22.14.0", Target: "darwin-arm64", RequireSigned: true},
			code:    codeSignatureRequired,
		},
		{
			name: "包尾多余字节",
			data: buildTestPackage(t, validTestManifest(), baseFiles, packageOptions{trailing: []byte("x")}),
			code: codePackageTrailingBytes,
		},
		{
			name: "入口文件不存在",
			data: buildTestPackage(t, validTestManifest(), map[string]string{"other.mjs": "x"}, packageOptions{}),
			code: codeEntryMissing,
		},
		{
			name: "清单不合法",
			data: func() []byte {
				manifest := validTestManifest()
				manifest["runtime"] = "deno"
				return buildTestPackage(t, manifest, baseFiles, packageOptions{})
			}(),
			code: codeManifestInvalid,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			home := t.TempDir()
			acceptor, err := NewAcceptor(home)
			if err != nil {
				t.Fatalf("创建接受器失败: %v", err)
			}
			options := testCase.options
			if options.HostVersion == "" {
				options = testAcceptOptions()
			}
			_, err = acceptor.Accept(writeTestPackage(t, testCase.data), options)
			requireErrorCode(t, err, testCase.code)
			// 失败包不能在磁盘上留下制品或解压目录。
			for _, directory := range []string{"accepted", "extracted"} {
				entries, readErr := os.ReadDir(filepath.Join(home, "plugins", directory))
				if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
					t.Fatalf("读取 %s 失败: %v", directory, readErr)
				}
				if len(entries) != 0 {
					t.Fatalf("失败后 %s 残留: %v", directory, entries)
				}
			}
		})
	}
}

func TestAcceptRejectsUnsafePaths(t *testing.T) {
	paths := []string{"../evil.js", "a\\b.js", "/abs.js", "C:/x.js", "con.js", "trail.", "space ", "a//b.js"}
	for _, unsafe := range paths {
		t.Run(unsafe, func(t *testing.T) {
			manifest := validTestManifest()
			manifest["entry"] = "index.mjs"
			data := buildTestPackage(t, manifest, map[string]string{
				"index.mjs": "ok\n",
				unsafe:      "bad\n",
			}, packageOptions{})
			home := t.TempDir()
			acceptor, err := NewAcceptor(home)
			if err != nil {
				t.Fatalf("创建接受器失败: %v", err)
			}
			_, err = acceptor.Accept(writeTestPackage(t, data), testAcceptOptions())
			requireErrorCode(t, err, codePackagePathInvalid)
		})
	}
}

func TestAcceptRejectsCaseInsensitiveCollision(t *testing.T) {
	data := buildTestPackage(t, validTestManifest(), map[string]string{
		"index.mjs": "ok\n",
		"Other.mjs": "a\n",
		"other.mjs": "b\n",
	}, packageOptions{})
	home := t.TempDir()
	acceptor, err := NewAcceptor(home)
	if err != nil {
		t.Fatalf("创建接受器失败: %v", err)
	}
	_, err = acceptor.Accept(writeTestPackage(t, data), testAcceptOptions())
	requireErrorCode(t, err, codePackagePathCollision)
}

func TestAcceptIsIdempotent(t *testing.T) {
	home := t.TempDir()
	data := buildTestPackage(t, validTestManifest(), map[string]string{"index.mjs": "same\n"}, packageOptions{})
	file := writeTestPackage(t, data)
	acceptor, err := NewAcceptor(home)
	if err != nil {
		t.Fatalf("创建接受器失败: %v", err)
	}
	first, err := acceptor.Accept(file, testAcceptOptions())
	if err != nil {
		t.Fatalf("首次接受失败: %v", err)
	}
	second, err := acceptor.Accept(file, testAcceptOptions())
	if err != nil {
		t.Fatalf("重复接受失败: %v", err)
	}
	if first.Digest != second.Digest || first.ArtifactPath != second.ArtifactPath || first.Directory != second.Directory {
		t.Fatalf("重复接受的路径不稳定: %+v %+v", first, second)
	}
	entries, err := os.ReadDir(filepath.Join(home, "plugins", "accepted"))
	if err != nil || len(entries) != 1 {
		t.Fatalf("accepted 目录应只有一个制品: %v %v", entries, err)
	}
}
