package qodercred

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
)

// opaqueBlob 造一个 CLI 风格的 base64 密文：base64 字母表里没有冒号，
// 所以 IsOpaqueCredential 会把它当成 opaque blob（与真实 .auth/user 一致）。
func opaqueBlob(size int) string {
	return base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x42}, size))
}

// resetCaches 清空包级缓存。缓存是全局的，不清会让断言依赖测试执行顺序。
func resetCaches(t *testing.T) {
	t.Helper()
	clear := func() {
		cacheMu.Lock()
		cacheValue = map[string]Identity{}
		cacheOrder = nil
		cacheMu.Unlock()
		extractMu.Lock()
		extractCache = map[string]*extractedWasm{}
		extractMu.Unlock()
	}
	clear()
	t.Cleanup(clear)
}

func TestIsOpaqueCredential(t *testing.T) {
	blob := opaqueBlob(96)
	cases := []struct {
		name  string
		value string
		want  bool
	}{
		// 可读 JSON 由上层直接解析，不能当成密文再送进 wasm。
		{"可读 JSON", `{"uid":"u","security_oauth_token":"t"}`, false},
		{"带前后空白的 JSON", "  {\"uid\":\"u\"}  ", false},
		// aih 自己的 iv:tag:cipher 信封由上层解密，也不属于这里。
		{"三段式信封", "iv:tag:cipher", false},
		{"带首尾空白的三段式", "  iv:tag:cipher  ", false},
		{"空串", "", false},
		{"只有空白", "  \n\t ", false},
		{"普通 base64 blob", blob, true},
		// 单段短串没有冒号，按现有语义也算 opaque；上游会因解不开而 fail-open。
		{"无冒号的短串", "Zm9vYmFy", true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := IsOpaqueCredential(testCase.value); got != testCase.want {
				t.Fatalf("IsOpaqueCredential(%q) = %v, want %v", testCase.value, got, testCase.want)
			}
		})
	}
}

func TestParseIdentityReadsUIDAndToken(t *testing.T) {
	cases := []struct {
		name      string
		plaintext string
		wantUID   string
		wantToken string
	}{
		// 三个主键都要能用，顺序为 uid → user_id → account_id。
		{"uid", `{"uid":"u1","security_oauth_token":"t1"}`, "u1", "t1"},
		{"user_id 兜底", `{"user_id":"u2","access_token":"t2"}`, "u2", "t2"},
		{"account_id 兜底", `{"account_id":"u3","token":"t3"}`, "u3", "t3"},
		// 厂商明文里 camelCase 与 id 也会出现，实现把它们列为后备键。
		{"camelCase", `{"userId":"u4","accessToken":"t4"}`, "u4", "t4"},
		{"id 兜底", `{"id":"u5"}`, "u5", ""},
		// 优先级必须固定，否则同一份明文在不同版本可能取到不同身份。
		{"uid 优先于 user_id", `{"uid":"first","user_id":"second"}`, "first", ""},
		{"security_oauth_token 优先于 access_token", `{"security_oauth_token":"t-first","access_token":"t-second"}`, "", "t-first"},
		// 空串与非字符串不参与取值，继续往后找。
		{"空串跳过", `{"uid":"","user_id":"u6"}`, "u6", ""},
		{"非字符串跳过", `{"uid":123,"user_id":"u7"}`, "u7", ""},
		{"首尾空白", "  {\"uid\":\"u8\"}  ", "u8", ""},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			identity, ok := parseIdentity(testCase.plaintext)
			if !ok {
				t.Fatalf("parseIdentity(%q) 应当成功", testCase.plaintext)
			}
			if identity.UID != testCase.wantUID || identity.Token != testCase.wantToken {
				t.Fatalf("parseIdentity(%q) = uid %q token %q, want uid %q token %q",
					testCase.plaintext, identity.UID, identity.Token, testCase.wantUID, testCase.wantToken)
			}
		})
	}
}

func TestParseIdentityKeepsFullPayload(t *testing.T) {
	// Payload 必须是完整明文：上层还要读 email 等字段，不能被裁剪。
	identity, ok := parseIdentity(`{"uid":"u1","email":"a@b.c","profile":{"plan":"pro"}}`)
	if !ok {
		t.Fatalf("parseIdentity 应当成功")
	}
	if identity.Payload["email"] != "a@b.c" {
		t.Fatalf("Payload 丢了 email: %+v", identity.Payload)
	}
	if _, nested := identity.Payload["profile"].(map[string]any); !nested {
		t.Fatalf("Payload 丢了嵌套字段: %+v", identity.Payload)
	}
}

func TestParseIdentityRejectsInvalidPayload(t *testing.T) {
	// 数组 JSON 用 map 反序列化会直接报错，这里是刻意固定的行为：
	// 上层只有在拿到对象时才认为身份有效。
	for _, plaintext := range []string{
		"",
		"   ",
		"not-json",
		`[{"uid":"u1"}]`,
		"[]",
		"null",
		"just-a-string",
		"42",
	} {
		if identity, ok := parseIdentity(plaintext); ok {
			t.Errorf("parseIdentity(%q) 应当被拒绝，得到 %+v", plaintext, identity)
		}
	}
}

func TestParseIdentityAcceptsEmptyObject(t *testing.T) {
	// 现状记录：{} 会解析成非 nil 空 map，返回 ok=true 但 UID/Token 为空。
	// 这是宽松语义（见报告），这里固定住以免以后无意改变调用方行为。
	identity, ok := parseIdentity("{}")
	if !ok || identity.UID != "" || identity.Token != "" {
		t.Fatalf("parseIdentity(\"{}\") = %+v, %v; want empty identity, true", identity, ok)
	}
}

func TestDecryptNativeFailurePaths(t *testing.T) {
	resetCaches(t)
	const machineID = "0123456789abcdef" // 恰好 16 字符
	blob := opaqueBlob(96)
	emptyHome := t.TempDir()

	cases := []struct {
		name    string
		native  map[string]any
		options Options
	}{
		{"native 为空", nil, Options{HostHomeDir: emptyHome}},
		// 可读 JSON 不是 opaque blob，必须在读盘前就返回 false。
		{"凭据是可读 JSON", map[string]any{"credentials": `{"uid":"u"}`, "machineId": machineID}, Options{HostHomeDir: emptyHome}},
		{"凭据不是字符串", map[string]any{"credentials": map[string]any{"uid": "u"}, "machineId": machineID}, Options{HostHomeDir: emptyHome}},
		{"machineId 太短", map[string]any{"credentials": blob, "machineId": "short"}, Options{HostHomeDir: emptyHome}},
		{"machineId 缺失", map[string]any{"credentials": blob}, Options{HostHomeDir: emptyHome}},
		// 没有 CLI 时只能 fail-open，不能 panic，也不能把凭据判成无效。
		{"本机没有 CLI", map[string]any{"credentials": blob, "machineId": machineID}, Options{HostHomeDir: emptyHome}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if identity, ok := DecryptNative("qoder", testCase.native, testCase.options); ok {
				t.Fatalf("DecryptNative() 应当失败，得到 %+v", identity)
			}
		})
	}
}

func TestDecryptBlobFailurePaths(t *testing.T) {
	blob := opaqueBlob(96)
	emptyHome := t.TempDir()
	const machineID = "0123456789abcdef"

	// 非 opaque 输入与密钥长度错误是纯函数判断，必须先于任何读盘发生。
	if _, err := DecryptBlob("qoder", `{"uid":"u"}`, machineID, Options{HostHomeDir: emptyHome}); !errors.Is(err, ErrNotOpaque) {
		t.Fatalf("可读 JSON 应返回 ErrNotOpaque，得到 %v", err)
	}
	if _, err := DecryptBlob("qoder", "iv:tag:cipher", machineID, Options{HostHomeDir: emptyHome}); !errors.Is(err, ErrNotOpaque) {
		t.Fatalf("三段式应返回 ErrNotOpaque，得到 %v", err)
	}
	if _, err := DecryptBlob("qoder", "", machineID, Options{HostHomeDir: emptyHome}); !errors.Is(err, ErrNotOpaque) {
		t.Fatalf("空密文应返回 ErrNotOpaque，得到 %v", err)
	}
	// 15 字符：wasm 只取前 16 字符当密钥，短于 16 必须直接拒绝。
	if _, err := DecryptBlob("qoder", blob, "0123456789abcde", Options{HostHomeDir: emptyHome}); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("machineId 过短应返回 ErrInvalidKey，得到 %v", err)
	}
	if _, err := DecryptBlob("qoder", blob, machineID, Options{HostHomeDir: emptyHome}); !errors.Is(err, ErrRuntimeMissing) {
		t.Fatalf("没有 CLI 应返回 ErrRuntimeMissing，得到 %v", err)
	}
	if _, err := DecryptBlob("qoder", blob, machineID, Options{HostHomeDir: emptyHome, BinaryPath: filepath.Join(emptyHome, "nope")}); !errors.Is(err, ErrRuntimeMissing) {
		t.Fatalf("BinaryPath 不存在应返回 ErrRuntimeMissing，得到 %v", err)
	}
}

func TestDecryptNativeUsesCachedIdentity(t *testing.T) {
	resetCaches(t)
	const machineID = "0123456789abcdef"
	blob := opaqueBlob(96)
	want := Identity{
		UID:     "u-cache",
		Token:   "tok-cache",
		Payload: map[string]any{"uid": "u-cache", "security_oauth_token": "tok-cache"},
	}
	storeIdentity(cacheKey("qoder", blob, machineID), want)

	// 目标 HOME 下没有 CLI：只有缓存命中才可能在 DecryptBlob 之前返回成功。
	got, ok := DecryptNative("qoder", map[string]any{"credentials": blob, "machineId": machineID}, Options{HostHomeDir: t.TempDir()})
	if !ok {
		t.Fatalf("相同输入第二次调用应命中缓存")
	}
	if got.UID != want.UID || got.Token != want.Token || got.Payload["uid"] != "u-cache" {
		t.Fatalf("缓存返回的身份不对: %+v", got)
	}
	// 换个 provider 就不该命中：缓存键必须区分 provider。
	if _, ok := DecryptNative("qodercn", map[string]any{"credentials": blob, "machineId": machineID}, Options{HostHomeDir: t.TempDir()}); ok {
		t.Fatalf("不同 provider 不应命中同一份缓存")
	}
}

func TestCachedIdentityNotPollutedByCaller(t *testing.T) {
	resetCaches(t)
	const machineID = "0123456789abcdef"
	blob := opaqueBlob(96)
	key := cacheKey("qoder", blob, machineID)
	storeIdentity(key, Identity{
		UID:     "u-cache",
		Token:   "tok-cache",
		Payload: map[string]any{"uid": "u-cache"},
	})
	native := map[string]any{"credentials": blob, "machineId": machineID}

	first, ok := DecryptNative("qoder", native, Options{HostHomeDir: t.TempDir()})
	if !ok {
		t.Fatalf("首次读取缓存失败")
	}
	// Identity.clone 的语义：调用方改返回值（含 Payload 顶层键）不能污染缓存。
	first.UID = "mutated"
	first.Payload["uid"] = "mutated"
	first.Payload["injected"] = true

	second, ok := DecryptNative("qoder", native, Options{HostHomeDir: t.TempDir()})
	if !ok {
		t.Fatalf("二次读取缓存失败")
	}
	if second.UID != "u-cache" || second.Payload["uid"] != "u-cache" {
		t.Fatalf("缓存被返回值污染: %+v", second)
	}
	if _, exists := second.Payload["injected"]; exists {
		t.Fatalf("调用方新增的键污染了缓存: %+v", second.Payload)
	}
}

func TestStoreIdentityEvictsOldest(t *testing.T) {
	resetCaches(t)
	for index := 0; index <= cacheLimit; index++ {
		storeIdentity(fmt.Sprintf("key-%02d", index), Identity{UID: fmt.Sprintf("u-%02d", index)})
	}
	// 超过上限后从最旧开始淘汰，避免长时间运行后无界增长。
	if _, ok := cachedIdentity("key-00"); ok {
		t.Fatalf("最旧的缓存应被淘汰")
	}
	if _, ok := cachedIdentity(fmt.Sprintf("key-%02d", cacheLimit)); !ok {
		t.Fatalf("最新写入的缓存应保留")
	}
	if len(cacheOrder) != cacheLimit {
		t.Fatalf("cacheOrder 长度 = %d, want %d", len(cacheOrder), cacheLimit)
	}
}

func TestCacheKeyDistinguishesInputs(t *testing.T) {
	base := cacheKey("qoder", "blob", "0123456789abcdef")
	// 三段拼接若不加分隔符，("ab","c") 与 ("a","bc") 会撞键。
	if base == cacheKey("qodercn", "blob", "0123456789abcdef") {
		t.Fatalf("provider 不同却得到相同缓存键")
	}
	if base == cacheKey("qoder", "blob2", "0123456789abcdef") {
		t.Fatalf("密文不同却得到相同缓存键")
	}
	if base == cacheKey("qoder", "blob", "0123456789abcdeg") {
		t.Fatalf("machineId 不同却得到相同缓存键")
	}
	if cacheKey("qoder", "ab", "c") == cacheKey("qoder", "a", "bc") {
		t.Fatalf("字段边界未分隔，缓存键发生碰撞")
	}
	if base != cacheKey("qoder", "blob", "0123456789abcdef") {
		t.Fatalf("相同输入应得到稳定缓存键")
	}
}
