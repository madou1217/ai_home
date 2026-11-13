package kirostorage

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountprojection"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/kirodb"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

var (
	// ErrUnsupportedCredential 表示凭据不是 Kiro 原生 OAuth。
	ErrUnsupportedCredential = errors.New("kiro projection requires native oauth credential")
	// ErrIdentityMismatch 表示投影文件里的账号与当前账号不是同一身份，绝不能回写。
	ErrIdentityMismatch = errors.New("kiro projection identity mismatch")
)

const (
	databaseName = "data.sqlite3"
	// bootstrapTimeout 与 Node BOOTSTRAP_TIMEOUT_MS 一致。
	bootstrapTimeout = 30 * time.Second
)

var sqliteMagic = []byte("SQLite format 3\x00")

// Materializer 把 Kiro 凭据写成 CLI 读取的 data.sqlite3，并读取续期结果。
type Materializer struct{}

// ProviderID 返回 Kiro 规范 Provider ID。
func (Materializer) ProviderID() string { return ProviderID }

// Materialize 优先写账号快照里的整库快照；没有快照时写 CLI 同构的裸库（auth_kv）。
func (Materializer) Materialize(
	ctx context.Context,
	request accountprojection.Request,
	_ accountprojection.Policy,
	root string,
) ([]accountprojection.ArtifactWrite, error) {
	if request.ProviderID != ProviderID || root == "" {
		return nil, accountprojection.ErrInvalidProjectionRequest
	}
	native, ok := request.Credential.(*accountcore.NativeCredential)
	if !ok || native == nil || native.ProviderID() != ProviderID {
		return nil, ErrUnsupportedCredential
	}
	path := filepath.Join(root, databaseName)
	if _, err := os.Stat(path); err == nil {
		return nil, nil
	}
	database, auth, err := splitPayload(native.Payload())
	if err != nil {
		return nil, ErrUnsupportedCredential
	}
	if database != "" {
		decoded, decodeErr := base64.StdEncoding.DecodeString(database)
		if decodeErr == nil && bytes.HasPrefix(decoded, sqliteMagic) {
			return []accountprojection.ArtifactWrite{{Path: path, Data: decoded, Mode: 0o600}}, nil
		}
	}
	if len(auth) == 0 {
		return nil, ErrUnsupportedCredential
	}
	rows, err := bareRows(auth)
	if err != nil {
		return nil, ErrUnsupportedCredential
	}
	if err := writeBareDatabase(path, rows); err != nil {
		return nil, err
	}
	bootstrapCLIDatabase(ctx, path, request.HostHomeDir)
	return nil, nil
}

// Capture 读取 auth_kv 槽位并合并回当前凭据（保留 identityEvidence）。
func (Materializer) Capture(
	ctx context.Context,
	request accountprojection.Request,
	_ accountprojection.Policy,
	root string,
) (accountapp.Credential, bool, error) {
	if request.ProviderID != ProviderID || root == "" {
		return nil, false, accountprojection.ErrInvalidProjectionRequest
	}
	current, ok := request.Credential.(*accountcore.NativeCredential)
	if !ok || current == nil {
		return nil, false, ErrUnsupportedCredential
	}
	path := filepath.Join(root, databaseName)
	auth, found, err := kirodb.ReadAuth(ctx, path)
	if err != nil {
		return nil, false, err
	}
	if !found {
		return nil, false, nil
	}
	document := map[string]any{}
	if err := json.Unmarshal(current.Payload(), &document); err != nil {
		return nil, false, err
	}
	if _, exists := document["identityEvidence"]; !exists {
		// 没有身份证据就无法重新验证身份，保持账号库不变。
		return nil, false, nil
	}
	document["auth"] = json.RawMessage(auth.Raw)
	// 客户端续期会换 token，tokenBinding 必须跟着更新，否则身份校验仍在用旧 grant 的指纹。
	var authObject map[string]json.RawMessage
	if err := json.Unmarshal(auth.Raw, &authObject); err == nil {
		if binding := kirodb.TokenBinding(authObject); binding != "" {
			if evidence, ok := document["identityEvidence"].(map[string]any); ok {
				evidence["tokenBinding"] = binding
				document["identityEvidence"] = evidence
			}
		}
	}
	if raw, readErr := os.ReadFile(path); readErr == nil && len(raw) > 0 && len(raw) <= 4*1024*1024 {
		document["database"] = base64.StdEncoding.EncodeToString(raw)
	}
	payload, err := json.Marshal(document)
	if err != nil {
		return nil, false, err
	}
	envelope, err := json.Marshal(map[string]json.RawMessage{"native_auth_json": payload})
	if err != nil {
		return nil, false, err
	}
	next, _, err := nativeaccount.NewDecoder().Decode(ProviderID, envelope)
	if err != nil {
		return nil, false, err
	}
	nextNative, ok := next.(*accountcore.NativeCredential)
	if !ok || nextNative == nil {
		return nil, false, ErrUnsupportedCredential
	}
	if current.IdentitySeed() != nextNative.IdentitySeed() {
		return nil, false, ErrIdentityMismatch
	}
	return nextNative, true, nil
}

// ShouldAdopt 用 Node 的 tokenBinding 判断是否同一份 grant；不同才回写。
func (Materializer) ShouldAdopt(current accountapp.Credential, next accountapp.Credential) bool {
	currentAuth, currentOK := authObjectOf(current)
	nextAuth, nextOK := authObjectOf(next)
	if !currentOK || !nextOK {
		return false
	}
	currentBinding := kirodb.TokenBinding(currentAuth)
	nextBinding := kirodb.TokenBinding(nextAuth)
	if nextBinding == "" || currentBinding == "" {
		return false
	}
	return currentBinding != nextBinding
}

func authObjectOf(credential accountapp.Credential) (map[string]json.RawMessage, bool) {
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil {
		return nil, false
	}
	var document struct {
		Auth json.RawMessage `json:"auth"`
	}
	if err := json.Unmarshal(native.Payload(), &document); err != nil || len(document.Auth) == 0 {
		return nil, false
	}
	var auth map[string]json.RawMessage
	if err := json.Unmarshal(document.Auth, &auth); err != nil || auth == nil {
		return nil, false
	}
	return auth, true
}

// splitPayload 从 native_auth_json 里取出 database（base64 文本）与 auth。
func splitPayload(payload []byte) (string, json.RawMessage, error) {
	if len(payload) == 0 {
		return "", nil, ErrUnsupportedCredential
	}
	var document struct {
		Database string          `json:"database"`
		Auth     json.RawMessage `json:"auth"`
	}
	if err := json.Unmarshal(payload, &document); err != nil {
		return "", nil, err
	}
	return document.Database, document.Auth, nil
}

// bareRows 按 Node buildKiroAuthKvRows 的默认分支写入 odic 槽。
func bareRows(auth json.RawMessage) (map[string]string, error) {
	var object map[string]any
	if err := json.Unmarshal(auth, &object); err != nil || object == nil {
		return nil, ErrUnsupportedCredential
	}
	value, err := json.Marshal(object)
	if err != nil {
		return nil, err
	}
	return map[string]string{"kirocli:odic:token": string(value)}, nil
}

// writeBareDatabase 原子写一个只有 auth_kv 表的裸库。
func writeBareDatabase(path string, rows map[string]string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".kiro-db-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	_ = temp.Close()
	defer os.Remove(tempPath)
	database, err := sql.Open("sqlite", tempPath)
	if err != nil {
		return err
	}
	if _, err := database.Exec("CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT)"); err != nil {
		_ = database.Close()
		return err
	}
	for key, value := range rows {
		if _, err := database.Exec("INSERT INTO auth_kv(key, value) VALUES(?, ?)", key, value); err != nil {
			_ = database.Close()
			return err
		}
	}
	if err := database.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tempPath, 0o600); err != nil {
		return err
	}
	return os.Rename(tempPath, path)
}

// bootstrapCLIDatabase 复刻 Node 的 CLI schema 自举：让 kiro-cli 在临时路径上
// 跑完全部迁移，再把裸库的 auth_kv 行搬进去。失败保持裸库原样（调用方继续启动）。
func bootstrapCLIDatabase(ctx context.Context, databasePath string, hostHomeDir string) {
	if !isBareDatabase(databasePath) {
		return
	}
	cliPath, err := exec.LookPath("kiro-cli")
	if err != nil {
		return
	}
	directory := filepath.Dir(databasePath)
	tempDir, err := os.MkdirTemp(directory, ".aih-kiro-schema-*")
	if err != nil {
		return
	}
	defer os.RemoveAll(tempDir)
	schemaPath := filepath.Join(tempDir, databaseName)
	runCtx, cancel := context.WithTimeout(ctx, bootstrapTimeout)
	defer cancel()
	command := exec.CommandContext(runCtx, cliPath, "settings", "list")
	command.Env = bootstrapEnvironment(hostHomeDir, schemaPath)
	if err := command.Run(); err != nil {
		return
	}
	if !hasMigrationsTable(schemaPath) {
		return
	}
	rows, err := readAuthRows(databasePath)
	if err != nil {
		return
	}
	if err := replaceAuthRows(schemaPath, rows); err != nil {
		return
	}
	if err := os.Chmod(schemaPath, 0o600); err != nil {
		return
	}
	_ = os.Rename(schemaPath, databasePath)
}

func bootstrapEnvironment(hostHomeDir string, schemaPath string) []string {
	env := make([]string, 0, len(os.Environ())+4)
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if name == "KIRO_HOME" || name == "KIRO_API_KEY" || name == "KIRO_TEST_DB_PATH" {
			continue
		}
		env = append(env, entry)
	}
	if hostHomeDir != "" {
		env = append(env, "HOME="+hostHomeDir, "USERPROFILE="+hostHomeDir)
	}
	return append(env, "KIRO_TEST_DB_PATH="+schemaPath)
}

func isBareDatabase(path string) bool {
	tables := listTables(path)
	return tables["auth_kv"] && !tables["migrations"]
}

func hasMigrationsTable(path string) bool {
	return listTables(path)["migrations"]
}

func listTables(path string) map[string]bool {
	result := map[string]bool{}
	database, err := sql.Open("sqlite", path)
	if err != nil {
		return result
	}
	defer database.Close()
	rows, err := database.Query("SELECT name FROM sqlite_master WHERE type = 'table'")
	if err != nil {
		return result
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if rows.Scan(&name) == nil {
			result[name] = true
		}
	}
	return result
}

func readAuthRows(path string) (map[string]string, error) {
	database, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	defer database.Close()
	rows, err := database.Query("SELECT key, value FROM auth_kv")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]string{}
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		result[key] = value
	}
	return result, rows.Err()
}

func replaceAuthRows(path string, rows map[string]string) error {
	database, err := sql.Open("sqlite", path)
	if err != nil {
		return err
	}
	defer database.Close()
	if _, err := database.Exec("DELETE FROM auth_kv"); err != nil {
		return err
	}
	for key, value := range rows {
		if _, err := database.Exec("INSERT INTO auth_kv(key, value) VALUES(?, ?)", key, value); err != nil {
			return err
		}
	}
	return nil
}

var _ = fmt.Sprintf
var _ fs.FileInfo
