package sshhost

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestFingerprintSHA256(t *testing.T) {
	t.Parallel()
	got := FingerprintSHA256(nil)
	want := "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU"
	if got != want {
		t.Fatalf("FingerprintSHA256(nil) = %q, want %q", got, want)
	}
	if strings.HasSuffix(got, "=") {
		t.Fatal("指纹不应带 base64 padding")
	}
}

func TestHostID(t *testing.T) {
	t.Parallel()
	cases := []struct {
		host string
		port int
		want string
	}{
		{host: "Example.COM", port: 22, want: "example.com:22"},
		{host: " example.com ", port: 0, want: "example.com:22"},
		{host: "example.com", port: 2222, want: "example.com:2222"},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.want, func(t *testing.T) {
			t.Parallel()
			if got := HostID(testCase.host, testCase.port); got != testCase.want {
				t.Fatalf("HostID() = %q, want %q", got, testCase.want)
			}
		})
	}
}

func TestHostKeyStoreTOFU(t *testing.T) {
	t.Parallel()
	repository := NewMemoryHostKeyRepository()
	now := time.UnixMilli(1700000000000)
	store := NewHostKeyStore(repository, func() time.Time { return now })
	first := []byte("host-key-one")
	second := []byte("host-key-two")

	verification, err := store.Verify("Example.com", 22, first)
	if err != nil {
		t.Fatalf("首次校验失败: %v", err)
	}
	if verification.State != TrustFirstUse || !verification.Trusted() {
		t.Fatalf("首次结果 = %#v", verification)
	}
	record, found := store.Get("example.com", 22)
	if !found || record.Fingerprint != FingerprintSHA256(first) || record.FirstSeenAt != now.UnixMilli() {
		t.Fatalf("记录 = %#v", record)
	}

	verification, err = store.Verify("example.com", 22, first)
	if err != nil || verification.State != TrustKnown {
		t.Fatalf("二次结果 = %#v, err = %v", verification, err)
	}

	verification, err = store.Verify("example.com", 22, second)
	if err != nil {
		t.Fatalf("指纹变化不应返回错误: %v", err)
	}
	if verification.Trusted() || verification.State != TrustMismatch {
		t.Fatalf("指纹变化结果 = %#v", verification)
	}
	if verification.Expected != FingerprintSHA256(first) || verification.Actual != FingerprintSHA256(second) {
		t.Fatalf("指纹变化明细 = %#v", verification)
	}

	if err := store.Forget("example.com", 22); err != nil {
		t.Fatalf("forget 失败: %v", err)
	}
	verification, _ = store.Verify("example.com", 22, second)
	if verification.State != TrustFirstUse {
		t.Fatalf("forget 后重新信任 = %#v", verification)
	}
}

type failingRepository struct{}

func (failingRepository) All() map[string]HostKeyRecord { return map[string]HostKeyRecord{} }

func (failingRepository) Save(map[string]HostKeyRecord) error { return errors.New("disk full") }

func TestHostKeyStoreSaveFailure(t *testing.T) {
	t.Parallel()
	store := NewHostKeyStore(failingRepository{}, nil)
	if _, err := store.Verify("example.com", 22, []byte("key")); err == nil {
		t.Fatal("保存失败必须返回错误，不能静默放行")
	}
}

const ed25519KeyBase64 = "AAAAC3NzaC1lZDI1NTE5AAAAIKg7GvJm9VEb0x0hJc0dQ0V6m3ZZ0m9mW0n8oQkQ0m0n"

func decodedEd25519Key(t *testing.T) []byte {
	t.Helper()
	key, err := base64.StdEncoding.DecodeString(ed25519KeyBase64)
	if err != nil {
		t.Fatalf("测试公钥解码失败: %v", err)
	}
	return key
}

func TestParseKnownHosts(t *testing.T) {
	t.Parallel()
	content := "# 注释\n" +
		"\n" +
		"example.com,*.example.org " + "ssh-ed25519 " + ed25519KeyBase64 + "\n" +
		"@revoked old.example.com ssh-ed25519 " + ed25519KeyBase64 + "\r\n" +
		"@cert-authority *.corp ssh-ed25519 " + ed25519KeyBase64 + "\n"
	entries, err := ParseKnownHosts([]byte(content))
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if len(entries) != 3 {
		t.Fatalf("条目数 = %d, want 3", len(entries))
	}
	if entries[0].Line != 3 || len(entries[0].Patterns) != 2 || entries[0].KeyType != "ssh-ed25519" {
		t.Fatalf("第一条 = %#v", entries[0])
	}
	if len(entries[0].Key) != len(decodedEd25519Key(t)) {
		t.Fatalf("公钥长度 = %d", len(entries[0].Key))
	}
	if entries[1].Marker != "revoked" || entries[1].Patterns[0] != "old.example.com" {
		t.Fatalf("revoked 条目 = %#v", entries[1])
	}
	if entries[2].Marker != "cert-authority" {
		t.Fatalf("cert-authority 条目 = %#v", entries[2])
	}
}

func TestParseKnownHostsErrors(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		content string
	}{
		{name: "字段不足", content: "example.com ssh-ed25519"},
		{name: "公钥不是 base64", content: "example.com ssh-ed25519 !!!not-base64!!!"},
		{name: "只有标记", content: "@revoked"},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			if _, err := ParseKnownHosts([]byte(testCase.content)); err == nil {
				t.Fatal("预期解析失败")
			}
		})
	}
}

func hashedPattern(t *testing.T, salt []byte, host string) string {
	t.Helper()
	mac := hmac.New(sha1.New, salt)
	if _, err := mac.Write([]byte(host)); err != nil {
		t.Fatalf("HMAC 写入失败: %v", err)
	}
	return "|1|" + base64.StdEncoding.EncodeToString(salt) + "|" + base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func TestMatchKnownHost(t *testing.T) {
	t.Parallel()
	key := decodedEd25519Key(t)
	otherKey := []byte("another-key")
	salt := []byte("0123456789abcdef")
	hashed := hashedPattern(t, salt, "hashed.example.com")

	cases := []struct {
		name        string
		patterns    []string
		host        string
		port        int
		keyType     string
		key         []byte
		wantMatch   bool
		wantRevoked bool
		wantCA      bool
	}{
		{name: "精确匹配默认端口", patterns: []string{"example.com"}, host: "example.com", port: 22, keyType: "ssh-ed25519", key: key, wantMatch: true},
		{name: "主机名大小写不敏感", patterns: []string{"Example.COM"}, host: "example.com", port: 22, keyType: "ssh-ed25519", key: key, wantMatch: true},
		{name: "非默认端口要方括号形式", patterns: []string{"example.com"}, host: "example.com", port: 2222, keyType: "ssh-ed25519", key: key, wantMatch: false},
		{name: "方括号端口匹配", patterns: []string{"[example.com]:2222"}, host: "example.com", port: 2222, keyType: "ssh-ed25519", key: key, wantMatch: true},
		{name: "通配符匹配", patterns: []string{"*.example.com"}, host: "a.example.com", port: 22, keyType: "ssh-ed25519", key: key, wantMatch: true},
		{name: "通配符问号", patterns: []string{"a?c.example.com"}, host: "abc.example.com", port: 22, keyType: "ssh-ed25519", key: key, wantMatch: true},
		{name: "否定模式优先", patterns: []string{"!bad.example.com", "*.example.com"}, host: "bad.example.com", port: 22, keyType: "ssh-ed25519", key: key, wantMatch: false},
		{name: "哈希主机名", patterns: []string{hashed}, host: "hashed.example.com", port: 22, keyType: "ssh-ed25519", key: key, wantMatch: true},
		{name: "哈希主机名端口形式", patterns: []string{hashedPattern(t, salt, "[hashed.example.com]:2222")}, host: "hashed.example.com", port: 2222, keyType: "ssh-ed25519", key: key, wantMatch: true},
		{name: "公钥不同", patterns: []string{"example.com"}, host: "example.com", port: 22, keyType: "ssh-ed25519", key: otherKey, wantMatch: false},
		{name: "密钥类型不同", patterns: []string{"example.com"}, host: "example.com", port: 22, keyType: "ssh-rsa", key: key, wantMatch: false},
		{name: "revoked 标记", patterns: []string{"example.com"}, host: "example.com", port: 22, keyType: "ssh-ed25519", key: key, wantMatch: true, wantRevoked: true},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			entries := []KnownHostEntry{{
				Patterns: testCase.patterns,
				KeyType:  "ssh-ed25519",
				Key:      key,
			}}
			if testCase.wantRevoked {
				entries[0].Marker = "revoked"
			}
			match, found := MatchKnownHost(entries, testCase.host, testCase.port, testCase.keyType, testCase.key)
			if found != testCase.wantMatch {
				t.Fatalf("MatchKnownHost() found = %v, want %v", found, testCase.wantMatch)
			}
			if found && match.Revoked != testCase.wantRevoked {
				t.Fatalf("Revoked = %v, want %v", match.Revoked, testCase.wantRevoked)
			}
		})
	}
}

func TestMatchKnownHostCA(t *testing.T) {
	t.Parallel()
	key := decodedEd25519Key(t)
	entries := []KnownHostEntry{{
		Marker:   "cert-authority",
		Patterns: []string{"*.corp"},
		KeyType:  "ssh-ed25519",
		Key:      key,
	}}
	match, found := MatchKnownHost(entries, "host.corp", 22, "ssh-ed25519", key)
	if !found || !match.CA {
		t.Fatalf("CA 匹配 = %#v, found = %v", match, found)
	}
}

func TestWildcardMatch(t *testing.T) {
	t.Parallel()
	cases := []struct {
		pattern string
		name    string
		want    bool
	}{
		{pattern: "*", name: "anything", want: true},
		{pattern: "a*b*c", name: "aXbYc", want: true},
		{pattern: "a*b*c", name: "aXbY", want: false},
		{pattern: "a?c", name: "abc", want: true},
		{pattern: "a?c", name: "ac", want: false},
		{pattern: "abc", name: "abc", want: true},
		{pattern: "abc", name: "abcd", want: false},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.pattern+"/"+testCase.name, func(t *testing.T) {
			t.Parallel()
			if got := wildcardMatch(testCase.pattern, testCase.name); got != testCase.want {
				t.Fatalf("wildcardMatch(%q, %q) = %v, want %v", testCase.pattern, testCase.name, got, testCase.want)
			}
		})
	}
}
