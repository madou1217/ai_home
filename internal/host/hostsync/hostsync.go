// Package hostsync 把账号库里的凭据同步到宿主原生配置，供 aih 之外启动的 CLI 使用。
//
// 这是 Node lib/account/host-sync.js 的非家族子集：只实现显式 set-default 需要的
// 「单文件/单目录可写」Provider；cline 的整库合并、zcode 的宿主密钥重加密仍留给 Node。
package hostsync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	agyprojection "github.com/madou1217/ai_home/internal/adapters/agy/projection"
)

// ErrUnsupportedProvider 表示该 Provider 的宿主同步还没迁到 Go。
var ErrUnsupportedProvider = errors.New("host sync provider 尚未迁移")

// ErrMissingCredential 表示账号库里没有可写的原生凭据。
var ErrMissingCredential = errors.New("账号缺少可同步的原生凭据")

// Options 是一次宿主同步的输入。
type Options struct {
	AIHomeDir   string
	HostHomeDir string
	ProviderID  string
	AccountRef  string
}

// Result 描述本次写出的文件。
type Result struct {
	Files []string
}

// Sync 把指定账号的凭据写到宿主原生配置。
func Sync(ctx context.Context, options Options) (Result, error) {
	providerID := strings.ToLower(strings.TrimSpace(options.ProviderID))
	if options.AIHomeDir == "" || options.HostHomeDir == "" || options.AccountRef == "" {
		return Result{}, fmt.Errorf("%w: 参数不完整", ErrUnsupportedProvider)
	}
	switch providerID {
	case "gemini", "agy", "grok", "opencode", "qoder", "qodercn":
	default:
		return Result{}, fmt.Errorf("%w: %s", ErrUnsupportedProvider, providerID)
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return Result{}, err
	}
	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{AIHomeDir: options.AIHomeDir, Catalog: catalog})
	if err != nil {
		return Result{}, err
	}
	defer store.Close()
	ref, err := accountcore.ParseAccountRef(options.AccountRef)
	if err != nil {
		return Result{}, err
	}
	snapshot, err := store.GetCredentialSnapshot(ctx, ref)
	if err != nil {
		return Result{}, err
	}
	native, ok := snapshot.Credential().(*accountcore.NativeCredential)
	if !ok || native == nil || native.ProviderID() != providerID {
		return Result{}, ErrMissingCredential
	}
	return writeHost(providerID, native.Payload(), options.HostHomeDir)
}

func writeHost(providerID string, payload []byte, hostHomeDir string) (Result, error) {
	switch providerID {
	case "gemini":
		var document struct {
			OAuthCreds     json.RawMessage `json:"oauthCreds"`
			GoogleAccounts json.RawMessage `json:"googleAccounts"`
		}
		if err := json.Unmarshal(payload, &document); err != nil || len(document.OAuthCreds) == 0 {
			return Result{}, ErrMissingCredential
		}
		files := []string{filepath.Join(hostHomeDir, ".gemini", "oauth_creds.json")}
		if err := writeFileAtomic(files[0], document.OAuthCreds); err != nil {
			return Result{}, err
		}
		if len(document.GoogleAccounts) > 0 {
			path := filepath.Join(hostHomeDir, ".gemini", "google_accounts.json")
			if err := writeFileAtomic(path, document.GoogleAccounts); err != nil {
				return Result{}, err
			}
			files = append(files, path)
		}
		return Result{Files: files}, nil
	case "agy":
		credential, err := nativeaccount.NewDecoder().DecodeNativeAuth("agy", payload)
		if err != nil {
			return Result{}, ErrMissingCredential
		}
		auth, ok := credential.(*agy.OAuthAuth)
		if !ok || auth == nil {
			return Result{}, ErrMissingCredential
		}
		if err := agyprojection.WriteGlobalAuth(hostHomeDir, auth); err != nil {
			return Result{}, err
		}
		return Result{Files: []string{filepath.Join(hostHomeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token")}}, nil
	case "grok":
		return writeJSONField(providerID, payload, "auth", filepath.Join(hostHomeDir, ".grok", "auth.json"))
	case "opencode":
		return writeJSONField(providerID, payload, "auth", filepath.Join(hostHomeDir, ".local", "share", "opencode", "auth.json"))
	case "qoder", "qodercn":
		var document struct {
			Credentials string `json:"credentials"`
			MachineID   string `json:"machineId"`
		}
		if err := json.Unmarshal(payload, &document); err != nil || strings.TrimSpace(document.Credentials) == "" {
			return Result{}, ErrMissingCredential
		}
		root := filepath.Join(hostHomeDir, "."+providerID, ".auth")
		files := []string{filepath.Join(root, "user")}
		if err := os.MkdirAll(root, 0o700); err != nil {
			return Result{}, err
		}
		if err := writeFileAtomic(files[0], []byte(document.Credentials)); err != nil {
			return Result{}, err
		}
		if strings.TrimSpace(document.MachineID) != "" {
			path := filepath.Join(root, "machine_id")
			if err := writeFileAtomic(path, []byte(document.MachineID)); err != nil {
				return Result{}, err
			}
			files = append(files, path)
		}
		return Result{Files: files}, nil
	}
	return Result{}, fmt.Errorf("%w: %s", ErrUnsupportedProvider, providerID)
}

func writeJSONField(providerID string, payload []byte, field string, target string) (Result, error) {
	var document map[string]json.RawMessage
	if err := json.Unmarshal(payload, &document); err != nil {
		return Result{}, ErrMissingCredential
	}
	value := document[field]
	if len(value) == 0 {
		return Result{}, ErrMissingCredential
	}
	if err := writeFileAtomic(target, value); err != nil {
		return Result{}, err
	}
	return Result{Files: []string{target}}, nil
}

// writeFileAtomic 以 0600 原子写入宿主配置（保留 JSON 语义，不追加换行）。
func writeFileAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".aih-host-sync-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempPath, path)
}
