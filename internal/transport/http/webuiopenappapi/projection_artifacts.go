package webuiopenappapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	appprojection "github.com/madou1217/ai_home/application/accountprojection"
	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/adapters/accounts/zcodecred"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage"
	"github.com/madou1217/ai_home/internal/runtime/accountprojection"
	"github.com/madou1217/ai_home/internal/runtime/storagepolicy"
)

type rollbackSnapshot struct {
	path    string
	existed bool
	data    []byte
	mode    os.FileMode
}

type fileRollback struct {
	entries []rollbackSnapshot
	seen    map[string]struct{}
}

func newFileRollback() *fileRollback {
	return &fileRollback{seen: make(map[string]struct{})}
}

func (rb *fileRollback) snapshot(paths ...string) {
	if rb == nil {
		return
	}
	for _, raw := range paths {
		clean := filepath.Clean(strings.TrimSpace(raw))
		if clean == "" || clean == "." {
			continue
		}
		if _, exists := rb.seen[clean]; exists {
			continue
		}
		rb.seen[clean] = struct{}{}
		info, err := os.Stat(clean)
		if err != nil {
			rb.entries = append(rb.entries, rollbackSnapshot{path: clean, existed: false})
			continue
		}
		if info.IsDir() {
			continue
		}
		data, err := os.ReadFile(clean)
		if err != nil {
			continue
		}
		rb.entries = append(rb.entries, rollbackSnapshot{
			path:    clean,
			existed: true,
			data:    data,
			mode:    info.Mode().Perm(),
		})
	}
}

func (rb *fileRollback) restore() {
	if rb == nil {
		return
	}
	for i := len(rb.entries) - 1; i >= 0; i-- {
		entry := rb.entries[i]
		if !entry.existed {
			_ = os.Remove(entry.path)
			continue
		}
		mode := entry.mode
		if mode == 0 {
			mode = 0o600
		}
		_ = writeBytesAtomic(entry.path, entry.data, mode)
	}
}

func writeBytesAtomic(target string, content []byte, mode os.FileMode) error {
	if mode == 0 {
		mode = 0o600
	}
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	var suffixBuf [8]byte
	_, _ = rand.Read(suffixBuf[:])
	temp := fmt.Sprintf("%s.aih-tmp-%d-%s", target, os.Getpid(), hex.EncodeToString(suffixBuf[:]))
	if err := os.WriteFile(temp, content, mode); err != nil {
		return err
	}
	_ = os.Chmod(temp, mode)
	if err := os.Rename(temp, target); err != nil {
		_ = os.Remove(temp)
		return err
	}
	_ = os.Chmod(target, mode)
	return nil
}

func writeJSONAtomic(target string, value any) error {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return writeBytesAtomic(target, append(encoded, '\n'), 0o600)
}

func ensureDesktopSharedCaches(aiHomeDir, provider, userDataDir string) {
	if strings.TrimSpace(aiHomeDir) == "" || strings.TrimSpace(userDataDir) == "" {
		return
	}
	_ = os.MkdirAll(userDataDir, 0o700)
	cacheRoot := filepath.Join(aiHomeDir, "run", "desktop-shared-caches", strings.ToLower(strings.TrimSpace(provider)))
	if err := os.MkdirAll(cacheRoot, 0o700); err != nil {
		return
	}
	sharedDirs := []string{
		"Cache",
		"Code Cache",
		"GPUCache",
		"DawnCache",
		"DawnGraphiteCache",
		"DawnWebGPUCache",
	}
	for _, name := range sharedDirs {
		target := filepath.Join(cacheRoot, name)
		linkPath := filepath.Join(userDataDir, name)
		_ = os.MkdirAll(target, 0o700)
		ensureSymlinkIfAbsent(linkPath, target)
	}
}

func ensureSymlinkIfAbsent(linkPath, target string) {
	if _, err := os.Lstat(linkPath); err == nil {
		return
	}
	_ = os.Symlink(target, linkPath)
}

func materializeDesktopAuth(
	ctx context.Context,
	aiHomeDir string,
	hostHomeDir string,
	profileDir string,
	snapshot AccountSnapshot,
	rollback *fileRollback,
) error {
	provider := strings.ToLower(strings.TrimSpace(snapshot.Provider))
	if err := os.MkdirAll(profileDir, 0o700); err != nil {
		return err
	}

	// 已接入 Go 通用投影执行器的 Provider（Codex / CodeBuddy 家族）直接复用 Provisioner。
	registry := providerstorage.New()
	if _, ok := registry.Policy(provider); ok && snapshot.Credential != nil {
		// Codex API-Key 账号不写 auth.json，直接跳过沙箱凭据物化；OAuth 账号写入完整 CODEX_HOME。
		if _, isCodexAPIKey := snapshot.Credential.(*codex.APIKeyAuth); isCodexAPIKey {
			return nil
		}
		prov, err := accountprojection.New(accountprojection.Options{
			AIHomeDir:     aiHomeDir,
			Policies:      registry,
			Materializers: registry.Materializers(),
			Linker:        accountprojection.NewLinker(),
		})
		if err == nil {
			_, err = prov.Prepare(ctx, appprojection.Request{
				ProviderID:         provider,
				AccountRef:         snapshot.AccountRef,
				HostHomeDir:        hostHomeDir,
				RuntimeDir:         profileDir,
				ProjectionRequired: true,
				Credential:         snapshot.Credential,
			})
			return err
		}
	}

	policy := storagepolicy.Get(provider)
	if policy == nil {
		return nil
	}
	fields := resolveDesktopAuthFields(provider, snapshot)
	if len(fields) == 0 {
		return nil
	}

	for _, artifact := range policy.AuthArtifacts {
		targetPath := filepath.Join(append([]string{profileDir}, artifact.Path...)...)
		rollback.snapshot(targetPath)
		val, ok := fields[artifact.Field]
		if !ok || isZeroField(val) {
			continue
		}
		if provider == "zcode" && artifact.Field == "credentials" {
			// liveStore 语义：磁盘那份较新时只补缺失键，不覆盖客户端原地续期的 token。
			if merged, skip := mergeZcodeLiveStoreArtifact(targetPath, val, snapshot.CredentialUpdatedAtMS); skip {
				val = merged
			}
		}
		if err := writeArtifactByFormat(targetPath, artifact.Format, val); err != nil {
			return err
		}
	}
	return nil
}

type osSymlinkLinker struct{}

// IsManaged 判断 linkPath 是否指向 targetPath（装配器要求的最小 Linker 合同）。
func (*osSymlinkLinker) IsManaged(linkPath string, targetPath string) bool {
	info, err := os.Lstat(linkPath)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		return false
	}
	destination, err := os.Readlink(linkPath)
	if err != nil {
		return false
	}
	if !filepath.IsAbs(destination) {
		destination = filepath.Join(filepath.Dir(linkPath), destination)
	}
	absoluteDestination, err := filepath.Abs(destination)
	if err != nil {
		return false
	}
	absoluteTarget, err := filepath.Abs(targetPath)
	if err != nil {
		return false
	}
	return filepath.Clean(absoluteDestination) == filepath.Clean(absoluteTarget)
}

func (*osSymlinkLinker) EnsureSymlink(target, linkPath string) error {
	if err := os.MkdirAll(filepath.Dir(linkPath), 0o700); err != nil {
		return err
	}
	if _, err := os.Lstat(linkPath); err == nil {
		return nil
	}
	return os.Symlink(target, linkPath)
}

func resolveDesktopAuthFields(provider string, snapshot AccountSnapshot) map[string]any {
	out := make(map[string]any)
	if len(snapshot.NativeAuthJSON) > 0 {
		var raw map[string]any
		if json.Unmarshal(snapshot.NativeAuthJSON, &raw) == nil && raw != nil {
			for k, v := range raw {
				out[k] = v
			}
		}
	}
	switch provider {
	case "agy":
		if auth, ok := snapshot.Credential.(*agy.OAuthAuth); ok && auth != nil {
			tokenObj := map[string]any{
				"accessToken":  auth.AccessToken(),
				"refreshToken": auth.RefreshToken(),
				"expiresAt":    auth.ExpiresAtMS(),
				"tokenType":    firstNonEmptyString(auth.TokenType(), "Bearer"),
				"email":        auth.Email(),
			}
			if auth.IDToken() != "" {
				tokenObj["idToken"] = auth.IDToken()
			}
			out["oauthToken"] = tokenObj
			out["desktopOauthToken"] = tokenObj
			if auth.Email() != "" {
				out["email"] = auth.Email()
			}
		} else if tok, ok := out["oauthToken"]; ok && !isZeroField(tok) {
			out["desktopOauthToken"] = tok
		}
	case "kimi":
		if creds := buildKimiProjectionCredentials(out); creds != nil {
			out["credentials"] = creds
		}
		if strings.TrimSpace(stringField(out, "deviceId", "device_id")) == "" {
			if credsMap, ok := out["credentials"].(map[string]any); ok {
				if derived := deriveKimiDeviceID(credsMap); derived != "" {
					out["deviceId"] = derived
				}
			}
		}
	}
	return out
}

func buildKimiProjectionCredentials(raw map[string]any) map[string]any {
	if raw == nil {
		return nil
	}
	if creds, ok := raw["credentials"].(map[string]any); ok && len(creds) > 0 {
		return creds
	}
	access := stringField(raw, "access_token", "accessToken")
	refresh := stringField(raw, "refresh_token", "refreshToken")
	if access == "" && refresh == "" {
		return nil
	}
	return map[string]any{
		"access_token":  access,
		"refresh_token": refresh,
		"token_type":    firstNonEmptyString(stringField(raw, "token_type", "tokenType"), "Bearer"),
	}
}

func deriveKimiDeviceID(creds map[string]any) string {
	seed := stringField(creds, "refresh_token", "access_token")
	if seed == "" {
		return ""
	}
	sum := sha256.Sum256([]byte("aih:kimi:device:" + seed))
	return hex.EncodeToString(sum[:16])
}

func mergeZcodeLiveStoreArtifact(targetPath string, value any, snapshotUpdatedAtMS int64) (any, bool) {
	info, err := os.Stat(targetPath)
	if err != nil || info.IsDir() || snapshotUpdatedAtMS <= 0 {
		return nil, false
	}
	if info.ModTime().UnixMilli() <= snapshotUpdatedAtMS {
		return nil, false
	}
	raw, err := os.ReadFile(targetPath)
	if err != nil {
		return nil, false
	}
	var live map[string]any
	if json.Unmarshal(raw, &live) != nil || len(live) == 0 {
		return nil, false
	}
	desired, ok := value.(map[string]any)
	if !ok {
		return live, true
	}
	merged := make(map[string]any, len(desired)+len(live))
	for k, v := range desired {
		merged[k] = v
	}
	for k, v := range live {
		merged[k] = v
	}
	return merged, true
}

func writeArtifactByFormat(targetPath, format string, val any) error {
	switch format {
	case "binary-base64":
		rawStr, ok := val.(string)
		if !ok || strings.TrimSpace(rawStr) == "" {
			return nil
		}
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(rawStr))
		if err != nil {
			return err
		}
		return writeBytesAtomic(targetPath, decoded, 0o600)
	case "text":
		text := fmt.Sprint(val)
		return writeBytesAtomic(targetPath, []byte(strings.TrimSpace(text)+"\n"), 0o600)
	default:
		return writeJSONAtomic(targetPath, val)
	}
}

func isZeroField(val any) bool {
	if val == nil {
		return true
	}
	switch typed := val.(type) {
	case string:
		return strings.TrimSpace(typed) == ""
	case map[string]any:
		return len(typed) == 0
	default:
		return false
	}
}

// captureZcodeAuthOnClose 在关闭 ZCode Desktop 时回读投影里的最新 credentials/config 并写回数据库。
func captureZcodeAuthOnClose(
	ctx context.Context,
	accounts AccountLookup,
	profileDir string,
	snapshot AccountSnapshot,
	now time.Time,
) {
	if accounts == nil || strings.TrimSpace(profileDir) == "" || len(snapshot.NativeAuthJSON) == 0 {
		return
	}
	credPath := filepath.Join(profileDir, ".zcode", "v2", "credentials.json")
	credBytes, err := os.ReadFile(credPath)
	if err != nil {
		return
	}
	var diskCreds map[string]any
	if json.Unmarshal(credBytes, &diskCreds) != nil || len(diskCreds) == 0 {
		return
	}
	// ZCode Desktop 可能写了 enc:v1: 密文，解密后再写回 SQLite，保持与解码器口径一致。
	secret := zcodecred.ResolveSecret(os.Getenv(zcodecred.SecretEnv), normalizeZcodeSecretPlatform(), lookupOSUserHomeDir(), currentOSUsername())
	decryptedCreds := decryptZcodeMap(diskCreds, secret)

	var current map[string]any
	if json.Unmarshal(snapshot.NativeAuthJSON, &current) != nil || current == nil {
		return
	}
	next := make(map[string]any, len(current)+1)
	for k, v := range current {
		next[k] = v
	}
	next["credentials"] = decryptedCreds

	cfgPath := filepath.Join(profileDir, ".zcode", "v2", "config.json")
	if cfgBytes, cfgErr := os.ReadFile(cfgPath); cfgErr == nil {
		var diskCfg map[string]any
		if json.Unmarshal(cfgBytes, &diskCfg) == nil && len(diskCfg) > 0 {
			next["config"] = diskCfg
		}
	}
	encodedNext, err := json.Marshal(next)
	if err != nil {
		return
	}
	if string(encodedNext) == string(snapshot.NativeAuthJSON) {
		return
	}
	_ = accounts.UpdateNativeCredential(ctx, snapshot.AccountRef.String(), encodedNext, now)
}

func decryptZcodeMap(m map[string]any, secret string) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		if str, ok := v.(string); ok && zcodecred.IsEncrypted(str) {
			if plain, decOK := zcodecred.DecryptValue(str, secret); decOK {
				out[k] = plain
				continue
			}
		}
		out[k] = v
	}
	return out
}

func normalizeZcodeSecretPlatform() string {
	switch normalizePlatformKey("") {
	case "windows":
		return "win32"
	default:
		return normalizePlatformKey("")
	}
}

func firstNonEmptyString(values ...string) string {
	for _, v := range values {
		if trimmed := strings.TrimSpace(v); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
