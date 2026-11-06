// Package kirodb 只读解析 kiro CLI 的私有凭据库 data.sqlite3。
//
// Node 侧的参考实现是 lib/account/kiro-auth-metadata.js：
//   - 表 auth_kv(key TEXT PRIMARY KEY, value TEXT) 保存整份 CLI 键值状态；
//   - 三个凭据槽按官方 CLI 的检查顺序读取：odic、social、external-idp；
//   - aih 私有元数据行 aih:kiro:auth-meta 会合并进 token（token 字段优先）。
//
// 本包只做读取与形状归一，不创建、不迁移、不写入任何数据库文件。
package kirodb

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	_ "modernc.org/sqlite"
)

const (
	// maxAuthValueBytes 与 nativeaccount 的单一 artifact 上限一致；官方 CLI 的
	// token 行实测不足 1 KiB，放大到这个上限只为容忍未来字段增长。
	maxAuthValueBytes = 256 * 1024
	// busyTimeoutMillis 让读取方在 WAL 检查点等短暂写锁上等待，不立刻报 BUSY。
	busyTimeoutMillis = 5000
	authMetaKey       = "aih:kiro:auth-meta"
)

// ErrInvalidDatabase 表示凭据库不存在、不可读、结构不符或内容越界。
// 错误文本不携带任何 token 或行内容。
var ErrInvalidDatabase = errors.New("kiro 凭据数据库无效")

var kiroRegionPattern = regexp.MustCompile(`^[a-z]{2}-[a-z]+-\d$`)

// Auth 是一次成功读取的 token 与命中槽位。
type Auth struct {
	// Raw 是归一后的 JSON 对象，可直接作为 native_auth_json 的 auth 字段。
	Raw json.RawMessage
	// Slot 是命中的 auth_kv 键名，对应 Node 的 KIRO_TOKEN_SLOTS。
	Slot string
	// Flavour 是槽位对应的刷新/身份口径。
	Flavour string
}

// tokenSlots 的顺序必须与 Node 的 KIRO_TOKEN_SLOTS 完全一致：官方 CLI 是单账号
// 模型，三槽同时存在时无法从数据判断哪个当前生效，因此按 CLI 的检查顺序取第一个
// 可用槽。
var tokenSlots = []struct {
	key     string
	flavour string
}{
	{key: "kirocli:odic:token", flavour: "odic"},
	{key: "kirocli:social:token", flavour: "social"},
	{key: "kirocli:external-idp:token", flavour: "external-idp"},
}

// ReadAuth 以只读方式打开数据库并返回第一个可用槽位的 token。
//
// found=false 表示数据库没有可识别的 token 槽（例如空库或三槽都为空），调用方
// 应保持数据库里的现有凭据。任何 I/O、schema 或越界错误都返回 ErrInvalidDatabase，
// 调用方必须 fail-closed。
func ReadAuth(ctx context.Context, databasePath string) (Auth, bool, error) {
	if ctx == nil || strings.TrimSpace(databasePath) == "" {
		return Auth{}, false, ErrInvalidDatabase
	}
	exists, err := regularFileExists(databasePath)
	if err != nil || !exists {
		return Auth{}, false, err
	}
	database, err := openReadOnly(databasePath)
	if err != nil {
		return Auth{}, false, err
	}
	defer func() {
		_ = database.Close()
	}()

	meta, err := readMeta(ctx, database)
	if err != nil {
		return Auth{}, false, err
	}
	for _, slot := range tokenSlots {
		value, found, readErr := readValue(ctx, database, slot.key)
		if readErr != nil {
			return Auth{}, false, readErr
		}
		if !found {
			continue
		}
		token, usable := normalizeSlot(value)
		if !usable {
			continue
		}
		merged := make(map[string]json.RawMessage, len(meta)+len(token))
		for key, raw := range meta {
			merged[key] = raw
		}
		for key, raw := range token {
			merged[key] = raw
		}
		encoded, marshalErr := json.Marshal(merged)
		if marshalErr != nil {
			return Auth{}, false, ErrInvalidDatabase
		}
		return Auth{Raw: encoded, Slot: slot.key, Flavour: slot.flavour}, true, nil
	}
	return Auth{}, false, nil
}

// TokenBinding 复刻 Node lib/account/kiro-identity.js 的 kiroTokenBinding：
// sha256(JSON.stringify([endpoint, access_token, refresh_token]))。
//
// JSON.stringify 不转义 HTML 字符，也不带结尾换行；这里用 SetEscapeHTML(false)
// 后裁掉 Encoder 追加的换行，得到逐字节相同的输入。binding 是**同代指纹**，
// 不是可排序的代际：sha256 只能判断“是否同一份 grant”，不能判断新旧。
// 返回空串表示字段不满足 Node 的可比较前提（缺 access、越界、region 非法）。
func TokenBinding(auth map[string]json.RawMessage) string {
	access, ok := aliasString(auth, "access_token", "accessToken")
	if !ok || access == "" || access != strings.TrimSpace(access) || len(access) > maxAuthValueBytes {
		return ""
	}
	refresh, ok := aliasString(auth, "refresh_token", "refreshToken")
	if !ok || refresh != strings.TrimSpace(refresh) || len(refresh) > maxAuthValueBytes {
		return ""
	}
	endpoint := Endpoint(auth)
	if endpoint == "" {
		return ""
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode([]string{endpoint, access, refresh}); err != nil {
		return ""
	}
	encoded := bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'})
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

// Endpoint 复刻 Node kiroEndpoint：region 缺省 us-east-1，非法 region 返回空串。
func Endpoint(auth map[string]json.RawMessage) string {
	region := "us-east-1"
	if raw, exists := auth["region"]; exists && string(raw) != "null" {
		var value string
		if json.Unmarshal(raw, &value) != nil {
			return ""
		}
		region = value
	}
	if !kiroRegionPattern.MatchString(region) {
		return ""
	}
	return "https://codewhisperer." + region + ".amazonaws.com"
}

// openReadOnly 为每个连接固定只读、query_only 和 busy_timeout。
// query_only 是第二道保险：即使 DSN 被误改成可写，SQLite 也会拒绝任何写语句。
func openReadOnly(databasePath string) (*sql.DB, error) {
	fileURL := &url.URL{Scheme: "file", Path: filepath.ToSlash(databasePath)}
	query := fileURL.Query()
	query.Add("mode", "ro")
	query.Add("_pragma", "query_only(ON)")
	query.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", busyTimeoutMillis))
	fileURL.RawQuery = query.Encode()
	database, err := sql.Open("sqlite", fileURL.String())
	if err != nil {
		return nil, ErrInvalidDatabase
	}
	database.SetMaxOpenConns(1)
	database.SetMaxIdleConns(1)
	return database, nil
}

func regularFileExists(databasePath string) (bool, error) {
	info, err := os.Lstat(databasePath)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, ErrInvalidDatabase
	}
	// 与凭据 artifact 的约束一致：绝不跟随 symlink，避免读到投影根之外。
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return false, ErrInvalidDatabase
	}
	return true, nil
}

// readValue 用 length 与 substr 双重限制，避免为越界行分配巨大字符串。
func readValue(ctx context.Context, database *sql.DB, key string) (string, bool, error) {
	const query = `SELECT length(value), substr(value, 1, ?) FROM auth_kv WHERE key = ?`
	var length int64
	var value string
	err := database.QueryRowContext(ctx, query, maxAuthValueBytes, key).Scan(&length, &value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, ErrInvalidDatabase
	}
	if length <= 0 || length > maxAuthValueBytes || len(value) > maxAuthValueBytes {
		return "", false, ErrInvalidDatabase
	}
	return value, true, nil
}

// readMeta 与 Node 一致：aih 元数据行损坏时忽略（返回空对象），不因此拒绝整个
// token 槽。schema/I/O 错误仍然 fail-closed。
func readMeta(ctx context.Context, database *sql.DB) (map[string]json.RawMessage, error) {
	value, found, err := readValue(ctx, database, authMetaKey)
	if err != nil || !found {
		return nil, err
	}
	var object map[string]json.RawMessage
	if json.Unmarshal([]byte(value), &object) != nil || object == nil {
		return nil, nil
	}
	return object, nil
}

// normalizeSlot 按 Node normalizeKiroSlotToken 的语义收窄一个 token 行：
// 至少要有 access_token 或 refresh_token；对象形状不符、别名冲突或非字符串
// 字段视为不可用槽位（继续看下一个槽），不是数据库级错误。
func normalizeSlot(value string) (map[string]json.RawMessage, bool) {
	var object map[string]json.RawMessage
	if json.Unmarshal([]byte(value), &object) != nil || object == nil {
		return nil, false
	}
	if len(object) == 0 {
		return nil, false
	}
	access, accessOK := aliasString(object, "access_token", "accessToken")
	refresh, refreshOK := aliasString(object, "refresh_token", "refreshToken")
	if !accessOK || !refreshOK {
		return nil, false
	}
	if access == "" && refresh == "" {
		return nil, false
	}
	if raw, exists := object["region"]; exists && string(raw) != "null" {
		var region string
		if json.Unmarshal(raw, &region) != nil {
			return nil, false
		}
	}
	// nativeaccount 的 kiroIdentity 与 kiro.RebindIdentityEvidence 都以 snake_case
	// 为准；把 CLI 可能写出的 camelCase 别名归一掉，避免只认一种拼写。
	delete(object, "accessToken")
	delete(object, "refreshToken")
	if access != "" {
		object["access_token"] = mustJSON(access)
	}
	if refresh != "" {
		object["refresh_token"] = mustJSON(refresh)
	}
	return object, true
}

// aliasString 接受两种拼写，但拒绝冲突值和非字符串值（与 consistentSecretAlias 一致）。
func aliasString(object map[string]json.RawMessage, keys ...string) (string, bool) {
	selected := ""
	for _, key := range keys {
		raw, exists := object[key]
		if !exists || len(raw) == 0 || string(raw) == "null" {
			continue
		}
		var value string
		if json.Unmarshal(raw, &value) != nil {
			return "", false
		}
		if value == "" {
			continue
		}
		if selected != "" && selected != value {
			return "", false
		}
		selected = value
	}
	return selected, true
}

func mustJSON(value string) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage(`""`)
	}
	return encoded
}
