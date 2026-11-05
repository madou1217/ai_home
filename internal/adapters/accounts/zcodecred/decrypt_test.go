package zcodecred

import "testing"

func TestDecryptValueMatchesNodeVector(t *testing.T) {
	// 由 Node 的 encryptZcodeCredentialValue('hello-zcode', secret='test-secret') 生成。
	const vector = "enc:v1:qA2RJPyhmmLJc9f3.fgw3CWGJ6lJS1VYNoE46dA.NuVgZLOXJ20m388"
	plaintext, ok := DecryptValue(vector, "test-secret")
	if !ok || plaintext != "hello-zcode" {
		t.Fatalf("DecryptValue() = %q, %v", plaintext, ok)
	}
	if _, ok := DecryptValue(vector, "wrong-secret"); ok {
		t.Fatalf("wrong secret must fail")
	}
}

func TestPlainValuesPassThrough(t *testing.T) {
	if value, ok := DecryptValue("plain-token", "secret"); !ok || value != "plain-token" {
		t.Fatalf("plain value = %q, %v", value, ok)
	}
}

func TestResolveSecretFallbackMatchesNode(t *testing.T) {
	want := "zcode-credential-fallback:darwin:/Users/model:model"
	if got := ResolveSecret("", "darwin", "/Users/model", "model"); got != want {
		t.Fatalf("fallback secret = %q, want %q", got, want)
	}
	if got := ResolveSecret("explicit", "darwin", "/Users/model", "model"); got != "explicit" {
		t.Fatalf("explicit secret = %q", got)
	}
	if got := ResolveSecret("", "darwin", "/Users/model", ""); got != "zcode-credential-fallback:darwin:/Users/model:unknown" {
		t.Fatalf("empty username = %q", got)
	}
}
