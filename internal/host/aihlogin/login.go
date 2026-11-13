// Package aihlogin 执行 CodeBuddy / WorkBuddy 家族的原生 CLI 登录。
//
// 流程：临时 fake-home 投影 → PTY 运行官方 codebuddy → 读取共享 .info →
// nativeaccount 解码 → 注册账号 → 清理临时投影。它不经过 Node 登录 Job，
// 也不修改宿主真实登录态。
package aihlogin

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
	"time"

	appprojection "github.com/madou1217/ai_home/application/accountprojection"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	codebuddyfamilycli "github.com/madou1217/ai_home/internal/adapters/codebuddyfamily/clilaunch"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage"
	codebuddyfamilystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codebuddyfamily"
	runtimeprojection "github.com/madou1217/ai_home/internal/runtime/accountprojection"
	"github.com/madou1217/ai_home/internal/runtime/pty"
	"github.com/madou1217/ai_home/internal/runtime/ptyhost"
)

var (
	// ErrInvalidOptions 表示登录缺少数据目录或终端 I/O。
	ErrInvalidOptions = errors.New("CodeBuddy 登录参数无效")
	// ErrUnsupportedProvider 表示不是 CodeBuddy 家族 Provider。
	ErrUnsupportedProvider = errors.New("CodeBuddy 登录 Provider 不受支持")
	// ErrCredentialMissing 表示 CLI 退出后没有写出 .info。
	ErrCredentialMissing = errors.New("登录后未找到 CodeBuddy 凭据文件")
)

// Options 是一次交互式登录的输入。
type Options struct {
	AIHomeDir   string
	HostHomeDir string
	ProviderID  string
	Stdin       io.Reader
	Stdout      io.Writer
	Stderr      io.Writer
}

// Run 执行登录并返回新注册/更新的账号。
func Run(ctx context.Context, options Options) (accountcore.Account, error) {
	providerID := strings.ToLower(strings.TrimSpace(options.ProviderID))
	if !codebuddyfamilystorage.IsFamilyProvider(providerID) ||
		strings.TrimSpace(options.AIHomeDir) == "" ||
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
	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
		AIHomeDir: options.AIHomeDir,
		Catalog:   catalog,
	})
	if err != nil {
		return accountcore.Account{}, fmt.Errorf("打开账号数据库失败: %w", err)
	}
	defer store.Close()

	registry := providerstorage.New()
	provisioner, err := runtimeprojection.New(runtimeprojection.Options{
		AIHomeDir:     options.AIHomeDir,
		Policies:      registry,
		Materializers: registry.Materializers(),
		Linker:        runtimeprojection.NewLinker(),
		Credentials:   store,
	})
	if err != nil {
		return accountcore.Account{}, fmt.Errorf("创建登录投影失败: %w", err)
	}
	accountRefText, err := temporaryAccountRef()
	if err != nil {
		return accountcore.Account{}, err
	}
	accountRef, err := accountcore.ParseAccountRef(accountRefText)
	if err != nil {
		return accountcore.Account{}, err
	}
	result, err := provisioner.Prepare(ctx, appprojection.Request{
		ProviderID:         providerID,
		AccountRef:         accountRef,
		HostHomeDir:        options.HostHomeDir,
		Purpose:            appprojection.PurposeLogin,
		ProjectionRequired: true,
	})
	if err != nil {
		return accountcore.Account{}, fmt.Errorf("准备登录投影失败: %w", err)
	}
	defer removeProjection(result.Root)

	env := mergedEnvironment(
		withoutEnvironmentKeys(os.Environ(), codebuddyfamilycli.NeverInheritKeys()),
		result.SetEnv,
	)
	if codebuddyfamilystorage.SiteInternal(providerID) {
		env = mergedEnvironment(env, map[string]string{
			"CODEBUDDY_INTERNET_ENVIRONMENT":         "internal",
			"CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT": "internal",
		})
	}
	cwd, _ := os.Getwd()
	code, runErr := ptyhost.Run(ctx, ptyhost.Config{
		Path:    "codebuddy",
		Env:     env,
		Dir:     cwd,
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
	if code != 0 {
		return accountcore.Account{}, fmt.Errorf("codebuddy login 退出码 %d", code)
	}
	credential, profile, err := readCredential(providerID, result.Root)
	if err != nil {
		return accountcore.Account{}, err
	}
	accountRef, err = accountcore.DeriveAccountRef(credential)
	if err != nil {
		return accountcore.Account{}, fmt.Errorf("派生登录账号身份失败: %w", err)
	}
	// 已存在同一身份时走原子凭据替换；只有新身份才注册。
	if overview, overviewErr := store.GetAccountOverview(ctx, accountRef); overviewErr == nil {
		if err := replaceExisting(ctx, store, catalog, accountRef, credential, profile); err != nil {
			return accountcore.Account{}, err
		}
		account := overview.Account()
		_, _ = fmt.Fprintf(options.Stderr, "登录成功: %s #%d (%s)\n",
			account.ProviderID(), account.CLIAccountID().Int64(), account.Ref())
		return account, nil
	} else if !errors.Is(overviewErr, accountapp.ErrAccountNotFound) {
		return accountcore.Account{}, fmt.Errorf("检查登录账号是否存在失败: %w", overviewErr)
	}
	request, err := accountapp.NewRegistrationRequest(catalog, credential, profile, time.Now())
	if err != nil {
		return accountcore.Account{}, fmt.Errorf("构造账号注册请求失败: %w", err)
	}
	account, err := store.RegisterNew(ctx, request)
	if err != nil {
		return accountcore.Account{}, fmt.Errorf("注册登录账号失败: %w", err)
	}
	_, _ = fmt.Fprintf(options.Stderr, "登录成功: %s #%d (%s)\n",
		account.ProviderID(), account.CLIAccountID().Int64(), account.Ref())
	return account, nil
}

// withoutEnvironmentKeys 删除宿主上的家族账号/站点变量：登录进程必须从干净环境
// 起步，否则宿主 CODEBUDDY_API_KEY / 站点选择会决定这次登录拿到的身份。
func withoutEnvironmentKeys(environment []string, names []string) []string {
	blocked := make(map[string]bool, len(names))
	for _, name := range names {
		blocked[name] = true
	}
	filtered := make([]string, 0, len(environment))
	for _, entry := range environment {
		name, _, found := strings.Cut(entry, "=")
		if !found || blocked[name] {
			continue
		}
		filtered = append(filtered, entry)
	}
	return filtered
}

// mergedEnvironment 用 overlay 覆盖同名变量，避免重复 HOME 让子进程读宿主值。
func mergedEnvironment(base []string, overlay map[string]string) []string {
	values := make(map[string]string, len(base)+len(overlay))
	order := make([]string, 0, len(base)+len(overlay))
	for _, entry := range base {
		name, value, found := strings.Cut(entry, "=")
		if !found || name == "" {
			continue
		}
		if _, exists := values[name]; !exists {
			order = append(order, name)
		}
		values[name] = value
	}
	for name, value := range overlay {
		if name == "" {
			continue
		}
		if _, exists := values[name]; !exists {
			order = append(order, name)
		}
		values[name] = value
	}
	result := make([]string, 0, len(order))
	for _, name := range order {
		result = append(result, name+"="+values[name])
	}
	return result
}

func replaceExisting(
	ctx context.Context,
	store *sqliteaccount.Store,
	catalog *providers.Catalog,
	accountRef accountcore.AccountRef,
	credential accountapp.Credential,
	profile accountapp.PublicProfile,
) error {
	snapshot, err := store.GetCredentialSnapshot(ctx, accountRef)
	if err != nil {
		return fmt.Errorf("读取现有登录凭据失败: %w", err)
	}
	now := time.Now()
	if !now.After(snapshot.UpdatedAt()) {
		now = snapshot.UpdatedAt().Add(time.Millisecond)
	}
	replacement, err := accountapp.NewCredentialReplacement(snapshot, credential, now)
	if err != nil {
		return fmt.Errorf("构造登录凭据替换失败: %w", err)
	}
	if err := store.ReplaceCredential(ctx, replacement); err != nil {
		return fmt.Errorf("更新登录凭据失败: %w", err)
	}
	if profile != nil {
		profileSnapshot, snapshotErr := accountapp.NewProfileSnapshot(catalog, profile, now)
		if snapshotErr != nil {
			return fmt.Errorf("构造登录资料失败: %w", snapshotErr)
		}
		if err := store.UpsertProfile(ctx, profileSnapshot); err != nil {
			return fmt.Errorf("更新登录资料失败: %w", err)
		}
	}
	return nil
}

func temporaryAccountRef() (string, error) {
	raw := make([]byte, 10)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return "acct_" + hex.EncodeToString(raw), nil
}

func removeProjection(root string) {
	if strings.TrimSpace(root) == "" {
		return
	}
	_ = os.RemoveAll(root)
}

// readCredential 读取投影共享 auth 目录里最新的 .info，并包成 decoder 需要的 envelope。
func readCredential(providerID string, root string) (accountapp.Credential, accountapp.PublicProfile, error) {
	directory := filepath.Join(append([]string{root}, codebuddyfamilystorage.AuthDirSegments(runtime.GOOS)...)...)
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, nil, ErrCredentialMissing
	}
	type candidate struct {
		path    string
		modTime time.Time
	}
	candidates := make([]candidate, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name()), ".info") {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			continue
		}
		candidates = append(candidates, candidate{
			path:    filepath.Join(directory, entry.Name()),
			modTime: info.ModTime(),
		})
	}
	if len(candidates) == 0 {
		return nil, nil, ErrCredentialMissing
	}
	sort.Slice(candidates, func(left, right int) bool {
		return candidates[left].modTime.After(candidates[right].modTime)
	})
	raw, err := os.ReadFile(candidates[0].path)
	if err != nil || len(raw) == 0 || len(raw) > 1024*1024 {
		return nil, nil, ErrCredentialMissing
	}
	inner, err := json.Marshal(map[string]json.RawMessage{
		"credentials": raw,
	})
	if err != nil {
		return nil, nil, err
	}
	envelope, err := json.Marshal(map[string]json.RawMessage{
		"native_auth_json": inner,
	})
	if err != nil {
		return nil, nil, err
	}
	decoder := nativeaccount.NewDecoder()
	credential, profile, err := decoder.Decode(providerID, envelope)
	if err != nil {
		return nil, nil, fmt.Errorf("解码登录凭据失败: %w", err)
	}
	return credential, profile, nil
}
