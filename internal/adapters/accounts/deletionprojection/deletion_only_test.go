package deletionprojection_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/deletionprojection"
)

// jwtWithIssuer 生成带 iss/sub 的 JWT。CodeBuddy 家族的身份同时校验 access/refresh
// 的 iss 与 sub，domain 必须与 iss 的 host 一致。
func jwtWithIssuer(seconds int64, issuer, subject string) string {
	header := base64.RawURLEncoding.EncodeToString([]byte("{\"alg\":\"none\",\"typ\":\"JWT\"}"))
	payload := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(
		"{\"iat\":%d,\"exp\":%d,\"iss\":%q,\"sub\":%q}",
		seconds,
		seconds+3600,
		issuer,
		subject,
	)))
	return header + "." + payload + ".signature"
}

func codebuddyNativePayload(provider string) string {
	issuers := map[string]string{
		"codebuddy":   "https://www.codebuddy.ai/auth/realms/copilot",
		"codebuddycn": "https://copilot.tencent.com/auth/realms/copilot",
		"workbuddy":   "https://www.workbuddy.ai/auth/realms/copilot",
		"workbuddycn": "https://www.workbuddy.cn/auth/realms/copilot",
	}
	issuer := issuers[provider]
	host := strings.TrimPrefix(issuer, "https://")
	host = host[:strings.Index(host, "/")]
	uid := "user_" + provider + "_1"
	access := jwtWithIssuer(1_700_000_000, issuer, uid)
	refresh := jwtWithIssuer(1_700_000_000, issuer, uid)
	return fmt.Sprintf(
		"{\"credentials\":{\"auth\":{\"accessToken\":%q,\"refreshToken\":%q,\"domain\":%q},\"account\":{\"uid\":%q}}}",
		access,
		refresh,
		host,
		uid,
	)
}

// kimiNativePayload 对应 ~/.kimi-code/credentials/kimi-code.json 的落盘形态。
func kimiNativePayload() string {
	subject := "user_kimi_1"
	access := jwtWithIssuer(1_700_000_000, "https://kimi.example.invalid", subject)
	refresh := jwtWithIssuer(1_700_000_000, "https://kimi.example.invalid", subject)
	return fmt.Sprintf("{\"credentials\":{\"access_token\":%q,\"refresh_token\":%q}}", access, refresh)
}

type hostSnapshot map[string]string

// snapshotTree 记录宿主目录的完整形态：目录、文件字节（含权限）和链接目标。
// 删除投影必须让这份快照逐字节不变。
func snapshotTree(t *testing.T, root string) hostSnapshot {
	t.Helper()
	snapshot := hostSnapshot{}
	err := filepath.WalkDir(root, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if current == root {
			return nil
		}
		relative, err := filepath.Rel(root, current)
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			target, err := os.Readlink(current)
			if err != nil {
				return err
			}
			snapshot[relative] = "link:" + target
		case info.IsDir():
			snapshot[relative] = fmt.Sprintf("dir:%s", info.Mode().Perm())
		default:
			content, err := os.ReadFile(current)
			if err != nil {
				return err
			}
			snapshot[relative] = fmt.Sprintf("file:%s:%x", info.Mode().Perm(), sha256.Sum256(content))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func assertSnapshotsEqual(t *testing.T, before, after hostSnapshot) {
	t.Helper()
	keys := make([]string, 0, len(before)+len(after))
	for key := range before {
		keys = append(keys, key)
	}
	for key := range after {
		if _, found := before[key]; !found {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	for _, key := range keys {
		left, leftFound := before[key]
		right, rightFound := after[key]
		if !leftFound || !rightFound || left != right {
			t.Fatalf("宿主 %s 发生变化: before=%q after=%q", key, left, right)
		}
	}
}

// writeHostFile 写宿主 canonical 文件；投影里的同名文件只是它的账号副本。
func writeHostFile(t *testing.T, host string, segments []string, content string) {
	t.Helper()
	writeFile(t, filepath.Join(append([]string{host}, segments...)...), content)
}

// linkHostDir 建一个指回宿主的共享目录链接（sessions / projects 的真实形态）。
func linkHostDir(t *testing.T, root, host string, segments []string) {
	t.Helper()
	target := filepath.Join(append([]string{host}, segments...)...)
	writeFile(t, filepath.Join(target, "shared.jsonl"), "host-shared-"+strings.Join(segments, "/"))
	linkPath := filepath.Join(append([]string{root}, segments...)...)
	if err := os.MkdirAll(filepath.Dir(linkPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, linkPath); err != nil {
		t.Fatal(err)
	}
}

func writeFamilyProjection(t *testing.T, root, host, configRoot, authFile string) {
	t.Helper()
	authSegments := []string{
		"Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth", authFile,
	}
	// 宿主 canonical 登录态：删除投影绝不能碰它。
	writeHostFile(t, host, authSegments, "host-encrypted-"+authFile)
	writeHostFile(t, host, []string{configRoot, "settings.json"}, "host-settings")
	writeHostFile(t, host, []string{configRoot, "logs", "cli.log"}, "host-log")
	linkHostDir(t, root, host, []string{configRoot, "projects"})

	private := [][]string{
		authSegments,
		{"electron-user-data", "Default", "Local Storage", "leveldb", "000003.log"},
		{".workbuddy-key-fallback", "keyblob"},
		{configRoot, "sessions", "session-index.json"},
		{configRoot, ".mcp.json"},
		{configRoot, "diagnostics", "trace.log"},
		{"Library", "Keychains", "login.keychain-db"},
		{"Library", "Application Support", "CodeBuddyExtension", "Cache", "data_0"},
		{"Library", "Application Support", "CodeBuddyExtension", "Logs", "app.log"},
		// 调研清单之外的运行时日志也只属于这份一次性投影，必须随整根删除。
		{configRoot, "logs", "runtime.log"},
	}
	for _, segments := range private {
		writeFile(
			t,
			filepath.Join(append([]string{root}, segments...)...),
			"account-private-"+strings.Join(segments, "/"),
		)
	}
}

func writeKimiProjection(t *testing.T, root, host string) {
	t.Helper()
	// 宿主 canonical 凭据与 session 索引；投影里的是账号副本/视图。
	writeHostFile(t, host, []string{".kimi-code", "credentials", "kimi-code.json"}, "host-kimi-credential")
	writeHostFile(t, host, []string{".kimi-code", "session_index.jsonl"}, "host-canonical-index")
	linkHostDir(t, root, host, []string{".kimi-code", "sessions"})

	private := [][]string{
		{".kimi-code", "credentials", "kimi-code.json"},
		{".kimi-code", "device_id"},
		{".kimi-code", "config.toml"},
		{".kimi-code", "session_index.jsonl"},
		{"electron-user-data", "Cache", "data_1"},
		// 清单之外的遥测目录同样随整根删除。
		{".kimi-code", "telemetry", "events.log"},
	}
	for _, segments := range private {
		writeFile(
			t,
			filepath.Join(append([]string{root}, segments...)...),
			"account-private-"+strings.Join(segments, "/"),
		)
	}
}

func runDeletionOnlyCase(
	t *testing.T,
	provider string,
	payload string,
	writeProjection func(t *testing.T, root, host string),
) {
	t.Helper()
	ctx := context.Background()
	aiHome := realDir(t)
	hostHome := realDir(t)
	catalog := mustCatalog(t)

	stored := mustNativeCredential(t, provider, payload)
	account := mustAccount(t, catalog, stored)
	root := projectionRoot(aiHome, provider, account.Ref().String())
	writeProjection(t, root, hostHome)

	beforeHost := snapshotTree(t, hostHome)
	beforePayload := string(stored.Payload())

	snapshot, err := accountapp.NewCredentialSnapshot(
		account.Ref(), provider, stored, time.UnixMilli(1000).UTC(),
	)
	if err != nil {
		t.Fatal(err)
	}
	credentials := &memoryCredentialStore{snapshot: snapshot}
	preparer, err := deletionprojection.New(deletionprojection.Options{
		AIHomeDir:   aiHome,
		HostHomeDir: hostHome,
		Credentials: credentials,
		Clock:       func() time.Time { return time.UnixMilli(2000).UTC() },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := preparer.PrepareAccountDeletion(ctx, account); err != nil {
		t.Fatalf("删除准备失败: %v", err)
	}

	if _, err := os.Lstat(root); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("投影应被删除, lstat err = %v", err)
	}
	assertSnapshotsEqual(t, beforeHost, snapshotTree(t, hostHome))
	if credentials.replacements != 0 {
		t.Fatalf("不 adopt 的 Provider 不应改写库内凭据, replacements = %d", credentials.replacements)
	}
	current := credentials.snapshot.Credential().(*accountcore.NativeCredential)
	if string(current.Payload()) != beforePayload {
		t.Fatal("库内凭据被投影改写")
	}
}

// TestDeletionOnlyProviderRemovesProjectionAndKeepsHost 覆盖家族四支与 kimi：
// 删除后整棵投影根消失，宿主 ~/.codebuddy*、Application Support/CodeBuddy*、
// ~/.kimi-code 逐字节不变，且数据库凭据不被采纳。
func TestDeletionOnlyProviderRemovesProjectionAndKeepsHost(t *testing.T) {
	family := []struct {
		provider   string
		configRoot string
		authFile   string
	}{
		{"codebuddy", ".codebuddy", "Tencent-Cloud.coding-copilot.info"},
		{"codebuddycn", ".codebuddy-cn", "workbuddy-desktop.info"},
		{"workbuddy", ".workbuddy-ai", "workbuddy-desktop-ai.info"},
		{"workbuddycn", ".workbuddy", "workbuddy-desktop.info"},
	}
	for _, testCase := range family {
		testCase := testCase
		t.Run(testCase.provider, func(t *testing.T) {
			runDeletionOnlyCase(
				t,
				testCase.provider,
				codebuddyNativePayload(testCase.provider),
				func(t *testing.T, root, host string) {
					writeFamilyProjection(t, root, host, testCase.configRoot, testCase.authFile)
				},
			)
		})
	}
	t.Run("kimi", func(t *testing.T) {
		runDeletionOnlyCase(t, "kimi", kimiNativePayload(), writeKimiProjection)
	})
	t.Run("zcode", func(t *testing.T) {
		runDeletionOnlyCase(t, "zcode", zcodeNativePayload(), writeZcodeProjection)
	})
}

func zcodeNativePayload() string {
	const uid = "zcode_user_1"
	userInfo := fmt.Sprintf("{\"user_id\":%q,\"email\":\"zcode@example.com\"}", uid)
	jwt := jwtWithIssuer(1_700_000_000, "https://zcode.example.invalid", uid)
	payload := strings.Replace(jwt, "}", "", 1)
	_ = payload
	// zcode decoder accepts user_id/sub in zcodejwttoken matching oauth:zai:user_info.
	header := base64.RawURLEncoding.EncodeToString([]byte("{\"alg\":\"none\",\"typ\":\"JWT\"}"))
	claims := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(
		"{\"user_id\":%q,\"sub\":%q,\"iat\":1700000000,\"exp\":1700003600}", uid, uid,
	)))
	zcodeJWT := header + "." + claims + ".signature"
	return fmt.Sprintf(
		"{\"credentials\":{\"zcodejwttoken\":%q,\"oauth:zai:access_token\":%q,\"oauth:zai:user_info\":%q}}",
		zcodeJWT, zcodeJWT, userInfo,
	)
}

func writeZcodeProjection(t *testing.T, root, host string) {
	t.Helper()
	writeHostFile(t, host, []string{".zcode", "settings.json"}, "host-zcode-settings")
	linkHostDir(t, root, host, []string{".zcode", "projects"})
	private := [][]string{
		{".zcode", "auth.db"},
		{".zcode", "credentials", "enc.json"},
		{"electron-user-data", "Local Storage", "leveldb", "000001.log"},
	}
	for _, segments := range private {
		writeFile(
			t,
			filepath.Join(append([]string{root}, segments...)...),
			"account-private-"+strings.Join(segments, "/"),
		)
	}
}
