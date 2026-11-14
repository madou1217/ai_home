package aihserver

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeartifact"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/runtime/pluginhost"
	"github.com/madou1217/ai_home/internal/runtime/storagepolicy"
)

var errProjectionKeychainDisabled = errors.New("projection keychain disabled")

// pluginAccountRegistrar 把 Go 插件产出的沙箱认证投影文件解码、校验墓碑并注册到统一账号池。
type pluginAccountRegistrar struct {
	catalog  *providers.Catalog
	store    *sqliteaccount.Store
	importer *accountapp.AccountImporter
	decoder  *nativeaccount.Decoder
	now      func() time.Time
}

// newPluginAccountRegistrar 基于组合根依赖构造插件账号投影注册器；存储或导入用例未装配时返回 nil。
func newPluginAccountRegistrar(dependencies webuiRouteDependencies) pluginhost.AccountProjectionRegistrar {
	if dependencies.Store == nil || dependencies.AccountImporter == nil {
		return nil
	}
	return &pluginAccountRegistrar{
		catalog:  dependencies.Catalog,
		store:    dependencies.Store,
		importer: dependencies.AccountImporter,
		decoder:  nativeaccount.NewDecoder(),
		now:      time.Now,
	}
}

// RegisterProjection 从 runtimeDir 读取插件写入的投影凭据，执行墓碑校验并入库或刷新既有账号。
func (r *pluginAccountRegistrar) RegisterProjection(
	ctx context.Context,
	req pluginhost.ProjectionRegisterRequest,
) (pluginhost.ProjectionRegisterResult, error) {
	if r == nil || r.store == nil || r.importer == nil || r.decoder == nil {
		return pluginhost.ProjectionRegisterResult{
			Registered: false,
			Reason:     "invalid_registration_context",
		}, nil
	}

	rawProvider := strings.ToLower(strings.TrimSpace(req.Provider))
	if rawProvider == "" {
		return pluginhost.ProjectionRegisterResult{
			Registered: false,
			Reason:     "invalid_registration_context",
		}, nil
	}
	canonical := rawProvider
	if r.catalog != nil {
		resolved, ok := r.catalog.CanonicalID(rawProvider)
		if !ok {
			return pluginhost.ProjectionRegisterResult{
				Registered: false,
				Reason:     "unsupported_provider",
				Provider:   rawProvider,
			}, nil
		}
		canonical = resolved
	}

	runtimeDir := strings.TrimSpace(req.RuntimeDir)
	if runtimeDir == "" {
		return pluginhost.ProjectionRegisterResult{
			Registered: false,
			Reason:     "invalid_registration_context",
			Provider:   canonical,
		}, nil
	}

	credential, profile, reason := r.readAndDecodeRuntimeProjection(canonical, runtimeDir)
	if reason != "" {
		return pluginhost.ProjectionRegisterResult{
			Registered: false,
			Reason:     reason,
			Provider:   canonical,
		}, nil
	}

	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		return pluginhost.ProjectionRegisterResult{
			Registered: false,
			Reason:     "missing_identity",
			Provider:   canonical,
		}, nil
	}
	if requestedRef := strings.TrimSpace(req.AccountRef); requestedRef != "" && requestedRef != accountRef.String() {
		return pluginhost.ProjectionRegisterResult{
			Registered: false,
			Reason:     "account_ref_mismatch",
			Provider:   canonical,
			AccountRef: accountRef.String(),
		}, nil
	}

	if req.RespectDeletion {
		tombstoned, tombErr := r.store.IsAccountTombstoned(ctx, accountRef.String())
		if tombErr != nil {
			return pluginhost.ProjectionRegisterResult{}, tombErr
		}
		if tombstoned {
			return pluginhost.ProjectionRegisterResult{
				Registered: false,
				Reason:     "account_deleted_by_user",
				Provider:   canonical,
				AccountRef: accountRef.String(),
			}, nil
		}
	}

	imported, err := r.importer.Import(ctx, credential, profile)
	if err != nil {
		if errors.Is(err, accountapp.ErrAccountConflict) {
			return pluginhost.ProjectionRegisterResult{
				Registered: false,
				Reason:     "account_conflict",
				Provider:   canonical,
				AccountRef: accountRef.String(),
			}, nil
		}
		return pluginhost.ProjectionRegisterResult{}, err
	}

	account := imported.Account()
	if imported.Created() {
		now := r.now().UTC()
		if uiState, uiErr := accountcore.NewUIState(accountcore.UIStateInput{
			AccountRef:  account.Ref(),
			Status:      "up",
			DisplayName: pluginProfileDisplayName(profile),
			AuthMode:    r.defaultAuthMode(canonical),
			APIKeyMode:  false,
			Configured:  true,
			UpdatedAt:   now,
		}); uiErr == nil {
			if saveErr := r.store.ReplaceAccountUIState(ctx, uiState); saveErr != nil {
				return pluginhost.ProjectionRegisterResult{}, saveErr
			}
		}
	}

	return pluginhost.ProjectionRegisterResult{
		Registered:   true,
		Provider:     canonical,
		AccountRef:   account.Ref().String(),
		CLIAccountID: account.CLIAccountID().String(),
	}, nil
}

func (r *pluginAccountRegistrar) readAndDecodeRuntimeProjection(
	canonical string,
	runtimeDir string,
) (accountapp.Credential, accountapp.PublicProfile, string) {
	if canonical == "claude" || canonical == "codex" {
		reader := nativeartifact.New(nativeartifact.Options{
			UserHomeDir: func() (string, error) { return runtimeDir, nil },
			LookupEnv:   func(string) (string, bool) { return "", false },
			ReadClaudeSecureStorage: func(string, bool) (nativeartifact.ClaudeSecureStorageRecord, error) {
				return nativeartifact.ClaudeSecureStorageRecord{}, errProjectionKeychainDisabled
			},
		})
		artifacts, err := reader.Read(canonical)
		if err != nil {
			return nil, nil, "missing_projection"
		}
		defer clear(artifacts.Envelope)
		credential, profile, err := r.decoder.Decode(canonical, artifacts.Envelope)
		if err != nil || credential == nil {
			return nil, nil, "missing_identity"
		}
		return credential, profile, ""
	}

	policy := storagepolicy.Get(canonical)
	if policy == nil || len(policy.AuthArtifacts) == 0 {
		return nil, nil, "missing_projection"
	}

	nativeAuth := make(map[string]any, len(policy.AuthArtifacts))
	for _, artifact := range policy.AuthArtifacts {
		raw, err := readRuntimeArtifactFile(runtimeDir, policy.HostAuthRoot, artifact.Path)
		if err != nil {
			if artifact.Optional && errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, nil, "missing_projection"
		}
		value, parseErr := parsePluginProjectionArtifactValue(artifact.Format, raw)
		if parseErr != nil {
			return nil, nil, "invalid_projection"
		}
		if artifact.Field != "" {
			nativeAuth[artifact.Field] = value
		}
	}
	if len(nativeAuth) == 0 {
		return nil, nil, "missing_projection"
	}
	rawNative, err := json.Marshal(nativeAuth)
	if err != nil {
		return nil, nil, "invalid_projection"
	}
	defer clear(rawNative)
	envelope, err := json.Marshal(map[string]json.RawMessage{
		"native_auth_json": rawNative,
	})
	if err != nil {
		return nil, nil, "invalid_projection"
	}
	defer clear(envelope)
	credential, profile, err := r.decoder.Decode(canonical, envelope)
	if err != nil || credential == nil {
		return nil, nil, "missing_identity"
	}
	return credential, profile, ""
}

func readRuntimeArtifactFile(runtimeDir string, hostAuthRoot []string, artifactPath []string) ([]byte, error) {
	directPath := filepath.Join(append([]string{runtimeDir}, artifactPath...)...)
	raw, err := os.ReadFile(directPath)
	if err == nil || !errors.Is(err, os.ErrNotExist) || len(hostAuthRoot) == 0 {
		return raw, err
	}
	prefixed := make([]string, 0, 1+len(hostAuthRoot)+len(artifactPath))
	prefixed = append(prefixed, runtimeDir)
	prefixed = append(prefixed, hostAuthRoot...)
	prefixed = append(prefixed, artifactPath...)
	return os.ReadFile(filepath.Join(prefixed...))
}

func parsePluginProjectionArtifactValue(format string, raw []byte) (any, error) {
	switch format {
	case "text":
		return strings.TrimSpace(string(raw)), nil
	case "binary-base64":
		return base64.StdEncoding.EncodeToString(raw), nil
	default:
		var decoded any
		if err := json.Unmarshal(raw, &decoded); err != nil {
			return nil, err
		}
		return decoded, nil
	}
}

func (r *pluginAccountRegistrar) defaultAuthMode(canonical string) string {
	if r.catalog == nil {
		return string(providers.AuthModeOAuthBrowser)
	}
	definition, found := r.catalog.Get(canonical)
	if !found || len(definition.AuthOptions) == 0 {
		return string(providers.AuthModeOAuthBrowser)
	}
	for _, option := range definition.AuthOptions {
		if option.Value == providers.AuthModeOAuthBrowser {
			return string(option.Value)
		}
	}
	return string(definition.AuthOptions[0].Value)
}

func pluginProfileDisplayName(profile accountapp.PublicProfile) string {
	if profile == nil {
		return ""
	}
	if named, ok := profile.(interface{ Email() string }); ok {
		if email := strings.TrimSpace(named.Email()); email != "" {
			return email
		}
	}
	return ""
}
