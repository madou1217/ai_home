// Package projection 把刷新后的 agy 凭据物化到运行投影目录。
//
// Node 参照：lib/account/native-auth-projection.js（materializeProviderAuth 的 agy 分支）
// 与 lib/runtime/provider-storage-policy.js（agy.authArtifacts）。Node 在刷新成功后按
// 账本快照重写 agy 的全部投影文件；Go 接管刷新后只写账本时，已经启动的 CLI 会话与
// 账号配置文件页仍看到旧 token，这里补齐同一步物化。
//
// agy 的投影根是**伪 HOME**（$AIH_HOME/run/auth-projections/agy/<accountRef>），CLI 把
// $HOME/.gemini/antigravity-cli 写死，五份文件的相对路径与 Node 声明逐字一致：
//
//	oauthToken          .gemini/antigravity-cli/antigravity-oauth-token  (json, 必选)
//	desktopOauthToken   .gemini/jetski-standalone-oauth-token            (json, 派生)
//	email               .gemini/antigravity-cli/email.cache              (text, 可选)
//	oauthCreds          .gemini/oauth_creds.json                         (json, 派生)
//	googleAccounts      .gemini/google_accounts.json                     (json, 派生)
package projection

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/internal/adapters/agy/authmeta"
)

// ErrInvalidInput 表示缺少数据根、账号引用或凭据。
var ErrInvalidInput = errors.New("agy 投影参数无效")

const (
	antigravityTokenFile = ".gemini/antigravity-cli/antigravity-oauth-token"
	desktopTokenFile     = ".gemini/jetski-standalone-oauth-token"
	emailCacheFile       = ".gemini/antigravity-cli/email.cache"
	oauthCredsFile       = ".gemini/oauth_creds.json"
	googleAccountsFile   = ".gemini/google_accounts.json"

	projectionFileMode os.FileMode = 0o600
	projectionDirMode  os.FileMode = 0o700

	// isoTimestampLayout 与 JS Date#toISOString() 同形（固定三位毫秒 + Z）。
	// Node 写 expiry 用 toISOString()，Go 用 RFC3339Nano 会把 .000 省略，
	// 两边同步同一份凭据时看起来像「字段变了」，统一成毫秒形态。
	isoTimestampLayout = "2006-01-02T15:04:05.000Z"
)

// Write 把刷新后的凭据物化成 agy 的五份投影文件。
//
// 目录不存在表示账号还没有启动过运行时：此时不创建目录——Node 的启动物化
// （account-app-launcher.materializeProviderAuthOnLaunch / provider-runtime-env）
// 会在第一次启动时按账本补全，提前造一份只有凭据、没有会话链接的投影反而会
// 让宿主把所有会话都当成待迁移资源。
func Write(aiHomeDir string, accountRef string, auth *agy.OAuthAuth) error {
	if aiHomeDir == "" || accountRef == "" || auth == nil {
		return ErrInvalidInput
	}
	runtimeDir := filepath.Join(aiHomeDir, "run", "auth-projections", "agy", accountRef)
	info, err := os.Stat(runtimeDir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	if !info.IsDir() {
		return nil
	}

	expiresAtMS := auth.ExpiresAtMS()
	refreshedAtMS := auth.RefreshedAtMS()
	cliDocument := buildCLITokenDocument(auth, expiresAtMS, refreshedAtMS)

	// antigravity-oauth-token 是 CLI 的规范凭据文件；jetski-standalone-oauth-token
	// 是桌面端 --app_data_dir antigravity 时回退读的 standalone 副本。Node 把
	// **同一份文档**写到这两个路径，所以先以规范文件为底合并一次，再写两份相同内容。
	// 返回值是合并后的完整文档：oauth_creds.json 由它派生，CLI 自己写的 id_token
	// 才不会在派生时丢掉。
	tokenDocument, err := writeCLITokenDocuments(runtimeDir, cliDocument)
	if err != nil {
		return err
	}
	email := strings.TrimSpace(auth.Email())
	// email.cache 是 CLI 的纯文本邮箱缓存：re-key（Google 侧改名）后必须跟着变，
	// 否则界面/选号仍显示旧邮箱。
	if err := writeTextFile(filepath.Join(runtimeDir, emailCacheFile), email); err != nil {
		return err
	}

	// oauth_creds.json / google_accounts.json 是**纯派生**的兼容文件：Node
	// resolveProjectionSource 用 buildAgyGeminiOAuthCredentials / buildAgyGoogleAccounts
	// 从 oauthToken/email 重新生成整份文档，再整份覆盖（不是合并），所以这里也整份写。
	// 来源是刚才写进 CLI 的同一份 oauthToken 文档 —— CLI 自己写进去的 id_token 因此
	// 能带过来；账号库里没有 id_token 时该键按 Node 的展开语法省略。
	rawToken, err := json.Marshal(tokenDocument)
	if err != nil {
		return err
	}
	if credentials, ok := authmeta.BuildGeminiOAuthCredentials(rawToken); ok {
		if err := writeJSONDocument(filepath.Join(runtimeDir, oauthCredsFile), credentials); err != nil {
			return err
		}
	} else if err := removeFileIfExists(filepath.Join(runtimeDir, oauthCredsFile)); err != nil {
		return err
	}
	// active 指向本账号、old 清空：保留旧列表会让 re-key 前的邮箱以「可切换账号」的
	// 形式留在 CLI 里。
	if accounts, ok := authmeta.BuildGoogleAccounts(email); ok {
		return writeJSONDocument(filepath.Join(runtimeDir, googleAccountsFile), accounts)
	}
	return removeFileIfExists(filepath.Join(runtimeDir, googleAccountsFile))
}

// writeCLITokenDocuments 把同一份 oauthToken 文档写到规范路径与桌面端副本。
//
// 以规范文件（antigravity-oauth-token）为底合并：Node 的语义是两个文件内容一致，
// 而未知键只能从 CLI 自己写的规范文件里来。
func writeCLITokenDocuments(runtimeDir string, patch map[string]any) (map[string]any, error) {
	document, err := readJSONObject(filepath.Join(runtimeDir, antigravityTokenFile))
	if err != nil {
		return nil, err
	}
	mergeDocument(document, patch)
	if err := writeJSONDocument(filepath.Join(runtimeDir, antigravityTokenFile), document); err != nil {
		return nil, err
	}
	if err := writeJSONDocument(filepath.Join(runtimeDir, desktopTokenFile), document); err != nil {
		return nil, err
	}
	return document, nil
}

// buildCLITokenDocument 构造 antigravity CLI 的 oauthToken 文档。
//
// 字段对应 Node agy-token-refresh.js persistAgyOAuthSnapshot：auth_method 归一为
// consumer、token 里 expiry 是 ISO、expires_at_ms/refreshed_at_ms 是毫秒、根上
// last_refresh 记录刷新时刻。Node 另外把整份文档原样写进 jetski 副本。
func buildCLITokenDocument(auth *agy.OAuthAuth, expiresAtMS int64, refreshedAtMS int64) map[string]any {
	token := map[string]any{
		"access_token":  auth.AccessToken(),
		"refresh_token": auth.RefreshToken(),
		"token_type":    auth.TokenType(),
		"expiry":        formatISOTime(expiresAtMS),
		"expires_at_ms": expiresAtMS,
	}
	// refreshed_at_ms 是凭据代际（Node 与 Go 都按它判断谁更新）。原生 artifact
	// 没记录刷新时间时保持字段缺失，而不是写 0 —— 0 会被读成「1970 年刷新过」。
	if refreshedAtMS > 0 {
		token["refreshed_at_ms"] = refreshedAtMS
	}
	document := map[string]any{
		"auth_method": authmeta.AuthMethodConsumer,
		// id_token_email 是 CLI 文件里的账号邮箱快照。Node 靠「捕获整份文档再原样
		// 写回」保留它；Go 的领域凭据只保留邮箱，所以这里显式重写，re-key 后才不会
		// 残留旧邮箱。
		"id_token_email": strings.TrimSpace(auth.Email()),
		"token":          token,
	}
	if refreshedAtMS > 0 {
		document["last_refresh"] = formatISOTime(refreshedAtMS)
	}
	return document
}

// formatISOTime 按 JS toISOString() 的形态输出 UTC 毫秒时间。
func formatISOTime(epochMS int64) string {
	return time.UnixMilli(epochMS).UTC().Format(isoTimestampLayout)
}

// readJSONObject 读取 JSON 对象；文件缺失或内容损坏时按空对象处理（Node
// readArtifact 同样把损坏文件当成「没有数据」并让投影重写自愈）。
func readJSONObject(path string) (map[string]any, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return map[string]any{}, nil
		}
		return nil, err
	}
	document := map[string]any{}
	if err := newJSONDecoder(raw).Decode(&document); err != nil {
		return map[string]any{}, nil
	}
	return document, nil
}

// newJSONDecoder 用 UseNumber 解析：凭据与 settings 里的整数不能被 float64 往返改写。
func newJSONDecoder(raw []byte) *json.Decoder {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	return decoder
}

func mergeDocument(document map[string]any, patch map[string]any) {
	for key, value := range patch {
		if nested, ok := value.(map[string]any); ok {
			child, _ := document[key].(map[string]any)
			if child == nil {
				child = make(map[string]any)
			}
			mergeDocument(child, nested)
			document[key] = child
			continue
		}
		document[key] = value
	}
}

// writeTextFile 原子写入纯文本投影（email.cache 等）。
func writeTextFile(path string, value string) error {
	return writeFileWithMode(path, []byte(value), projectionFileMode)
}

// writeJSONDocument 原子写入整份 JSON 文档；缩进与结尾换行对齐 Node
// writeArtifactAtomic 的 JSON.stringify(value, null, 2) + "\n"。
func writeJSONDocument(path string, document any) error {
	raw, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return err
	}
	return writeFileWithMode(path, append(raw, '\n'), projectionFileMode)
}

// removeFileIfExists 对应 Node removeArtifact：派生字段没有数据时删掉旧文件，
// 而不是留一份过期内容。
func removeFileIfExists(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// writeFileWithMode 原子替换目标文件（临时文件 + rename），权限只作用于新文件。
func writeFileWithMode(path string, data []byte, mode fs.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), projectionDirMode); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".agy-projection-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	// 先落权限再写内容：中途失败也不会留下 0644 的临时凭据文件。
	if err := temporary.Chmod(mode); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}
