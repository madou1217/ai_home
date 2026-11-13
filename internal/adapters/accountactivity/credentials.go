package accountactivity

// 活动执行器的凭据与客户端元数据解析。
//
// 直接在 Go 内读取 aih.db / app-state.db 凭据记录与沙箱投影文件，不经 Node：
//   - Qoder / Qoder CN：PAT / 明文 token / qodercred WASM opaque 解密 + umid-cache.json；
//   - WorkBuddy / CodeBuddy 家族：DB credentials + 共享 .info + 企业归属头；
//   - ZCode：zcodecred AES-256-GCM 解密 + 沙箱 live credentials.json + app_version 解析。

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/accounts/qodercred"
	"github.com/madou1217/ai_home/internal/adapters/accounts/zcodecred"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// AccountRecord 表示合并 aih.db 与 app-state.db 后的单账号凭据视图。
type AccountRecord struct {
	Provider            string
	AccountRef          string
	Env                 map[string]string
	NativeAuth          map[string]any
	NativeAuthUpdatedAt int64
}

// LoadAccountRecord 读取指定 Provider 与 AccountRef 的凭据记录；不存在时返回 found=false。
func LoadAccountRecord(
	ctx context.Context,
	aiHomeDir string,
	provider string,
	accountRef string,
) (AccountRecord, bool, error) {
	normalizedProvider := strings.ToLower(strings.TrimSpace(provider))
	normalizedRef := strings.TrimSpace(accountRef)
	if strings.TrimSpace(aiHomeDir) == "" || normalizedProvider == "" || !accountRefPattern.MatchString(normalizedRef) {
		return AccountRecord{}, false, nil
	}
	if ctx == nil {
		ctx = context.Background()
	}

	merged := AccountRecord{
		Provider:   normalizedProvider,
		AccountRef: normalizedRef,
		Env:        map[string]string{},
		NativeAuth: map[string]any{},
	}
	found := false

	// 1) app-state.db（可能保留旧 env_json 或同步副本）
	if appStatePath, err := appstate.DatabasePath(aiHomeDir); err == nil {
		if rec, ok, err := readAccountRecordFromAppState(ctx, appStatePath, normalizedProvider, normalizedRef); err != nil {
			return AccountRecord{}, false, err
		} else if ok {
			found = true
			for k, v := range rec.Env {
				merged.Env[k] = v
			}
			if len(rec.NativeAuth) > 0 {
				merged.NativeAuth = rec.NativeAuth
				merged.NativeAuthUpdatedAt = rec.NativeAuthUpdatedAt
			}
		}
	}

	// 2) aih.db（Go 权威库；若更新或 app-state 无原生载荷则以它为准）
	aihDBPath := filepath.Join(strings.TrimSpace(aiHomeDir), "aih.db")
	if rec, ok, err := readAccountRecordFromAihDB(ctx, aihDBPath, normalizedProvider, normalizedRef); err != nil {
		return AccountRecord{}, false, err
	} else if ok {
		found = true
		for k, v := range rec.Env {
			merged.Env[k] = v
		}
		if len(rec.NativeAuth) > 0 && (len(merged.NativeAuth) == 0 || rec.NativeAuthUpdatedAt >= merged.NativeAuthUpdatedAt) {
			merged.NativeAuth = rec.NativeAuth
			merged.NativeAuthUpdatedAt = rec.NativeAuthUpdatedAt
		}
	}

	if !found {
		return AccountRecord{}, false, nil
	}
	return merged, true, nil
}

func readAccountRecordFromAihDB(
	ctx context.Context,
	aihDBPath string,
	provider string,
	accountRef string,
) (AccountRecord, bool, error) {
	info, err := os.Stat(aihDBPath)
	if err != nil || !info.Mode().IsRegular() {
		return AccountRecord{}, false, nil
	}
	db, err := sql.Open("sqlite", "file:"+aihDBPath+"?mode=ro&_busy_timeout=5000")
	if err != nil {
		return AccountRecord{}, false, err
	}
	defer func() { _ = db.Close() }()

	var credJSON string
	var updatedAtMS int64
	err = db.QueryRowContext(ctx, `
		SELECT COALESCE(c.credential_json, ''), COALESCE(c.updated_at_ms, 0)
		FROM accounts AS a
		INNER JOIN account_credentials AS c ON c.account_ref = a.account_ref
		WHERE a.provider_id = ? AND a.account_ref = ?
		LIMIT 1
	`, provider, accountRef).Scan(&credJSON, &updatedAtMS)
	if errors.Is(err, sql.ErrNoRows) || isNoSuchTableError(err) {
		return AccountRecord{}, false, nil
	}
	if err != nil {
		return AccountRecord{}, false, err
	}

	rec := AccountRecord{
		Provider:            provider,
		AccountRef:          accountRef,
		Env:                 map[string]string{},
		NativeAuth:          map[string]any{},
		NativeAuthUpdatedAt: updatedAtMS,
	}
	var doc map[string]any
	if json.Unmarshal([]byte(credJSON), &doc) != nil || doc == nil {
		return rec, true, nil
	}
	if inner, ok := doc["native_auth_json"].(map[string]any); ok && inner != nil {
		rec.NativeAuth = inner
	} else if innerRaw, ok := doc["native_auth_json"].(string); ok && strings.TrimSpace(innerRaw) != "" {
		var parsed map[string]any
		if json.Unmarshal([]byte(innerRaw), &parsed) == nil && parsed != nil {
			rec.NativeAuth = parsed
		}
	} else if apiKey, _ := doc["api_key"].(string); strings.TrimSpace(apiKey) != "" {
		trimmed := strings.TrimSpace(apiKey)
		switch provider {
		case "zcode":
			rec.Env["ZCODE_API_KEY"] = trimmed
		case "qoder", "qodercn":
			rec.Env["QODER_PERSONAL_ACCESS_TOKEN"] = trimmed
		}
	}
	return rec, true, nil
}

func readAccountRecordFromAppState(
	ctx context.Context,
	databasePath string,
	provider string,
	accountRef string,
) (AccountRecord, bool, error) {
	if _, err := os.Stat(databasePath); err != nil {
		return AccountRecord{}, false, nil
	}
	db, err := appstate.OpenReadOnly(ctx, databasePath)
	if err != nil {
		return AccountRecord{}, false, err
	}
	defer func() { _ = db.Close() }()

	var envRaw, nativeRaw string
	var nativeUpdated int64
	err = db.QueryRowContext(ctx, `
		SELECT COALESCE(c.env_json, '{}'), COALESCE(c.native_auth_json, '{}'), COALESCE(c.native_auth_updated_at, 0)
		FROM account_credentials AS c
		INNER JOIN account_refs AS r ON r.account_ref = c.account_ref
		WHERE r.provider = ? AND c.account_ref = ?
		  AND (c.env_json <> '{}' OR c.native_auth_json <> '{}')
		LIMIT 1
	`, provider, accountRef).Scan(&envRaw, &nativeRaw, &nativeUpdated)
	if errors.Is(err, sql.ErrNoRows) || isNoSuchTableError(err) {
		return AccountRecord{}, false, nil
	}
	if err != nil {
		return AccountRecord{}, false, err
	}

	rec := AccountRecord{
		Provider:            provider,
		AccountRef:          accountRef,
		Env:                 map[string]string{},
		NativeAuth:          map[string]any{},
		NativeAuthUpdatedAt: nativeUpdated,
	}
	var rawEnv map[string]any
	if json.Unmarshal([]byte(envRaw), &rawEnv) == nil {
		for k, v := range rawEnv {
			if s := textOf(v); s != "" {
				rec.Env[k] = s
			}
		}
	}
	var rawNative map[string]any
	if json.Unmarshal([]byte(nativeRaw), &rawNative) == nil && rawNative != nil {
		rec.NativeAuth = rawNative
	}
	return rec, true, nil
}

// ResolveAccountRuntimeDir 返回账号沙箱投影目录：<aiHomeDir>/run/auth-projections/<provider>/<accountRef>。
func ResolveAccountRuntimeDir(aiHomeDir, provider, accountRef string) string {
	root := strings.TrimSpace(aiHomeDir)
	prov := strings.ToLower(strings.TrimSpace(provider))
	ref := strings.TrimSpace(accountRef)
	if root == "" || prov == "" || ref == "" {
		return ""
	}
	return filepath.Join(root, "run", "auth-projections", prov, ref)
}

func resolveHostHomeDir(explicit string) string {
	if v := strings.TrimSpace(explicit); v != "" {
		return v
	}
	if v := strings.TrimSpace(os.Getenv("AIH_HOST_HOME")); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return strings.TrimSpace(home)
}

// --- Qoder 凭据与 UMID ---

// QoderDeviceIdentity 保存 Qoder CLI 写出的设备 UMID 信息。
type QoderDeviceIdentity struct {
	MachineToken string
	MachineCode  string
	MachineType  string
	Source       string
}

var qoderUMIDCacheDirs = map[string]string{
	"qoder":   ".qoder",
	"qodercn": ".qoder-cn",
}

// ReadQoderDeviceIdentity 依次检查账号沙箱与宿主 CLI 的 umid-cache.json。
func ReadQoderDeviceIdentity(aiHomeDir, hostHomeDir, provider, accountRef string) *QoderDeviceIdentity {
	normalized := strings.ToLower(strings.TrimSpace(provider))
	cacheDir := qoderUMIDCacheDirs[normalized]
	runtimeDir := ResolveAccountRuntimeDir(aiHomeDir, normalized, accountRef)
	hostDir := resolveHostHomeDir(hostHomeDir)

	candidates := make([]string, 0, 3)
	if runtimeDir != "" {
		candidates = append(candidates, filepath.Join(runtimeDir, "umid-cache.json"))
		if cacheDir != "" {
			candidates = append(candidates, filepath.Join(runtimeDir, cacheDir, "umid-cache.json"))
		}
	}
	if hostDir != "" && cacheDir != "" {
		candidates = append(candidates, filepath.Join(hostDir, cacheDir, "umid-cache.json"))
	}

	for _, file := range candidates {
		raw, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		var parsed map[string]any
		if json.Unmarshal(raw, &parsed) != nil || parsed == nil {
			continue
		}
		info, _ := parsed["info"].(map[string]any)
		if info == nil {
			continue
		}
		machineToken := textOf(info["machineToken"])
		machineCode := textOf(info["machineCode"])
		if machineToken == "" && machineCode == "" {
			continue
		}
		return &QoderDeviceIdentity{
			MachineToken: machineToken,
			MachineCode:  machineCode,
			MachineType:  textOf(info["machineType"]),
			Source:       file,
		}
	}
	return nil
}

// ResolveQoderAccessToken 从 PAT 环境变量、明文 userInfo/credentials 或 qodercred WASM 解密提取账号令牌。
func ResolveQoderAccessToken(
	provider string,
	record AccountRecord,
	options qodercred.Options,
	decryptFn func(provider string, native map[string]any) (qodercred.Identity, bool),
) (string, string) {
	if pat := strings.TrimSpace(record.Env["QODER_PERSONAL_ACCESS_TOKEN"]); pat != "" {
		return pat, "env_pat"
	}
	native := record.NativeAuth
	if len(native) == 0 {
		return "", ""
	}
	payload, _ := native["userInfo"].(map[string]any)
	if payload == nil {
		payload = native
	}
	if pat := firstMapText(payload, "personal_access_token", "pat"); pat != "" {
		return pat, "native_pat"
	}
	if token := firstMapText(payload, "security_oauth_token", "access_token", "accessToken", "token"); token != "" {
		return token, "native_auth"
	}
	if decryptFn != nil {
		if identity, ok := decryptFn(provider, native); ok && strings.TrimSpace(identity.Token) != "" {
			return strings.TrimSpace(identity.Token), "cli_wasm"
		}
	} else if identity, ok := qodercred.DecryptNative(provider, native, options); ok && strings.TrimSpace(identity.Token) != "" {
		return strings.TrimSpace(identity.Token), "cli_wasm"
	}
	return "", ""
}

// --- CodeBuddy / WorkBuddy 凭据 ---

// CodebuddySharedCredential 是已验证站点归属的 WorkBuddy/CodeBuddy 共享凭据。
type CodebuddySharedCredential struct {
	AccessToken  string
	UID          string
	Domain       string
	EnterpriseID string
}

var (
	codebuddyBillingEndpoints = map[string]string{
		"codebuddy":   "https://www.codebuddy.ai",
		"workbuddy":   "https://www.workbuddy.ai",
		"codebuddycn": "https://copilot.tencent.com",
		"workbuddycn": "https://copilot.tencent.com",
	}
	codebuddyFamilyIssuers = map[string][]string{
		"https://www.codebuddy.ai/auth/realms/copilot":    {"codebuddy"},
		"https://www.workbuddy.ai/auth/realms/copilot":    {"workbuddy"},
		"https://www.workbuddy.cn/auth/realms/copilot":    {"codebuddycn", "workbuddycn"},
		"https://www.codebuddy.cn/auth/realms/copilot":    {"codebuddycn", "workbuddycn"},
		"https://copilot.tencent.com/auth/realms/copilot": {"codebuddycn", "workbuddycn"},
	}
	codebuddyAuthFileNames = map[string]string{
		"codebuddy":   "Tencent-Cloud.coding-copilot.info",
		"codebuddycn": "workbuddy-desktop.info",
		"workbuddy":   "workbuddy-desktop-ai.info",
		"workbuddycn": "workbuddy-desktop.info",
	}
	codebuddyCrossSiteFallback = map[string]string{
		"codebuddycn": "codebuddy",
		"workbuddycn": "codebuddy",
	}
)

type inspectedCodebuddyCred struct {
	ok           bool
	accessToken  string
	uid          string
	domain       string
	enterpriseID string
	scope        string
	fingerprint  string
	issuedAt     int64
	refreshedAt  int64
	expiresAt    int64
}

// ReadCodebuddySharedCredential 从 DB 记录和沙箱/宿主共享 .info 读取并比较最新凭据。
func ReadCodebuddySharedCredential(
	aiHomeDir string,
	hostHomeDir string,
	provider string,
	accountRef string,
	record AccountRecord,
	nowMS int64,
	codecDecode func(raw map[string]any, provider string) (map[string]any, error),
) *CodebuddySharedCredential {
	normalized := strings.ToLower(strings.TrimSpace(provider))
	if _, valid := codebuddyBillingEndpoints[normalized]; !valid {
		return nil
	}
	if nowMS <= 0 {
		nowMS = time.Now().UnixMilli()
	}

	current := unwrapCodebuddyCredMap(record.NativeAuth)
	stored := inspectCodebuddyCred(current, normalized, nowMS)
	if current != nil && !stored.ok {
		return nil
	}

	runtimeDir := ResolveAccountRuntimeDir(aiHomeDir, normalized, accountRef)
	roots := make([]string, 0, 2)
	if runtimeDir != "" {
		roots = append(roots, runtimeDir)
	}
	if stored.ok {
		if host := resolveHostHomeDir(hostHomeDir); host != "" {
			roots = append(roots, host)
		}
	}

	for _, home := range roots {
		for _, file := range codebuddyAuthFilePaths(home, normalized) {
			candidateMap := readPlainCodebuddyAuthFile(file, normalized, codecDecode)
			if candidateMap == nil {
				continue
			}
			cand := inspectCodebuddyCred(candidateMap, normalized, nowMS)
			if !cand.ok {
				continue
			}
			if stored.ok && cand.scope != stored.scope {
				continue
			}
			if shouldAdoptCodebuddyCred(stored, cand, nowMS) {
				current = candidateMap
				stored = cand
			}
		}
	}

	final := inspectCodebuddyCred(current, normalized, nowMS)
	if !final.ok {
		return nil
	}
	return &CodebuddySharedCredential{
		AccessToken:  final.accessToken,
		UID:          final.uid,
		Domain:       final.domain,
		EnterpriseID: final.enterpriseID,
	}
}

func unwrapCodebuddyCredMap(native map[string]any) map[string]any {
	if len(native) == 0 {
		return nil
	}
	if creds, ok := native["credentials"].(map[string]any); ok && creds != nil {
		return creds
	}
	if _, hasAuth := native["auth"]; hasAuth {
		return native
	}
	return nil
}

func codebuddyAuthFilePaths(home, provider string) []string {
	parentSegments := []string{"Library", "Application Support"}
	switch runtime.GOOS {
	case "windows":
		parentSegments = []string{"AppData", "Local"}
	case "linux":
		parentSegments = []string{".local", "share"}
	}
	authDir := filepath.Join(append([]string{home}, append(parentSegments, "CodeBuddyExtension", "Data", "Public", "auth")...)...)
	paths := make([]string, 0, 2)
	if primary := codebuddyAuthFileNames[provider]; primary != "" {
		paths = append(paths, filepath.Join(authDir, primary))
	}
	if fbProv := codebuddyCrossSiteFallback[provider]; fbProv != "" {
		if fbFile := codebuddyAuthFileNames[fbProv]; fbFile != "" {
			fbPath := filepath.Join(authDir, fbFile)
			if len(paths) == 0 || paths[0] != fbPath {
				paths = append(paths, fbPath)
			}
		}
	}
	return paths
}

func readPlainCodebuddyAuthFile(
	file string,
	provider string,
	codecDecode func(raw map[string]any, provider string) (map[string]any, error),
) map[string]any {
	info, err := os.Lstat(file)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 1024*1024 {
		return nil
	}
	rawBytes, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	var parsed map[string]any
	if json.Unmarshal(rawBytes, &parsed) != nil || parsed == nil {
		return nil
	}
	// 若带 $wbEncrypted 且调用方提供了解码钩子则解码，否则跳过密文回落 DB。
	if hasWorkbuddyEncrypted(parsed) {
		if codecDecode == nil {
			return nil
		}
		decoded, err := codecDecode(parsed, provider)
		if err != nil || decoded == nil {
			return nil
		}
		return decoded
	}
	return parsed
}

func hasWorkbuddyEncrypted(doc map[string]any) bool {
	checkObj := func(obj map[string]any, keys []string) bool {
		if obj == nil {
			return false
		}
		for _, k := range keys {
			if nested, ok := obj[k].(map[string]any); ok && nested != nil {
				if v, has := nested["$wbEncrypted"]; has && fmt.Sprint(v) == "1" {
					return true
				}
			}
		}
		return false
	}
	auth, _ := doc["auth"].(map[string]any)
	acct, _ := doc["account"].(map[string]any)
	return checkObj(auth, []string{"accessToken", "refreshToken", "idToken"}) ||
		checkObj(acct, []string{"nickname", "phoneNumber"})
}

func inspectCodebuddyCred(cred map[string]any, expectedProvider string, nowMS int64) inspectedCodebuddyCred {
	if len(cred) == 0 {
		return inspectedCodebuddyCred{}
	}
	auth, _ := cred["auth"].(map[string]any)
	acct, _ := cred["account"].(map[string]any)
	if auth == nil || acct == nil {
		return inspectedCodebuddyCred{}
	}
	accessToken := firstMapText(auth, "accessToken", "access_token")
	refreshToken := firstMapText(auth, "refreshToken", "refresh_token")
	uid := textOf(acct["uid"])
	if accessToken == "" || refreshToken == "" || uid == "" {
		return inspectedCodebuddyCred{}
	}
	claims := decodeJWTPayload(accessToken)
	if claims == nil {
		return inspectedCodebuddyCred{}
	}
	issuer := textOf(claims["iss"])
	providers := codebuddyFamilyIssuers[issuer]
	if len(providers) == 0 {
		return inspectedCodebuddyCred{}
	}
	if expectedProvider != "" {
		matched := false
		for _, p := range providers {
			if p == expectedProvider {
				matched = true
				break
			}
		}
		if !matched {
			return inspectedCodebuddyCred{}
		}
	}
	if sub := textOf(claims["sub"]); sub == "" || sub != uid {
		return inspectedCodebuddyCred{}
	}
	if rClaims := decodeJWTPayload(refreshToken); rClaims != nil {
		if rSub := textOf(rClaims["sub"]); rSub != "" && rSub != uid {
			return inspectedCodebuddyCred{}
		}
	}
	domain := firstMapText(auth, "domain")
	entID := firstMapText(acct, "enterpriseId", "enterprise_id")
	expSec := toFloat64(claims["exp"])
	expiresAt := int64(0)
	if expSec > 0 {
		expiresAt = int64(expSec * 1000)
	}
	iatSec := toFloat64(claims["iat"])
	issuedAt := int64(0)
	if iatSec > 0 {
		issuedAt = int64(iatSec * 1000)
	}
	refreshedAt := int64(toFloat64(auth["lastRefreshTime"]))
	if refreshedAt == 0 {
		refreshedAt = int64(toFloat64(auth["updatedAt"]))
	}
	fp := sha256.Sum256([]byte(accessToken + "|" + refreshToken))
	_ = nowMS
	return inspectedCodebuddyCred{
		ok:           true,
		accessToken:  accessToken,
		uid:          uid,
		domain:       domain,
		enterpriseID: entID,
		scope:        issuer + "|" + uid,
		fingerprint:  hex.EncodeToString(fp[:]),
		issuedAt:     issuedAt,
		refreshedAt:  refreshedAt,
		expiresAt:    expiresAt,
	}
}

func shouldAdoptCodebuddyCred(current, next inspectedCodebuddyCred, nowMS int64) bool {
	if !next.ok {
		return false
	}
	if !current.ok {
		return next.expiresAt == 0 || next.expiresAt > nowMS
	}
	if current.scope != next.scope || current.fingerprint == next.fingerprint {
		return false
	}
	if next.expiresAt > 0 && next.expiresAt <= nowMS {
		return false
	}
	if next.issuedAt != current.issuedAt {
		return next.issuedAt > current.issuedAt
	}
	if next.refreshedAt > 0 && current.refreshedAt > 0 && next.refreshedAt != current.refreshedAt {
		return next.refreshedAt > current.refreshedAt
	}
	return false
}

// --- ZCode 凭据与客户端元数据 ---

const (
	// DefaultZcodeAppVersion 是找不到安装版/缓存时的兜底版本种子。
	DefaultZcodeAppVersion  = "3.16.3"
	zcodeInstallPageURL     = "https://zcode.z.ai/en/docs/install"
	zcodeVersionCacheTTLMS  = int64(6 * 60 * 60 * 1000)
	zcodeReleasePathPattern = `/zcode/electron/releases/(\d+\.\d+\.\d+)/`
)

var (
	zcodeVersionPattern     = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
	zcodeReleasePathRegexp  = regexp.MustCompile(zcodeReleasePathPattern)
	zcodeHostedReleaseRegex = regexp.MustCompile(`https://cdn-zcode\.z\.ai/zcode/electron/releases/(\d+\.\d+\.\d+)/`)
	zcodePlistVersionRegex  = regexp.MustCompile(`<key>CFBundleShortVersionString</key>\s*<string>([^<]+)</string>`)
)

// ZcodeLiveOAuth 是从 live 文件或 DB 解析出的 ZCode OAuth 凭据。
type ZcodeLiveOAuth struct {
	AccessToken string
	JWTToken    string
	Source      string
}

func currentZcodeSecret() string {
	username := ""
	if current, err := user.Current(); err == nil {
		username = current.Username
	}
	homeDir, _ := os.UserHomeDir()
	return zcodecred.ResolveSecret(os.Getenv(zcodecred.SecretEnv), runtime.GOOS, homeDir, username)
}

func decryptZcodeFieldMap(cred map[string]any, secret string) map[string]string {
	out := make(map[string]string, len(cred))
	for key, raw := range cred {
		s := textOf(raw)
		if s == "" {
			continue
		}
		if zcodecred.IsEncrypted(s) {
			plain, ok := zcodecred.DecryptValue(s, secret)
			if !ok {
				continue
			}
			s = strings.TrimSpace(plain)
		}
		if s != "" {
			out[key] = s
		}
	}
	return out
}

func extractZcodeCredentialsObject(native map[string]any) map[string]any {
	if len(native) == 0 {
		return nil
	}
	if inner, ok := native["credentials"].(map[string]any); ok && inner != nil {
		return inner
	}
	return native
}

func parseZcodePlainOAuth(cred map[string]any, secret string) (jwtToken string, accessToken string) {
	if len(cred) == 0 {
		return "", ""
	}
	plain := decryptZcodeFieldMap(cred, secret)
	active := strings.ToLower(plain["oauth:active_provider"])
	if active == "bigmodel" {
		accessToken = plain["oauth:bigmodel:access_token"]
	} else {
		accessToken = plain["oauth:zai:access_token"]
	}
	if accessToken == "" {
		accessToken = plain["oauth:zai:access_token"]
	}
	jwtToken = plain["zcodejwttoken"]
	return jwtToken, accessToken
}

// ReadZcodeLiveOAuthCredential 从沙箱 credentials.json 与 DB 快照中选取最新的 OAuth 凭据。
func ReadZcodeLiveOAuthCredential(aiHomeDir, accountRef string, record AccountRecord) ZcodeLiveOAuth {
	secret := currentZcodeSecret()
	dbJWT, dbAccess := parseZcodePlainOAuth(extractZcodeCredentialsObject(record.NativeAuth), secret)
	fallback := ZcodeLiveOAuth{
		AccessToken: dbAccess,
		JWTToken:    dbJWT,
		Source:      "db",
	}
	runtimeDir := ResolveAccountRuntimeDir(aiHomeDir, "zcode", accountRef)
	if runtimeDir == "" {
		return fallback
	}
	credPath := filepath.Join(runtimeDir, ".zcode", "v2", "credentials.json")
	stat, err := os.Stat(credPath)
	if err != nil || !stat.Mode().IsRegular() {
		return fallback
	}
	rawBytes, err := os.ReadFile(credPath)
	if err != nil {
		return fallback
	}
	var liveMap map[string]any
	if json.Unmarshal(rawBytes, &liveMap) != nil || liveMap == nil {
		return fallback
	}
	liveJWT, liveAccess := parseZcodePlainOAuth(liveMap, secret)
	if liveJWT == "" && liveAccess == "" {
		return fallback
	}
	liveMtimeMS := stat.ModTime().UnixMilli()
	if record.NativeAuthUpdatedAt > 0 && liveMtimeMS > 0 && liveMtimeMS <= record.NativeAuthUpdatedAt {
		return fallback
	}
	return ZcodeLiveOAuth{
		AccessToken: liveAccess,
		JWTToken:    liveJWT,
		Source:      "live",
	}
}

// ResolveZcodeClientMetadata 构建 ZCode 活动请求必需的客户端元数据与请求头。
func ResolveZcodeClientMetadata(
	ctx context.Context,
	aiHomeDir string,
	hostHomeDir string,
	accountRef string,
	explicitVersion string,
	versionFetcher HTTPDoer,
	nowMS int64,
	skipRefresh bool,
) (appVersion string, headers map[string]string) {
	if nowMS <= 0 {
		nowMS = time.Now().UnixMilli()
	}
	appVersion = normalizeZcodeVersion(explicitVersion)
	if appVersion == "" {
		if !skipRefresh {
			refreshZcodeAppVersionCache(ctx, aiHomeDir, versionFetcher, nowMS)
		}
		appVersion = resolveZcodeAppVersionSync(aiHomeDir, hostHomeDir)
	}
	platform, arch := nodePlatformArch(runtime.GOOS, runtime.GOARCH)
	deviceMid := readZcodeDeviceMid(aiHomeDir, accountRef)
	if deviceMid == "" {
		deviceMid = deriveZcodeDeviceMid(aiHomeDir, accountRef)
	}
	headers = map[string]string{
		"User-Agent":          "ZCode/" + appVersion,
		"HTTP-Referer":        "https://zcode.z.ai",
		"X-Title":             "Z Code@electron",
		"X-Platform":          platform + "-" + arch,
		"X-Release-Channel":   "stable",
		"X-Client-Language":   "en-US",
		"X-Client-Timezone":   time.Local.String(),
		"X-Os-Category":       zcodeOsCategory(platform),
		"X-ZCode-App-Version": appVersion,
	}
	if strings.TrimSpace(headers["X-Client-Timezone"]) == "" || headers["X-Client-Timezone"] == "Local" {
		// Go 的 Local.String() 返回 "Local" 时不如使用 IANA 时区或 UTC。
		headers["X-Client-Timezone"] = resolveLocalTimeZoneName()
	}
	if deviceMid != "" {
		headers["X-Device-Mid"] = deviceMid
	}
	return appVersion, headers
}

func resolveLocalTimeZoneName() string {
	if tz := strings.TrimSpace(os.Getenv("TZ")); tz != "" {
		return tz
	}
	if target, err := os.Readlink("/etc/localtime"); err == nil {
		if idx := strings.Index(target, "zoneinfo/"); idx >= 0 {
			if zone := strings.TrimSpace(target[idx+len("zoneinfo/"):]); zone != "" {
				return zone
			}
		}
	}
	return "UTC"
}

func zcodeOsCategory(platform string) string {
	switch platform {
	case "darwin":
		return "macos"
	case "windows":
		return "windows"
	default:
		return "linux"
	}
}

func normalizeZcodeVersion(v string) string {
	s := strings.TrimSpace(v)
	s = strings.TrimPrefix(strings.TrimPrefix(s, "v"), "V")
	if zcodeVersionPattern.MatchString(s) {
		return s
	}
	return ""
}

func readInstalledZcodeAppVersion(hostHomeDir string) string {
	home := resolveHostHomeDir(hostHomeDir)
	var plistRoots []string
	if runtime.GOOS == "darwin" {
		if home != "" {
			plistRoots = append(plistRoots, filepath.Join(home, "Applications", "ZCode.app", "Contents", "Info.plist"))
		}
		plistRoots = append(plistRoots, "/Applications/ZCode.app/Contents/Info.plist")
	}
	for _, file := range plistRoots {
		raw, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		if m := zcodePlistVersionRegex.FindSubmatch(raw); len(m) == 2 {
			if ver := normalizeZcodeVersion(string(m[1])); ver != "" {
				return ver
			}
		}
	}
	if home != "" {
		for _, file := range []string{
			filepath.Join(home, "Applications", "ZCode.app", "Contents", "Resources", "app", "package.json"),
			filepath.Join(home, "Applications", "ZCode.app", "Contents", "Resources", "package.json"),
		} {
			raw, err := os.ReadFile(file)
			if err != nil {
				continue
			}
			var doc struct {
				Version string `json:"version"`
			}
			if json.Unmarshal(raw, &doc) == nil {
				if ver := normalizeZcodeVersion(doc.Version); ver != "" {
					return ver
				}
			}
		}
	}
	return ""
}

func resolveZcodeAppVersionSync(aiHomeDir, hostHomeDir string) string {
	if v := readInstalledZcodeAppVersion(hostHomeDir); v != "" {
		return v
	}
	ver, _ := readCachedZcodeAppVersion(aiHomeDir)
	if ver != "" {
		return ver
	}
	return DefaultZcodeAppVersion
}

func readCachedZcodeAppVersion(aiHomeDir string) (string, int64) {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return "", 0
	}
	file := filepath.Join(root, "run", "zcode-app-version.json")
	raw, err := os.ReadFile(file)
	if err != nil {
		return "", 0
	}
	var doc struct {
		Version     string `json:"version"`
		FetchedAtMS int64  `json:"fetchedAtMs"`
	}
	if json.Unmarshal(raw, &doc) != nil {
		return "", 0
	}
	return normalizeZcodeVersion(doc.Version), doc.FetchedAtMS
}

func refreshZcodeAppVersionCache(ctx context.Context, aiHomeDir string, client HTTPDoer, nowMS int64) {
	if client == nil {
		return
	}
	cachedVer, fetchedAt := readCachedZcodeAppVersion(aiHomeDir)
	if cachedVer != "" && fetchedAt > 0 && nowMS-fetchedAt < zcodeVersionCacheTTLMS {
		return
	}
	reqCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, zcodeInstallPageURL, nil)
	if err != nil {
		return
	}
	resp, err := client.Do(req)
	if err != nil {
		return
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
	if err != nil {
		return
	}
	html := string(body)
	ver := ""
	if m := zcodeHostedReleaseRegex.FindStringSubmatch(html); len(m) == 2 {
		ver = normalizeZcodeVersion(m[1])
	} else if m := zcodeReleasePathRegexp.FindStringSubmatch(html); len(m) == 2 {
		ver = normalizeZcodeVersion(m[1])
	}
	if ver == "" || strings.TrimSpace(aiHomeDir) == "" {
		return
	}
	cachePath := filepath.Join(strings.TrimSpace(aiHomeDir), "run", "zcode-app-version.json")
	_ = os.MkdirAll(filepath.Dir(cachePath), 0o755)
	payload, _ := json.MarshalIndent(map[string]any{"version": ver, "fetchedAtMs": nowMS}, "", "  ")
	_ = os.WriteFile(cachePath, append(payload, '\n'), 0o644)
}

func readZcodeDeviceMid(aiHomeDir, accountRef string) string {
	runtimeDir := ResolveAccountRuntimeDir(aiHomeDir, "zcode", accountRef)
	if runtimeDir == "" {
		return ""
	}
	raw, err := os.ReadFile(filepath.Join(runtimeDir, ".zcode", "v2", "telemetry-state.json"))
	if err != nil {
		return ""
	}
	var doc struct {
		DeviceMid string `json:"deviceMid"`
	}
	if json.Unmarshal(raw, &doc) != nil {
		return ""
	}
	return strings.TrimSpace(doc.DeviceMid)
}

func deriveZcodeDeviceMid(aiHomeDir, accountRef string) string {
	seed := strings.Join([]string{"zcode-device-mid", aiHomeDir, accountRef}, ":")
	sum := sha256.Sum256([]byte(seed))
	hexStr := hex.EncodeToString(sum[:])
	nib, _ := strconv.ParseInt(string(hexStr[16]), 16, 64)
	variant := strconv.FormatInt((nib&0x3)|0x8, 16)
	return strings.Join([]string{
		hexStr[0:8],
		hexStr[8:12],
		"4" + hexStr[13:16],
		variant + hexStr[17:20],
		hexStr[20:32],
	}, "-")
}

// --- 共享小工具 ---

func firstMapText(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if s := textOf(m[key]); s != "" {
			return s
		}
	}
	return ""
}

func decodeJWTPayload(token string) map[string]any {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) < 2 || parts[1] == "" {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		seg := parts[1]
		if rem := len(seg) % 4; rem != 0 {
			seg += strings.Repeat("=", 4-rem)
		}
		raw, err = base64.URLEncoding.DecodeString(seg)
		if err != nil {
			return nil
		}
	}
	var out map[string]any
	if json.Unmarshal(raw, &out) != nil {
		return nil
	}
	return out
}

func toFloat64(value any) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case float32:
		return float64(v)
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case json.Number:
		f, _ := v.Float64()
		return f
	case string:
		f, _ := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return f
	default:
		return 0
	}
}


func nodePlatformArch(goos, goarch string) (string, string) {
	plat := goos
	if plat == "windows" {
		plat = "win32"
	}
	arch := goarch
	switch arch {
	case "amd64":
		arch = "x64"
	case "386":
		arch = "ia32"
	}
	return plat, arch
}
