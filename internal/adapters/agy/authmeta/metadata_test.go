package authmeta

import (
	"encoding/json"
	"testing"
	"time"
)

// fixedNow 是测试统一使用的「当前时刻」。
func fixedNow() time.Time {
	return time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)
}

// TestReadMetadataOAuthSnapshot 覆盖 OAuth 主路径：原生 artifact 里的 token 决定
// configured / accountName / authMode / tokenFresh，与 Node readAgyAuthMetadata 一致。
func TestReadMetadataOAuthSnapshot(t *testing.T) {
	expiry := time.Date(2026, 11, 12, 13, 30, 0, 0, time.UTC)
	record := CredentialRecord{
		NativeAuth: []byte(`{"email":"agy@example.test","oauthToken":{"auth_method":"consumer","token":{"access_token":"access","refresh_token":"refresh","expiry":"2026-11-12T13:30:00Z","token_type":"Bearer"}}}`),
	}
	metadata := ReadMetadata(record, fixedNow())
	if !metadata.Configured {
		t.Fatal("configured = false, want true")
	}
	if metadata.AccountName != "agy@example.test" || metadata.Email != "agy@example.test" {
		t.Fatalf("accountName/email = %q/%q", metadata.AccountName, metadata.Email)
	}
	if metadata.AuthMode != AuthMethodConsumer || metadata.Source != SourceAppStateDB {
		t.Fatalf("authMode/source = %q/%q", metadata.AuthMode, metadata.Source)
	}
	if !metadata.HasAccessToken || !metadata.HasRefreshToken {
		t.Fatalf("hasAccessToken/hasRefreshToken = %v/%v", metadata.HasAccessToken, metadata.HasRefreshToken)
	}
	if metadata.TokenExpiresAtMS != expiry.UnixMilli() {
		t.Fatalf("tokenExpiresAt = %d, want %d", metadata.TokenExpiresAtMS, expiry.UnixMilli())
	}
	if metadata.TokenExpiry != "2026-11-12T13:30:00Z" {
		t.Fatalf("tokenExpiry = %q", metadata.TokenExpiry)
	}
	if !metadata.TokenFresh {
		t.Fatal("tokenFresh = false, want true")
	}
}

// TestReadMetadataPlaceholders 覆盖无邮箱的两种占位文案与缺省 auth_method。
func TestReadMetadataPlaceholders(t *testing.T) {
	oauthOnlyRefresh := CredentialRecord{NativeAuth: []byte(
		`{"oauthToken":{"token":{"refresh_token":"refresh-only"}}}`)}
	metadata := ReadMetadata(oauthOnlyRefresh, fixedNow())
	if !metadata.Configured || metadata.AccountName != OAuthAccountName || metadata.Email != "" {
		t.Fatalf("OAuth 占位 = %+v", metadata)
	}
	if metadata.AuthMode != AuthMethodConsumer {
		t.Fatalf("缺省 auth_mode = %q, want consumer", metadata.AuthMode)
	}
	if metadata.HasAccessToken || metadata.TokenFresh {
		t.Fatalf("只有 refresh_token 时不应算 access token 新鲜: %+v", metadata)
	}
	if !metadata.HasRefreshToken {
		t.Fatal("refresh_token 存在时应 hasRefreshToken=true")
	}

	envOnly := CredentialRecord{Env: map[string]string{EnvAccessTokenKey: " env-token "}}
	metadata = ReadMetadata(envOnly, fixedNow())
	if !metadata.Configured || metadata.AccountName != AccessTokenAccountName {
		t.Fatalf("环境变量占位 = %+v", metadata)
	}
	if metadata.AuthMode != AuthModeAccessToken || metadata.Source != SourceAppStateDB {
		t.Fatalf("环境变量 authMode/source = %q/%q", metadata.AuthMode, metadata.Source)
	}
	// Node 在该分支不写 hasAccessToken / hasRefreshToken / tokenFresh，Go 保持零值。
	if metadata.HasAccessToken || metadata.HasRefreshToken || metadata.TokenFresh {
		t.Fatalf("环境变量分支不应带 token 字段: %+v", metadata)
	}
}

// TestReadMetadataSnapshotOnlyReadsSnakeCase 固定 Node 的字段口径：
// 快照只读 oauthToken.token 下的 snake_case 字段；camelCase / direct-token 不算凭据，
// 否则「外部导入的兼容文件」会被误判成账号已有登录态。
func TestReadMetadataSnapshotOnlyReadsSnakeCase(t *testing.T) {
	cases := []struct {
		name       string
		nativeAuth string
	}{
		{"camelCase 键名", `{"email":"a@b.test","oauthToken":{"token":{"accessToken":"a","refreshToken":"r"}}}`},
		{"direct-token 形态", `{"email":"a@b.test","oauthToken":{"access_token":"a","refresh_token":"r"}}`},
		{"token 是字符串", `{"email":"a@b.test","oauthToken":{"token":"a","access_token":"a"}}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			metadata := ReadMetadata(CredentialRecord{NativeAuth: []byte(testCase.nativeAuth)}, fixedNow())
			if metadata.Configured {
				t.Fatalf("不应被判为已配置: %+v", metadata)
			}
			if metadata.AccountName != UnknownAccountName || metadata.Email != "" {
				t.Fatalf("未配置占位 = %+v", metadata)
			}
		})
	}
}

// TestReadMetadataTokenExpiryNotISO 固化「数字过期时间不被 Date.parse 接受」的行为。
// Go 账号导出的是 expires_at_ms，Node 只看 expiry，因此 tokenExpiresAt 为空、
// tokenFresh=false；此时只有 refresh_token 能让账号保持可恢复。
func TestReadMetadataTokenExpiryNotISO(t *testing.T) {
	record := CredentialRecord{NativeAuth: []byte(
		`{"email":"a@b.test","oauthToken":{"token":{"access_token":"a","refresh_token":"r","expires_at_ms":1762950000000}}}`)}
	metadata := ReadMetadata(record, fixedNow())
	if metadata.TokenExpiresAtMS != 0 || metadata.TokenExpiry != "" {
		t.Fatalf("数字过期时间不应被解析: %+v", metadata)
	}
	if metadata.TokenFresh {
		t.Fatal("tokenFresh 应为 false")
	}
	if !HasRecoverableCredentials(metadata, fixedNow()) {
		t.Fatal("有 refresh_token 时应仍可恢复")
	}
}

// TestReadMetadataBrokenNativeAuthFallsBackToEnv 坏 JSON 不能把有 env token 的账号判成未配置。
func TestReadMetadataBrokenNativeAuthFallsBackToEnv(t *testing.T) {
	metadata := ReadMetadata(CredentialRecord{
		NativeAuth: []byte(`{"email":"broken"`),
		Env:        map[string]string{EnvGoogleAccessTokenKey: "google-token"},
	}, fixedNow())
	if !metadata.Configured || metadata.AccountName != AccessTokenAccountName {
		t.Fatalf("坏 JSON 回退结果 = %+v", metadata)
	}
	if metadata.Source != SourceAppStateDB {
		t.Fatalf("source = %q", metadata.Source)
	}
}

// TestReadEnvTokenPrecedence 固定 || 的短路语义：空白 AGY 变量会挡住 GOOGLE 回退。
func TestReadEnvTokenPrecedence(t *testing.T) {
	cases := []struct {
		name    string
		env     map[string]string
		want    string
		wantSrc string
	}{
		{"AGY 优先", map[string]string{EnvAccessTokenKey: "a", EnvGoogleAccessTokenKey: "g"}, "a", SourceAppStateDB},
		{"AGY 为空串时回落", map[string]string{EnvAccessTokenKey: "", EnvGoogleAccessTokenKey: "g"}, "g", SourceAppStateDB},
		{"AGY 空白串挡住回落", map[string]string{EnvAccessTokenKey: "   ", EnvGoogleAccessTokenKey: "g"}, "", ""},
		{"都没有", nil, "", ""},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			token, source := ReadEnvToken(testCase.env)
			if token != testCase.want || source != testCase.wantSrc {
				t.Fatalf("ReadEnvToken() = %q/%q, want %q/%q", token, source, testCase.want, testCase.wantSrc)
			}
		})
	}
}

// TestBuildGeminiOAuthCredentials 覆盖兼容投影文档的字段与两种键名形态。
func TestBuildGeminiOAuthCredentials(t *testing.T) {
	cases := []struct {
		name       string
		oauthToken string
		wantOK     bool
		want       GeminiOAuthCredentials
	}{
		{
			name:       "snake_case 嵌套 token",
			oauthToken: `{"auth_method":"consumer","token":{"access_token":"a","refresh_token":"r","token_type":"Bearer","expiry":"2026-11-12T13:30:00.250Z"}}`,
			wantOK:     true,
			want: GeminiOAuthCredentials{
				AccessToken: "a", RefreshToken: "r", TokenType: "Bearer",
				ExpiryDate: time.Date(2026, 11, 12, 13, 30, 0, 250_000_000, time.UTC).UnixMilli(),
				Scope:      GeminiOAuthScope,
			},
		},
		{
			name:       "camelCase direct-token",
			oauthToken: `{"accessToken":"a","refreshToken":"r","tokenType":"mac","expiresAt":"2026-11-12T13:30:00Z","idToken":"id"}`,
			wantOK:     true,
			want: GeminiOAuthCredentials{
				AccessToken: "a", RefreshToken: "r", TokenType: "mac",
				ExpiryDate: time.Date(2026, 11, 12, 13, 30, 0, 0, time.UTC).UnixMilli(),
				IDToken:    "id", Scope: GeminiOAuthScope,
			},
		},
		{
			name:       "嵌套 token 优先于外层同名字段",
			oauthToken: `{"access_token":"outer","token":{"access_token":"inner"}}`,
			wantOK:     true,
			want: GeminiOAuthCredentials{
				AccessToken: "inner", TokenType: "Bearer", Scope: GeminiOAuthScope,
			},
		},
		{
			name:       "缺 token_type 用 Bearer",
			oauthToken: `{"token":{"refresh_token":"r"}}`,
			wantOK:     true,
			want: GeminiOAuthCredentials{
				RefreshToken: "r", TokenType: "Bearer", Scope: GeminiOAuthScope,
			},
		},
		{
			name:       "没有 token 时拒绝生成",
			oauthToken: `{"auth_method":"consumer","token":{"token_type":"Bearer"}}`,
			wantOK:     false,
		},
		{
			name:       "坏 JSON 拒绝生成",
			oauthToken: `{"token":`,
			wantOK:     false,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			credentials, ok := BuildGeminiOAuthCredentials(json.RawMessage(testCase.oauthToken))
			if ok != testCase.wantOK {
				t.Fatalf("ok = %v, want %v", ok, testCase.wantOK)
			}
			if !ok {
				return
			}
			if credentials != testCase.want {
				t.Fatalf("credentials = %+v, want %+v", credentials, testCase.want)
			}
		})
	}
}

// TestBuildGeminiOAuthCredentialsJSONShape 固定落盘键名：有 id_token 才出现该键，
// scope 始终存在（Desktop 2.x 缺 scope 会判成授权不完整）。
func TestBuildGeminiOAuthCredentialsJSONShape(t *testing.T) {
	credentials, ok := BuildGeminiOAuthCredentials(json.RawMessage(
		`{"token":{"access_token":"a","refresh_token":"r"}}`))
	if !ok {
		t.Fatal("应能生成凭据")
	}
	raw, err := json.Marshal(credentials)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	if _, exists := document["id_token"]; exists {
		t.Fatalf("空 id_token 不应出现: %s", raw)
	}
	if document["scope"] != GeminiOAuthScope {
		t.Fatalf("scope = %v", document["scope"])
	}
	if document["expiry_date"] != float64(0) {
		t.Fatalf("expiry_date = %v, want 0", document["expiry_date"])
	}
}

// TestBuildGoogleAccounts 固定 active 去空白与 old 空数组的形状。
func TestBuildGoogleAccounts(t *testing.T) {
	if _, ok := BuildGoogleAccounts("   "); ok {
		t.Fatal("空邮箱不应生成 google_accounts")
	}
	document, ok := BuildGoogleAccounts("  agy@example.test  ")
	if !ok || document.Active != "agy@example.test" {
		t.Fatalf("document = %+v, ok = %v", document, ok)
	}
	raw, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != `{"active":"agy@example.test","old":[]}` {
		t.Fatalf("json = %s", raw)
	}
}

// TestParseISOTimestampMS 覆盖 Date.parse 的常见 ISO 形态与不可解析文本。
func TestParseISOTimestampMS(t *testing.T) {
	cases := []struct {
		name string
		text string
		want int64
	}{
		{"带 Z", "2026-11-12T13:30:00Z", time.Date(2026, 11, 12, 13, 30, 0, 0, time.UTC).UnixMilli()},
		{"带毫秒", "2026-11-12T13:30:00.123Z", time.Date(2026, 11, 12, 13, 30, 0, 123_000_000, time.UTC).UnixMilli()},
		{"带偏移", "2026-11-12T21:30:00+08:00", time.Date(2026, 11, 12, 13, 30, 0, 0, time.UTC).UnixMilli()},
		{"无偏移按本地时区", "2026-11-12T13:30:00", time.Date(2026, 11, 12, 13, 30, 0, 0, time.Local).UnixMilli()},
		{"纯日期按 UTC", "2026-11-12", time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC).UnixMilli()},
		{"纯数字时间戳不可解析", "1762950000000", 0},
		{"ISO 之外的文本", "Nov 12 2026", 0},
		{"空文本", "", 0},
		{"纪元零点不算有效", "1970-01-01T00:00:00Z", 0},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := parseISOTimestampMS(testCase.text); got != testCase.want {
				t.Fatalf("parseISOTimestampMS(%q) = %d, want %d", testCase.text, got, testCase.want)
			}
		})
	}
}

// TestIsAccessTokenFresh 覆盖严格大于与 skew 边界（Node 的 Math.max(0, skew)）。
func TestIsAccessTokenFresh(t *testing.T) {
	now := fixedNow()
	expiresAt := now.Add(time.Minute).UnixMilli()
	metadata := Metadata{HasAccessToken: true, TokenExpiresAtMS: expiresAt}

	if !IsAccessTokenFresh(metadata, now, 0) {
		t.Fatal("过期时间晚于 now 时应新鲜")
	}
	if IsAccessTokenFresh(metadata, now.Add(time.Minute), 0) {
		t.Fatal("过期时间等于 now 时应不新鲜（严格大于）")
	}
	if IsAccessTokenFresh(metadata, now.Add(2*time.Minute), -time.Minute.Milliseconds()) {
		t.Fatal("负 skew 必须按 0 处理")
	}
	if IsAccessTokenFresh(Metadata{TokenExpiresAtMS: expiresAt}, now, 0) {
		t.Fatal("没有 access_token 时不应新鲜")
	}
	if IsAccessTokenFresh(Metadata{HasAccessToken: true}, now, 0) {
		t.Fatal("没有过期时间时不应新鲜")
	}
}
