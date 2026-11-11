package aihserver

// 本文件钉住 qoder 透传的凭据门槛：只有原生登录态能被征召。
//
// 为什么需要单独测：策略放宽不会编译失败、不会启动报错，只在真机上表现为「账号被
// 选中、透传拒绝、客户端拿到 422」——或者更糟：PAT 账号被选中后把请求从 Canonical /
// Node 手里抢走。策略是这条路径唯一的闸门。

import (
	"encoding/json"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// stubStaticCredential 模拟「非原生凭据」（例如从 API Key 槽位读出的通用凭据）。
type stubStaticCredential struct{ provider string }

func (credential stubStaticCredential) ProviderID() string   { return credential.provider }
func (credential stubStaticCredential) IdentitySeed() string { return "seed-" + credential.provider }
func (credential stubStaticCredential) String() string       { return "stub-static-credential" }
func (credential stubStaticCredential) GoString() string     { return "stubStaticCredential" }

// nativeQoderCredential 构造与导入路径同形的原生凭据：oauth 登录态或 PAT。
func nativeQoderCredential(t *testing.T, providerID, authKind string) *accountcore.NativeCredential {
	t.Helper()
	var identity accountcore.NativeIdentity
	var err error
	if authKind == "oauth" {
		identity, err = accountcore.NewNativeQoderIdentity(providerID, "uid-1")
	} else {
		identity, err = accountcore.NewNativeQoderPATIdentity(providerID, "pat-123456")
	}
	if err != nil {
		t.Fatalf("构造 %s 身份失败: %v", authKind, err)
	}
	payload, err := json.Marshal(map[string]any{
		"credentials": "opaque",
		"machineId":   "11111111-2222-3333-4444-555555555555",
	})
	if err != nil {
		t.Fatalf("编码 payload 失败: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, payload)
	if err != nil {
		t.Fatalf("构造原生凭据失败: %v", err)
	}
	return credential
}

// nativeOtherCredential 构造别家 Provider 的原生登录态，用来验证策略不是"认原生就行"。
func nativeOtherCredential(t *testing.T) *accountcore.NativeCredential {
	t.Helper()
	identity, err := accountcore.NewNativeKiroIdentity(
		"https://codewhisperer.us-east-1.amazonaws.com",
		"subject-1",
	)
	if err != nil {
		t.Fatalf("构造 kiro 身份失败: %v", err)
	}
	payload, err := json.Marshal(map[string]any{"accessToken": "opaque"})
	if err != nil {
		t.Fatalf("编码 kiro payload 失败: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, payload)
	if err != nil {
		t.Fatalf("构造 kiro 凭据失败: %v", err)
	}
	return credential
}

func TestQoderRelayPolicyAcceptsNativeLoginOnly(t *testing.T) {
	policy := qoderRelayTransportPolicy{}
	cases := []struct {
		name       string
		credential accountapp.Credential
		want       bool
	}{
		{"qoder 原生登录态", nativeQoderCredential(t, "qoder", "oauth"), true},
		{"qodercn 原生登录态", nativeQoderCredential(t, "qodercn", "oauth"), true},
		// PAT 同样是 *NativeCredential，但没有可解密的登录材料，wasm 拿不到签名输入。
		{"qoder PAT", nativeQoderCredential(t, "qoder", "api-key"), false},
		{"别家 Provider 的原生登录态", nativeOtherCredential(t), false},
		{"qoder 静态凭据", stubStaticCredential{provider: "qoder"}, false},
		{"nil 凭据", nil, false},
	}
	for _, testCase := range cases {
		if got := policy.SupportsCredential(testCase.credential); got != testCase.want {
			t.Fatalf("%s: SupportsCredential() = %v, want %v", testCase.name, got, testCase.want)
		}
	}
}
