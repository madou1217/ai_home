package zcodecred

import (
	"strings"
	"testing"
)

// TestEncryptDecryptRoundTrip 加密格式与自身解密互通，前缀固定。
func TestEncryptDecryptRoundTrip(t *testing.T) {
	secret := ResolveSecret("", "darwin", "/Users/me", "me")
	plaintext := "{\"token\":\"值 with spaces\"}"
	encoded, err := EncryptValue(plaintext, secret)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if !strings.HasPrefix(encoded, EnvelopePrefix) {
		t.Fatalf("prefix = %q", encoded)
	}
	if parts := strings.Split(strings.TrimPrefix(encoded, EnvelopePrefix), "."); len(parts) != 3 {
		t.Fatalf("envelope parts = %d", len(parts))
	}
	decoded, ok := DecryptValue(encoded, secret)
	if !ok || decoded != plaintext {
		t.Fatalf("round trip = %q ok=%v", decoded, ok)
	}
	if _, ok := DecryptValue(encoded, "wrong-secret"); ok {
		t.Fatal("错误密钥不应解密成功")
	}
}

// TestIsEncryptedValue 只认固定前缀。
func TestIsEncryptedValue(t *testing.T) {
	if !IsEncryptedValue("enc:v1:a.b.c") {
		t.Fatal("应识别密文")
	}
	if IsEncryptedValue("plain") {
		t.Fatal("明文不应识别为密文")
	}
}
