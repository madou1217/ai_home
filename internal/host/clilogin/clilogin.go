// Package clilogin 执行非 CodeBuddy 家族 Provider 的原生 CLI 登录。
//
// 与 Node 的 CLI 登录作业同语义：为一个作业准备一次性运行目录与配置根，
// 把官方 CLI 放进 PTY 交互（授权链接、提示菜单由作业层处理），结束后读取
// CLI 自己落盘的凭据文件、解码并注册账号。它不修改宿主真实登录态，也不
// 清理运行目录（与 Node 的 run/login/<provider>/auth-<job> 一致，便于排障）。
//
// 支持范围由 providerSpecs 声明：当前只有 agy（native-cli 登录方式）。
// 未声明的 Provider 明确返回 ErrUnsupportedProvider，不回退 Node 路径。
package clilogin

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/application/providerruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/host/credentialregister"
	"github.com/madou1217/ai_home/internal/runtime/providercli"
	"github.com/madou1217/ai_home/internal/runtime/pty"
	"github.com/madou1217/ai_home/internal/runtime/ptyhost"
	"github.com/madou1217/ai_home/internal/runtime/storagepolicy"
)

var (
	// ErrInvalidOptions 表示登录缺少数据目录或终端 I/O。
	ErrInvalidOptions = errors.New("CLI 登录参数无效")
	// ErrUnsupportedProvider 表示该 Provider 的 CLI 登录还没迁到 Go。
	ErrUnsupportedProvider = errors.New("CLI 登录 Provider 尚未迁移")
	// ErrCredentialMissing 表示 CLI 退出后没有写出可用的凭据文件。
	ErrCredentialMissing = errors.New("登录后未找到 CLI 凭据文件")
)

// Options 是一次交互式 CLI 登录的输入。
type Options struct {
	AIHomeDir   string
	HostHomeDir string
	ProviderID  string
	Stdin       io.Reader
	Stdout      io.Writer
	Stderr      io.Writer
}

// providerSpec 声明单个 Provider 的登录差异。
//
// layout 返回该 Provider 的配置根（相对一次性运行目录）与登录进程环境；
// readCredential 读取 CLI 落盘的凭据并包成 nativeaccount 的 envelope。
type providerSpec struct {
	layout         func(catalog *providers.Catalog, hostHomeDir, runtimeDir string) (configDir string, env map[string]string, err error)
	readCredential func(configDir string) ([]byte, error)
}

// providerSpecs 是已迁移 Provider 的唯一注册点。
var providerSpecs = map[string]providerSpec{
	"agy": {layout: agyLayout, readCredential: agyCredential},
}

// Supported 判断 Provider 的原生 CLI 登录是否已由 Go 承接。
func Supported(providerID string) bool {
	_, ok := providerSpecs[providerruntime.NormalizeProvider(providerID)]
	return ok
}

// Run 执行一次交互式登录并返回新注册/更新的账号。
func Run(ctx context.Context, options Options) (accountcore.Account, error) {
	providerID := providerruntime.NormalizeProvider(options.ProviderID)
	spec, ok := providerSpecs[providerID]
	if !ok {
		return accountcore.Account{}, fmt.Errorf("%w: %s", ErrUnsupportedProvider, providerID)
	}
	if strings.TrimSpace(options.AIHomeDir) == "" ||
		options.Stdin == nil || options.Stdout == nil || options.Stderr == nil {
		return accountcore.Account{}, ErrInvalidOptions
	}
	if ctx == nil {
		ctx = context.Background()
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return accountcore.Account{}, err
	}
	definition, found := catalog.Get(providerID)
	if !found || definition.CLI == nil {
		return accountcore.Account{}, fmt.Errorf("%w: %s", ErrUnsupportedProvider, providerID)
	}
	runtimeDir, err := newRuntimeDir(options.AIHomeDir, providerID)
	if err != nil {
		return accountcore.Account{}, err
	}
	configDir, env, err := spec.layout(catalog, options.HostHomeDir, runtimeDir)
	if err != nil {
		return accountcore.Account{}, err
	}
	workspaceDir := filepath.Join(runtimeDir, "workspace")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return accountcore.Account{}, fmt.Errorf("创建登录配置目录失败: %w", err)
	}
	if err := os.MkdirAll(workspaceDir, 0o700); err != nil {
		return accountcore.Account{}, fmt.Errorf("创建登录工作目录失败: %w", err)
	}
	// 登录作业要拿到授权链接而不是弹宿主浏览器：BROWSER 指向只回显 URL 的脚本。
	capture, err := browserCapture(runtimeDir)
	if err != nil {
		return accountcore.Account{}, fmt.Errorf("创建浏览器捕获脚本失败: %w", err)
	}
	env["BROWSER"] = capture
	binaryName := strings.TrimSpace(definition.CLI.BinaryName)
	if binaryName == "" {
		// 与入口探测同口径：没有显式 BinaryName 时按 Provider ID 找同名可执行文件。
		binaryName = definition.ID
	}
	binaryPath, err := providercli.ResolveBinary(providerID, binaryName)
	if err != nil {
		return accountcore.Account{}, fmt.Errorf("%s 官方 CLI 不存在: %w", providerID, err)
	}
	code, runErr := ptyhost.Run(ctx, ptyhost.Config{
		Path:    binaryPath,
		Args:    append([]string(nil), definition.CLI.LoginArgs...),
		Env:     environmentList(env),
		Dir:     workspaceDir,
		Stdin:   options.Stdin,
		Stdout:  options.Stdout,
		Starter: pty.NewStarter(),
	})
	if runErr != nil {
		var exitErr *ptyhost.ExitError
		if !errors.As(runErr, &exitErr) {
			return accountcore.Account{}, runErr
		}
	}
	// 成功以「CLI 写出凭据文件」为准：浏览器授权完成后 CLI 可能以非零码退出
	//（用户收尾、TUI 异常），Node 的登录作业同样只看凭据产物。
	envelope, credentialErr := spec.readCredential(configDir)
	if credentialErr != nil {
		return accountcore.Account{}, credentialFailure(providerID, code, credentialErr)
	}
	credential, profile, err := nativeaccount.NewDecoder().Decode(providerID, envelope)
	if err != nil {
		return accountcore.Account{}, fmt.Errorf("解码登录凭据失败: %w", err)
	}
	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
		AIHomeDir: options.AIHomeDir,
		Catalog:   catalog,
	})
	if err != nil {
		return accountcore.Account{}, fmt.Errorf("打开账号数据库失败: %w", err)
	}
	defer store.Close()
	return credentialregister.Register(ctx, store, catalog, credential, profile, options.Stderr)
}

// credentialFailure 在缺少凭据时才把非零退出码并入错误；有凭据时退出码不影响结果。
func credentialFailure(providerID string, code int, credentialErr error) error {
	if code != 0 {
		return fmt.Errorf("%s login 退出码 %d: %w", providerID, code, credentialErr)
	}
	return credentialErr
}

// newRuntimeDir 返回 <aiHome>/run/login/<provider>/auth-<随机后缀>。
//
// 与 Node resolveLoginRuntimeDir 同布局；随机后缀让同一 Provider 的并发作业
// 各自拥有独立配置根，不会互相覆盖凭据。
func newRuntimeDir(aiHomeDir string, providerID string) (string, error) {
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return filepath.Join(aiHomeDir, "run", "login", providerID, "auth-"+hex.EncodeToString(raw)), nil
}

// baseEnvironment 返回去掉宿主账号键与 Provider 配置根的进程环境。
//
// 登录进程必须从干净环境起步：宿主自己的 API Key / 配置根会把「这次登录」
// 变成「复用宿主身份」。
func baseEnvironment(hostHomeDir string) map[string]string {
	env := make(map[string]string, 64)
	for _, entry := range os.Environ() {
		name, value, found := strings.Cut(entry, "=")
		if !found || name == "" {
			continue
		}
		env[name] = value
	}
	env = providerruntime.StripAccountScopedEnv(env)
	return providerruntime.BuildHostScopedBaseEnv(env, hostHomeDir)
}

// environmentList 把环境 map 转成稳定排序的 KEY=VALUE 列表。
func environmentList(env map[string]string) []string {
	names := make([]string, 0, len(env))
	for name := range env {
		names = append(names, name)
	}
	sort.Strings(names)
	list := make([]string, 0, len(names))
	for _, name := range names {
		list = append(list, name+"="+env[name])
	}
	return list
}

// configDirFor 复刻 Node resolveProviderConfigDir：globalDir + configSubDir。
func configDirFor(definition providers.Definition, runtimeDir string) string {
	globalDir := strings.TrimSpace(definition.CLI.GlobalDir)
	if globalDir == "" {
		globalDir = "." + definition.ID
	}
	if subDir := strings.TrimSpace(definition.CLI.ConfigSubDir); subDir != "" {
		return filepath.Join(runtimeDir, globalDir, subDir)
	}
	return filepath.Join(runtimeDir, globalDir)
}

// agyLayout 复刻 Node agy-strategy 的登录环境。
//
// agy 把 OAuth 写死在 $HOME 下，所以 HOME 必须指向一次性运行目录；所有可配置
// 的辅助根重指到 Provider 自己的运行 home，避免每个作业都复制工具链缓存。
func agyLayout(catalog *providers.Catalog, hostHomeDir, runtimeDir string) (string, map[string]string, error) {
	definition, found := catalog.Get("agy")
	if !found || definition.CLI == nil {
		return "", nil, fmt.Errorf("%w: agy", ErrUnsupportedProvider)
	}
	configDir := configDirFor(definition, runtimeDir)
	env := baseEnvironment(hostHomeDir)
	env["HOME"] = runtimeDir
	env["USERPROFILE"] = runtimeDir
	if runtimeHome := storagepolicy.ResolveRuntimeHomeRoot(hostHomeDir, "agy"); runtimeHome != "" {
		env["XDG_CONFIG_HOME"] = filepath.Join(runtimeHome, "xdg", "config")
		env["XDG_DATA_HOME"] = filepath.Join(runtimeHome, "xdg", "data")
		env["XDG_STATE_HOME"] = filepath.Join(runtimeHome, "xdg", "state")
		env["XDG_CACHE_HOME"] = filepath.Join(runtimeHome, "xdg", "cache")
		env["GEMINI_CLI_SYSTEM_SETTINGS_PATH"] = filepath.Join(runtimeHome, ".gemini", "settings.json")
		if runtime.GOOS == "windows" {
			env["APPDATA"] = filepath.Join(runtimeHome, "AppData", "Roaming")
			env["LOCALAPPDATA"] = filepath.Join(runtimeHome, "AppData", "Local")
		}
	}
	// agy 读宿主 Keychain 会造成跨账号串号：伪装成远端/容器外壳，强制走投影文件。
	// 四个变量必须成组出现，agy 1.x 会检查 SSH_CONNECTION。
	env["SSH_CONNECTION"] = "127.0.0.1 12345 127.0.0.1 22"
	env["SSH_CLIENT"] = "127.0.0.1 12345 22"
	env["SSH_TTY"] = "/dev/tty"
	env["container"] = "docker"
	env["WSL_DISTRO_NAME"] = "Ubuntu"
	// 可再生工具链缓存留在宿主，避免每个登录作业都复制一份多 GB 缓存。
	if strings.TrimSpace(hostHomeDir) != "" {
		env["CARGO_HOME"] = filepath.Join(hostHomeDir, ".cargo")
		env["GOPATH"] = filepath.Join(hostHomeDir, "go")
		env["GOMODCACHE"] = filepath.Join(hostHomeDir, "go", "pkg", "mod")
		env["GOCACHE"] = filepath.Join(hostHomeDir, ".cache", "go-build")
		env["npm_config_cache"] = filepath.Join(hostHomeDir, ".npm")
	}
	return configDir, env, nil
}

// agyCredential 读取 CLI 落盘的 antigravity-oauth-token 并包成 native_auth_json。
//
// 邮箱取 token 文档里的 id_token_email，缺失时回落到 CLI 的 email.cache。
// 没有 access_token / refresh_token 视为未完成登录。
func agyCredential(configDir string) ([]byte, error) {
	document, err := readJSONDocument(filepath.Join(configDir, "antigravity-oauth-token"))
	if err != nil {
		return nil, err
	}
	if document == nil {
		return nil, ErrCredentialMissing
	}
	token, _ := document["token"].(map[string]any)
	accessToken := stringField(token, "access_token")
	refreshToken := stringField(token, "refresh_token")
	if strings.TrimSpace(accessToken) == "" && strings.TrimSpace(refreshToken) == "" {
		return nil, ErrCredentialMissing
	}
	email := stringField(document, "id_token_email")
	if strings.TrimSpace(email) == "" {
		if raw, readErr := os.ReadFile(filepath.Join(configDir, "email.cache")); readErr == nil {
			email = strings.TrimSpace(string(raw))
		}
	}
	native, err := json.Marshal(map[string]any{
		"email":      strings.TrimSpace(email),
		"oauthToken": document,
	})
	if err != nil {
		return nil, err
	}
	return json.Marshal(map[string]json.RawMessage{"native_auth_json": native})
}

// readJSONDocument 读取 JSON 对象；文件缺失返回 (nil, nil)，损坏按缺失处理。
func readJSONDocument(path string) (map[string]any, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	if len(raw) == 0 || len(raw) > 1024*1024 {
		return nil, ErrCredentialMissing
	}
	document := map[string]any{}
	if err := json.Unmarshal(raw, &document); err != nil {
		return nil, nil
	}
	return document, nil
}

func stringField(object map[string]any, key string) string {
	if object == nil {
		return ""
	}
	value, _ := object[key].(string)
	return value
}
