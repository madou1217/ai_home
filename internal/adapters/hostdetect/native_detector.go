package hostdetect

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeartifact"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/runtime/storagepolicy"
)

const (
	maxDetectorArtifactBytes = 1024 * 1024
	overviewQueryPageLimit   = 200
	loginShellTimeout        = 3 * time.Second
	defaultDetectServerPort  = 9527
)

var (
	errDetectorHostKeychainDisabled = errors.New("测试隔离目录禁止读取本机钥匙串")
	// allDetectorProviders 与原 Node host-account-detectors 保持同集合。
	allDetectorProviders = []string{
		"codebuddy",
		"codebuddycn",
		"workbuddy",
		"workbuddycn",
		"cline",
		"agy",
		"claude",
		"codex",
		"gemini",
		"grok",
		"kimi",
		"opencode",
		"qoder",
		"qodercn",
		"zcode",
	}
	hostAuthProjectionProviders = []string{
		"agy",
		"claude",
		"codex",
		"gemini",
		"grok",
		"kimi",
		"opencode",
		"qoder",
		"qodercn",
		"zcode",
	}
	hostEnvAPIKeySpecs = []envAPIKeySpec{
		{Provider: "codex", APIKeys: []string{"OPENAI_API_KEY"}, BaseURLKey: "OPENAI_BASE_URL"},
		{Provider: "gemini", APIKeys: []string{"GEMINI_API_KEY", "GOOGLE_API_KEY"}},
		{Provider: "claude", APIKeys: []string{"ANTHROPIC_API_KEY"}, BaseURLKey: "ANTHROPIC_BASE_URL"},
		{Provider: "opencode", APIKeys: []string{"OPENCODE_API_KEY"}, BaseURLKey: "OPENCODE_BASE_URL"},
		{Provider: "grok", APIKeys: []string{"XAI_API_KEY"}, BaseURLKey: "XAI_BASE_URL"},
		{Provider: "kimi", APIKeys: []string{"MOONSHOT_API_KEY"}, BaseURLKey: "KIMI_BASE_URL"},
		{Provider: "zcode", APIKeys: []string{"ZCODE_API_KEY"}, BaseURLKey: "ZCODE_BASE_URL"},
		{Provider: "codebuddy", APIKeys: []string{"CODEBUDDY_API_KEY"}, BaseURLKey: "CODEBUDDY_BASE_URL"},
		{Provider: "codebuddycn", APIKeys: []string{"CODEBUDDY_API_KEY"}, BaseURLKey: "CODEBUDDY_BASE_URL"},
		{Provider: "workbuddy", APIKeys: []string{"CODEBUDDY_API_KEY"}, BaseURLKey: "CODEBUDDY_BASE_URL"},
		{Provider: "workbuddycn", APIKeys: []string{"CODEBUDDY_API_KEY"}, BaseURLKey: "CODEBUDDY_BASE_URL"},
		{Provider: "cline", APIKeys: []string{"CLINE_API_KEY"}, BaseURLKey: "CLINE_API_BASE_URL"},
	}
)

type envAPIKeySpec struct {
	Provider   string
	APIKeys    []string
	BaseURLKey string
}

// RegisteredAccount 描述一次扫描中新登记或更新的账号明细。
type RegisteredAccount struct {
	AccountRef   string `json:"accountRef"`
	CLIAccountID string `json:"cliAccountId"`
	Created      bool   `json:"created"`
	Provider     string `json:"provider,omitempty"`
	Source       string `json:"source,omitempty"`
}

// SkippedAccount 描述被跳过来源的原因、Provider 与位置标签。
type SkippedAccount struct {
	Reason     string `json:"reason"`
	Provider   string `json:"provider,omitempty"`
	Source     string `json:"source,omitempty"`
	AccountRef string `json:"accountRef,omitempty"`
}

// DetectResponse 对齐 Node `/v0/internal/accounts/detect` 与 WebUI 扫描接口响应契约。
type DetectResponse struct {
	OK         bool                `json:"ok"`
	Scanned    int                 `json:"scanned"`
	Updated    int                 `json:"updated"`
	Reloaded   bool                `json:"reloaded"`
	Registered []RegisteredAccount `json:"registered"`
	Skipped    []SkippedAccount    `json:"skipped"`
	Accounts   map[string]int      `json:"accounts"`
}

// NativeDetectorOptions 定义纯 Go 本机账号扫描器的全部依赖与测试注入点。
type NativeDetectorOptions struct {
	AIHomeDir   string
	HostHomeDir string
	Store       *sqliteaccount.Store
	Catalog     *providers.Catalog
	Importer    *accountapp.AccountImporter
	Reload      func(ctx context.Context) error
	Clock       func() time.Time

	// 以下为可选注入点，生产环境留空时自动访问宿主文件系统、环境变量与系统运行时。
	LookupEnv       func(string) (string, bool)
	Environ         func() []string
	LoginShellEnv   func(ctx context.Context, names []string) (map[string]string, error)
	ReadKeychain    func(service string) ([]byte, error)
	DecodeWorkbuddy func(ctx context.Context, rawJSON []byte, providerID string) ([]byte, error)
	DPAPIUnprotect  func(ctx context.Context, cipher []byte) ([]byte, error)
	OSPlatform      string
	VendorElectron  string
	CodecScriptPath string
	UserDataRoots   []string
	VolumeRoots     []string
	ServerPort      int
	ManagementKey   func() string
	ClientKey       func() string
}

// NativeDetector 在 Go 进程内完成 5 类宿主账号发现并直接写入 sqliteaccount.Store。
type NativeDetector struct {
	options NativeDetectorOptions
	catalog *providers.Catalog
	decoder *nativeaccount.Decoder
	clock   func() time.Time
}

// NewNativeDetector 构造实现 webuiaccountdetectapi.Detector 的原生 Go 检测器。
func NewNativeDetector(options NativeDetectorOptions) *NativeDetector {
	catalog := options.Catalog
	if catalog == nil {
		catalog, _ = providers.NewCatalog(providers.BuiltinManifest())
	}
	clock := options.Clock
	if clock == nil {
		clock = time.Now
	}
	return &NativeDetector{
		options: options,
		catalog: catalog,
		decoder: nativeaccount.NewDecoder(),
		clock:   clock,
	}
}

// Detect 按顺序执行 codebuddy-family、cline、host-auth-projection、host-api-key、host-env-api-key 五组扫描。
func (detector *NativeDetector) Detect(ctx context.Context) (int, []byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	aiHomeDir := strings.TrimSpace(detector.options.AIHomeDir)
	hostHomeDir := strings.TrimSpace(detector.options.HostHomeDir)
	if hostHomeDir == "" && detector.options.LookupEnv == nil {
		if home, err := os.UserHomeDir(); err == nil {
			hostHomeDir = strings.TrimSpace(home)
		}
	}
	if detector == nil || aiHomeDir == "" || hostHomeDir == "" || detector.options.Store == nil || detector.catalog == nil {
		return http.StatusServiceUnavailable, []byte(`{"ok":false,"error":"detect_host_accounts_unavailable"}`), nil
	}

	importer := detector.options.Importer
	if importer == nil {
		registrar, err := accountapp.NewRegistrar(detector.catalog, detector.options.Store, detector.clock)
		if err != nil {
			return http.StatusInternalServerError, []byte(`{"ok":false,"error":"detect_host_accounts_unavailable"}`), nil
		}
		reauth, err := accountapp.NewReauthenticator(detector.catalog, detector.options.Store, detector.clock)
		if err != nil {
			return http.StatusInternalServerError, []byte(`{"ok":false,"error":"detect_host_accounts_unavailable"}`), nil
		}
		importer, err = accountapp.NewAccountImporter(registrar, detector.options.Store, reauth)
		if err != nil {
			return http.StatusInternalServerError, []byte(`{"ok":false,"error":"detect_host_accounts_unavailable"}`), nil
		}
	}

	guard := detector.newSelfWriteGuard(aiHomeDir)
	run := &detectSession{
		detector:    detector,
		ctx:         ctx,
		aiHomeDir:   aiHomeDir,
		hostHomeDir: hostHomeDir,
		store:       detector.options.Store,
		importer:    importer,
		guard:       guard,
		result: DetectResponse{
			OK:         true,
			Registered: []RegisteredAccount{},
			Skipped:    []SkippedAccount{},
			Accounts:   make(map[string]int, len(allDetectorProviders)),
		},
	}

	groups := []struct {
		id       string
		provider string
		fn       func(*detectSession) bool
	}{
		{id: "codebuddy-family", provider: "codebuddy", fn: (*detectSession).detectCodebuddyFamily},
		{id: "cline", provider: "cline", fn: (*detectSession).detectCline},
		{id: "host-auth-projection", provider: "agy", fn: (*detectSession).detectHostAuthProjections},
		{id: "host-api-key", provider: "codex", fn: (*detectSession).detectHostAPIKeys},
		{id: "host-env-api-key", provider: "codex", fn: (*detectSession).detectHostEnvAPIKeys},
	}

	completed := 0
	for _, group := range groups {
		if ctx.Err() != nil {
			run.addSkip("host_account_detector_cancelled", group.provider, group.id, "")
			continue
		}
		if group.fn(run) {
			completed++
		} else {
			run.addSkip("host_account_detector_unavailable", group.provider, group.id, "")
		}
	}

	if completed == 0 {
		return http.StatusInternalServerError, []byte(`{"ok":false,"error":"detect_host_accounts_unavailable"}`), nil
	}

	if run.result.Updated > 0 && detector.options.Reload != nil {
		if reloadErr := detector.options.Reload(ctx); reloadErr == nil {
			run.result.Reloaded = true
		}
	}

	run.populateAccountCounts()
	body, err := json.Marshal(run.result)
	if err != nil {
		return http.StatusInternalServerError, []byte(`{"ok":false,"error":"detect_host_accounts_unavailable"}`), nil
	}
	return http.StatusOK, body, nil
}

type detectSession struct {
	detector    *NativeDetector
	ctx         context.Context
	aiHomeDir   string
	hostHomeDir string
	store       *sqliteaccount.Store
	importer    *accountapp.AccountImporter
	guard       *hostSelfWriteGuard
	result      DetectResponse
}

func (s *detectSession) addRegistered(accountRef, cliAccountID string, created bool, provider, source string) {
	s.result.Updated++
	s.result.Registered = append(s.result.Registered, RegisteredAccount{
		AccountRef:   accountRef,
		CLIAccountID: cliAccountID,
		Created:      created,
		Provider:     provider,
		Source:       source,
	})
}

func (s *detectSession) addSkip(reason, provider, source, accountRef string) {
	s.result.Skipped = append(s.result.Skipped, SkippedAccount{
		Reason:     reason,
		Provider:   provider,
		Source:     source,
		AccountRef: accountRef,
	})
}

func (s *detectSession) listAllOverviews() ([]accountapp.AccountOverview, error) {
	var all []accountapp.AccountOverview
	cursor := accountcore.AccountRef("")
	for page := 0; page < overviewQueryPageLimit; page++ {
		query, err := accountapp.NewOverviewQuery(cursor, accountapp.MaxOverviewLimit)
		if err != nil {
			return nil, err
		}
		batch, err := s.store.ListAccountOverviews(s.ctx, query)
		if err != nil {
			return nil, err
		}
		if len(batch) == 0 {
			break
		}
		all = append(all, batch...)
		if len(batch) < accountapp.MaxOverviewLimit {
			break
		}
		next := batch[len(batch)-1].Account().Ref()
		if next == "" || next == cursor {
			break
		}
		cursor = next
	}
	return all, nil
}

func (s *detectSession) populateAccountCounts() {
	for _, provider := range allDetectorProviders {
		s.result.Accounts[provider] = 0
	}
	overviews, err := s.listAllOverviews()
	if err != nil {
		return
	}
	for _, overview := range overviews {
		provider := overview.Account().ProviderID()
		if _, known := s.result.Accounts[provider]; known {
			s.result.Accounts[provider]++
		}
	}
}

func (s *detectSession) defaultHostAuthMode(canonical string) string {
	definition, found := s.detector.catalog.Get(canonical)
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

func (s *detectSession) saveUIState(
	accountRef accountcore.AccountRef,
	displayName string,
	authMode string,
	apiKeyMode bool,
	baseURL string,
) {
	normalizedBaseURL := strings.TrimSpace(baseURL)
	if normalizedBaseURL != "" {
		if normalized, err := accountcore.NormalizeStaticBaseURL(normalizedBaseURL); err == nil {
			normalizedBaseURL = normalized
		}
	}
	uiState, err := accountcore.NewUIState(accountcore.UIStateInput{
		AccountRef:  accountRef,
		Status:      "up",
		DisplayName: strings.TrimSpace(displayName),
		AuthMode:    authMode,
		APIKeyMode:  apiKeyMode,
		Configured:  true,
		BaseURL:     normalizedBaseURL,
		UpdatedAt:   s.detector.clock().UTC(),
	})
	if err == nil {
		_ = s.store.ReplaceAccountUIState(s.ctx, uiState)
	}
}

// insertOnlyHostAccount 只在账号尚未存在且未被用户删除（墓碑）时入库，不覆盖已有账号。
func (s *detectSession) insertOnlyHostAccount(
	provider string,
	sourceLabel string,
	credential accountapp.Credential,
	profile accountapp.PublicProfile,
	displayName string,
	authMode string,
	apiKeyMode bool,
	secretForTombstone string,
	baseURL string,
) {
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		s.addSkip("invalid_identity", provider, sourceLabel, "")
		return
	}
	tombstoned, err := s.store.IsAccountTombstoned(s.ctx, accountRef.String())
	if err != nil {
		s.addSkip("tombstone_check_failed", provider, sourceLabel, accountRef.String())
		return
	}
	if tombstoned {
		s.addSkip("account_deleted_by_user", provider, sourceLabel, accountRef.String())
		return
	}
	if strings.TrimSpace(secretForTombstone) != "" {
		keyTombstoned, keyErr := s.store.IsAPIKeyTombstoned(s.ctx, provider, secretForTombstone)
		if keyErr != nil {
			s.addSkip("tombstone_check_failed", provider, sourceLabel, accountRef.String())
			return
		}
		if keyTombstoned {
			s.addSkip("account_deleted_by_user", provider, sourceLabel, accountRef.String())
			return
		}
	}

	if _, getErr := s.store.GetAccountOverview(s.ctx, accountRef); getErr == nil {
		s.addSkip("existing_account_unchanged", provider, sourceLabel, accountRef.String())
		return
	}

	imported, err := s.importer.Import(s.ctx, credential, profile)
	if err != nil {
		if errors.Is(err, accountapp.ErrAccountConflict) {
			s.addSkip("existing_account_unchanged", provider, sourceLabel, accountRef.String())
			return
		}
		s.addSkip("host_account_register_failed", provider, sourceLabel, accountRef.String())
		return
	}
	account := imported.Account()
	if !imported.Created() {
		s.addSkip("existing_account_unchanged", provider, sourceLabel, account.Ref().String())
		return
	}
	if displayName == "" {
		displayName = profileDisplayName(profile)
	}
	if authMode == "" {
		authMode = s.defaultHostAuthMode(provider)
	}
	s.saveUIState(account.Ref(), displayName, authMode, apiKeyMode, baseURL)
	s.addRegistered(
		account.Ref().String(),
		strconv.FormatInt(account.CLIAccountID().Int64(), 10),
		true,
		provider,
		sourceLabel,
	)
}

// adoptNewOrNewer 供 codebuddy-family 与 cline 使用：支持新注册与代际更新，同时尊重用户删除墓碑。
func (s *detectSession) adoptNewOrNewer(
	provider string,
	sourceLabel string,
	credential accountapp.Credential,
	profile accountapp.PublicProfile,
	displayName string,
	existingRef accountcore.AccountRef,
) {
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		s.addSkip("identity_unverifiable", provider, sourceLabel, "")
		return
	}
	if existingRef.IsValid() {
		accountRef = existingRef
	}
	tombstoned, err := s.store.IsAccountTombstoned(s.ctx, accountRef.String())
	if err != nil {
		s.addSkip("tombstone_check_failed", provider, sourceLabel, accountRef.String())
		return
	}
	if tombstoned {
		s.addSkip("account_deleted_by_user", provider, sourceLabel, accountRef.String())
		return
	}

	before, beforeErr := s.store.GetAccountOverview(s.ctx, accountRef)
	existed := beforeErr == nil
	if existed {
		// 保留静态 API Key 模式，避免用宿主 OAuth 覆盖手工 API Key 账号。
		if before.AuthKind() == accountcore.StaticAPIKeyAuthKind || before.AuthKind() == "api_key" {
			s.addSkip("account_mode_conflict", provider, sourceLabel, accountRef.String())
			return
		}
		updatedAccount, reauthErr := s.importer.Import(s.ctx, credential, profile)
		if reauthErr != nil {
			if errors.Is(reauthErr, accountapp.ErrReauthenticationGenerationUnordered) ||
				errors.Is(reauthErr, accountapp.ErrReauthenticationUnsupported) {
				s.addSkip("credential_not_newer", provider, sourceLabel, accountRef.String())
				return
			}
			if errors.Is(reauthErr, accountapp.ErrReauthenticationConflict) {
				s.addSkip("concurrent_credential_update", provider, sourceLabel, accountRef.String())
				return
			}
			s.addSkip("host_account_register_failed", provider, sourceLabel, accountRef.String())
			return
		}
		account := updatedAccount.Account()
		if account.UpdatedAt().After(before.Account().UpdatedAt()) {
			s.saveUIState(account.Ref(), displayName, s.defaultHostAuthMode(provider), false, "")
			s.addRegistered(
				account.Ref().String(),
				strconv.FormatInt(account.CLIAccountID().Int64(), 10),
				false,
				provider,
				sourceLabel,
			)
			return
		}
		if displayName != "" && before.DisplayName() == "" {
			s.saveUIState(account.Ref(), displayName, s.defaultHostAuthMode(provider), false, "")
		}
		s.addSkip("credential_not_newer", provider, sourceLabel, account.Ref().String())
		return
	}

	imported, err := s.importer.Import(s.ctx, credential, profile)
	if err != nil {
		if errors.Is(err, accountapp.ErrAccountConflict) {
			s.addSkip("credential_not_newer", provider, sourceLabel, accountRef.String())
			return
		}
		s.addSkip("host_account_register_failed", provider, sourceLabel, accountRef.String())
		return
	}
	account := imported.Account()
	s.saveUIState(account.Ref(), displayName, s.defaultHostAuthMode(provider), false, "")
	s.addRegistered(
		account.Ref().String(),
		strconv.FormatInt(account.CLIAccountID().Int64(), 10),
		imported.Created(),
		provider,
		sourceLabel,
	)
}

func (s *detectSession) detectCline() bool {
	providersFile := filepath.Join(s.hostHomeDir, ".cline", "data", "settings", "providers.json")
	raw, reason, present := readGuardedRegularFile(providersFile, s.guard)
	if !present {
		return true
	}
	s.result.Scanned++
	if reason != "" {
		s.addSkip(reason, "cline", filepath.Base(providersFile), "")
		return true
	}
	sanitized, err := nativeaccount.SanitizeClineProvidersDocument(raw)
	if err != nil {
		s.addSkip("host_credential_file_corrupt", "cline", filepath.Base(providersFile), "")
		return true
	}
	var authObj map[string]any
	if err := json.Unmarshal(sanitized, &authObj); err != nil {
		s.addSkip("host_credential_file_corrupt", "cline", filepath.Base(providersFile), "")
		return true
	}
	if !hasUsableClineOAuth(authObj) {
		if hasAnyClineKey(authObj) {
			s.addSkip("api_key_only_source", "cline", filepath.Base(providersFile), "")
		} else {
			s.addSkip("no_cline_credential", "cline", filepath.Base(providersFile), "")
		}
		return true
	}
	envelope, err := marshalNativeAuthEnvelope(map[string]any{"auth": authObj})
	if err != nil {
		s.addSkip("cline_native_credential_sync_failed", "cline", filepath.Base(providersFile), "")
		return true
	}
	defer clear(envelope)
	cred, profile, err := s.detector.decoder.Decode("cline", envelope)
	if err != nil || cred == nil {
		s.addSkip("identity_unverifiable", "cline", filepath.Base(providersFile), "")
		return true
	}
	displayName := extractClineDisplayName(authObj)
	s.adoptNewOrNewer("cline", filepath.Base(providersFile), cred, profile, displayName, "")
	return true
}

func hasUsableClineOAuth(authRoot map[string]any) bool {
	providersMap, _ := authRoot["providers"].(map[string]any)
	for _, slotID := range []string{"cline-pass", "cline"} {
		slot, _ := providersMap[slotID].(map[string]any)
		settings, _ := slot["settings"].(map[string]any)
		auth, _ := settings["auth"].(map[string]any)
		if auth == nil {
			continue
		}
		token := firstString(auth, "accessToken", "access_token")
		if strings.HasPrefix(token, "workos:") {
			return true
		}
	}
	return false
}

func hasAnyClineKey(authRoot map[string]any) bool {
	providersMap, _ := authRoot["providers"].(map[string]any)
	for _, slotID := range []string{"cline-pass", "cline"} {
		slot, _ := providersMap[slotID].(map[string]any)
		settings, _ := slot["settings"].(map[string]any)
		auth, _ := settings["auth"].(map[string]any)
		if firstString(auth, "apiKey", "api_key", "accessToken", "access_token") != "" {
			return true
		}
		env, _ := slot["env"].(map[string]any)
		if firstString(env, "CLINE_API_KEY") != "" {
			return true
		}
	}
	return false
}

func extractClineDisplayName(authRoot map[string]any) string {
	providersMap, _ := authRoot["providers"].(map[string]any)
	for _, slotID := range []string{"cline-pass", "cline"} {
		slot, _ := providersMap[slotID].(map[string]any)
		settings, _ := slot["settings"].(map[string]any)
		auth, _ := settings["auth"].(map[string]any)
		if auth == nil {
			continue
		}
		if email := firstString(auth, "email", "displayName"); email != "" {
			return email
		}
		token := strings.TrimPrefix(firstString(auth, "accessToken", "access_token"), "workos:")
		if claims := decodeJWTClaims(token); claims != nil {
			if email := firstString(claims, "email", "preferred_username", "name"); email != "" {
				return email
			}
		}
	}
	return ""
}

func (s *detectSession) detectHostAuthProjections() bool {
	for _, provider := range hostAuthProjectionProviders {
		if s.ctx.Err() != nil {
			break
		}
		s.scanSingleHostProjection(provider)
	}
	return true
}

func (s *detectSession) scanSingleHostProjection(provider string) {
	policy := storagepolicy.Get(provider)
	if policy == nil || len(policy.AuthArtifacts) == 0 {
		return
	}
	sourceLabel := provider + "-host-scan"
	if provider == "claude" || provider == "codex" {
		reader := s.newNativeArtifactReader()
		artifacts, err := reader.Read(provider)
		if err != nil {
			return
		}
		defer clear(artifacts.Envelope)
		for _, sourcePath := range artifacts.Sources {
			if reason := s.guard.rejectsPath(sourcePath); reason != "" {
				s.result.Scanned++
				s.addSkip(reason, provider, sourceLabel, "")
				return
			}
			if raw, fileErr := os.ReadFile(sourcePath); fileErr == nil {
				if reason := s.guard.rejectsText(string(raw)); reason != "" {
					s.result.Scanned++
					s.addSkip(reason, provider, sourceLabel, "")
					return
				}
			}
		}
		cred, profile, decodeErr := s.detector.decoder.Decode(provider, artifacts.Envelope)
		if decodeErr != nil || cred == nil {
			// Codex auth.json 仅配置了 OPENAI_API_KEY 而没有 tokens 时留给 host-api-key 处理。
			return
		}
		s.result.Scanned++
		s.insertOnlyHostAccount(provider, sourceLabel, cred, profile, "", "", false, "", "")
		return
	}

	baseDir := s.hostHomeDir
	if len(policy.HostAuthRoot) > 0 {
		baseDir = filepath.Join(append([]string{s.hostHomeDir}, policy.HostAuthRoot...)...)
	}
	nativeAuth := make(map[string]any, len(policy.AuthArtifacts))
	sawPrimary := false
	for _, artifact := range policy.AuthArtifacts {
		targetPath := filepath.Join(append([]string{baseDir}, artifact.Path...)...)
		if reason := s.guard.rejectsPath(targetPath); reason != "" {
			s.result.Scanned++
			s.addSkip(reason, provider, sourceLabel, "")
			return
		}
		raw, reason, present := readGuardedRegularFile(targetPath, s.guard)
		if !present {
			if artifact.Optional {
				continue
			}
			return
		}
		sawPrimary = true
		if reason != "" {
			s.result.Scanned++
			s.addSkip(reason, provider, sourceLabel, "")
			return
		}
		value, parseErr := parseArtifactValue(artifact.Format, raw)
		if parseErr != nil {
			s.result.Scanned++
			s.addSkip("host_credential_file_corrupt", provider, sourceLabel, "")
			return
		}
		if artifact.Field != "" {
			nativeAuth[artifact.Field] = value
		}
	}
	if !sawPrimary || len(nativeAuth) == 0 {
		return
	}
	s.result.Scanned++
	envelope, err := marshalNativeAuthEnvelope(nativeAuth)
	if err != nil {
		s.addSkip("host_auth_scan_failed", provider, sourceLabel, "")
		return
	}
	defer clear(envelope)
	cred, profile, decodeErr := s.detector.decoder.Decode(provider, envelope)
	if decodeErr != nil || cred == nil {
		s.addSkip("host_login_state_invalid", provider, sourceLabel, "")
		return
	}
	s.insertOnlyHostAccount(provider, sourceLabel, cred, profile, "", "", false, "", "")
}

func (s *detectSession) newNativeArtifactReader() *nativeartifact.Reader {
	hostHome := s.hostHomeDir
	options := nativeartifact.Options{
		UserHomeDir: func() (string, error) { return hostHome, nil },
		LookupEnv:   func(string) (string, bool) { return "", false },
	}
	realHome, err := os.UserHomeDir()
	if err != nil || filepath.Clean(hostHome) != filepath.Clean(realHome) {
		options.ReadClaudeSecureStorage = func(string, bool) (nativeartifact.ClaudeSecureStorageRecord, error) {
			return nativeartifact.ClaudeSecureStorageRecord{}, errDetectorHostKeychainDisabled
		}
	}
	return nativeartifact.New(options)
}

func (s *detectSession) detectHostAPIKeys() bool {
	s.scanCodexHostAPIKey()
	s.scanClaudeHostAPIKey()
	s.scanGeminiHostAPIKey()
	return true
}

func (s *detectSession) scanCodexHostAPIKey() {
	filePath := filepath.Join(s.hostHomeDir, ".codex", "auth.json")
	raw, reason, present := readGuardedRegularFile(filePath, s.guard)
	if !present {
		return
	}
	if reason != "" {
		s.result.Scanned++
		s.addSkip(reason, "codex", "host-api-key", "")
		return
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		s.result.Scanned++
		s.addSkip("host_credential_file_corrupt", "codex", "host-api-key", "")
		return
	}
	if tokens, _ := doc["tokens"].(map[string]any); tokens != nil {
		if firstString(tokens, "refresh_token", "access_token") != "" {
			return
		}
	}
	apiKey := firstString(doc, "OPENAI_API_KEY")
	if apiKey == "" {
		return
	}
	s.result.Scanned++
	if guardReason := s.guard.rejectsAPIKey(apiKey, ""); guardReason != "" {
		s.addSkip(guardReason, "codex", "host-api-key", "")
		return
	}
	cred, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: apiKey})
	if err != nil {
		s.addSkip("invalid_api_key", "codex", "host-api-key", "")
		return
	}
	s.insertOnlyHostAccount("codex", "host-api-key", cred, nil, "", string(providers.AuthModeAPIKey), true, apiKey, "")
}

func (s *detectSession) scanClaudeHostAPIKey() {
	filePath := filepath.Join(s.hostHomeDir, ".claude", "settings.json")
	raw, reason, present := readGuardedRegularFile(filePath, s.guard)
	if !present {
		return
	}
	if reason != "" {
		s.result.Scanned++
		s.addSkip(reason, "claude", "host-api-key", "")
		return
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		s.result.Scanned++
		s.addSkip("host_credential_file_corrupt", "claude", "host-api-key", "")
		return
	}
	env, _ := doc["env"].(map[string]any)
	if env == nil {
		return
	}
	authToken := firstString(env, "ANTHROPIC_AUTH_TOKEN")
	apiKey := firstString(env, "ANTHROPIC_API_KEY")
	baseURL := firstString(env, "ANTHROPIC_BASE_URL")
	secret := authToken
	authMode := string(providers.AuthModeAuthToken)
	if secret == "" {
		secret = apiKey
		authMode = string(providers.AuthModeAPIKey)
	}
	if secret == "" {
		return
	}
	s.result.Scanned++
	if guardReason := s.guard.rejectsAPIKey(secret, baseURL); guardReason != "" {
		s.addSkip(guardReason, "claude", "host-api-key", "")
		return
	}
	var (
		cred accountapp.Credential
		err  error
	)
	if authMode == string(providers.AuthModeAuthToken) {
		cred, err = claude.NewAuthTokenAuth(claude.AuthTokenInput{AuthToken: secret, BaseURL: baseURL})
	} else {
		cred, err = claude.NewAPIKeyAuth(claude.APIKeyInput{APIKey: secret, BaseURL: baseURL})
	}
	if err != nil {
		s.addSkip("invalid_api_key", "claude", "host-api-key", "")
		return
	}
	s.insertOnlyHostAccount("claude", "host-api-key", cred, nil, "", authMode, true, secret, baseURL)
}

func (s *detectSession) scanGeminiHostAPIKey() {
	filePath := filepath.Join(s.hostHomeDir, ".gemini", ".env")
	raw, reason, present := readGuardedRegularFile(filePath, s.guard)
	if !present {
		return
	}
	if reason != "" {
		s.result.Scanned++
		s.addSkip(reason, "gemini", "host-api-key", "")
		return
	}
	vars := parseDotEnv(string(raw))
	apiKey := strings.TrimSpace(vars["GEMINI_API_KEY"])
	baseURL := strings.TrimSpace(vars["GEMINI_BASE_URL"])
	if apiKey == "" {
		return
	}
	s.result.Scanned++
	if guardReason := s.guard.rejectsAPIKey(apiKey, baseURL); guardReason != "" {
		s.addSkip(guardReason, "gemini", "host-api-key", "")
		return
	}
	cred, err := accountcore.NewStaticAPIKeyAuth(accountcore.StaticAPIKeyInput{
		ProviderID: "gemini",
		APIKey:     apiKey,
		BaseURL:    baseURL,
	})
	if err != nil {
		s.addSkip("invalid_api_key", "gemini", "host-api-key", "")
		return
	}
	s.insertOnlyHostAccount("gemini", "host-api-key", cred, nil, "", string(providers.AuthModeAPIKey), true, apiKey, baseURL)
}

func (s *detectSession) detectHostEnvAPIKeys() bool {
	values := s.collectHostEnvValues()
	for _, spec := range hostEnvAPIKeySpecs {
		baseURL := ""
		if spec.BaseURLKey != "" {
			baseURL = strings.TrimSpace(values[spec.BaseURLKey])
		}
		seen := map[string]struct{}{}
		for _, keyName := range spec.APIKeys {
			apiKey := strings.TrimSpace(values[keyName])
			if apiKey == "" {
				continue
			}
			if _, dup := seen[apiKey]; dup {
				continue
			}
			seen[apiKey] = struct{}{}
			s.result.Scanned++
			if guardReason := s.guard.rejectsAPIKey(apiKey, baseURL); guardReason != "" {
				s.addSkip(guardReason, spec.Provider, "host-env-api-key", "")
				continue
			}
			cred, err := buildEnvStaticCredential(spec.Provider, apiKey, baseURL)
			if err != nil {
				s.addSkip("invalid_api_key", spec.Provider, "host-env-api-key", "")
				continue
			}
			s.insertOnlyHostAccount(
				spec.Provider,
				"host-env-api-key",
				cred,
				nil,
				"",
				string(providers.AuthModeAPIKey),
				true,
				apiKey,
				baseURL,
			)
		}
	}
	return true
}

func buildEnvStaticCredential(provider, apiKey, baseURL string) (accountapp.Credential, error) {
	switch provider {
	case "codex":
		return codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: apiKey, BaseURL: baseURL})
	case "claude":
		return claude.NewAPIKeyAuth(claude.APIKeyInput{APIKey: apiKey, BaseURL: baseURL})
	default:
		return accountcore.NewStaticAPIKeyAuth(accountcore.StaticAPIKeyInput{
			ProviderID: provider,
			APIKey:     apiKey,
			BaseURL:    baseURL,
		})
	}
}

func (s *detectSession) collectHostEnvValues() map[string]string {
	var names []string
	nameSet := map[string]struct{}{}
	for _, spec := range hostEnvAPIKeySpecs {
		for _, k := range spec.APIKeys {
			if _, ok := nameSet[k]; !ok {
				nameSet[k] = struct{}{}
				names = append(names, k)
			}
		}
		if spec.BaseURLKey != "" {
			if _, ok := nameSet[spec.BaseURLKey]; !ok {
				nameSet[spec.BaseURLKey] = struct{}{}
				names = append(names, spec.BaseURLKey)
			}
		}
	}
	sort.Strings(names)

	out := map[string]string{}
	if s.detector.options.LoginShellEnv != nil {
		if shellVals, err := s.detector.options.LoginShellEnv(s.ctx, names); err == nil {
			for k, v := range shellVals {
				if trimmed := strings.TrimSpace(v); trimmed != "" {
					out[k] = trimmed
				}
			}
		}
	} else if s.detector.options.LookupEnv == nil && s.detector.normalizePlatform() != "win32" {
		for k, v := range readLoginShellEnv(s.ctx, names) {
			if trimmed := strings.TrimSpace(v); trimmed != "" {
				out[k] = trimmed
			}
		}
	}

	lookup := s.detector.lookupEnvFunc()
	for _, name := range names {
		if val, ok := lookup(name); ok {
			if trimmed := strings.TrimSpace(val); trimmed != "" {
				out[name] = trimmed
			}
		}
	}
	return out
}

func readLoginShellEnv(ctx context.Context, names []string) map[string]string {
	result := map[string]string{}
	if len(names) == 0 {
		return result
	}
	shell := strings.TrimSpace(os.Getenv("SHELL"))
	if shell == "" {
		shell = "/bin/sh"
	}
	parts := make([]string, 0, len(names))
	for _, name := range names {
		if !isSafeEnvVarName(name) {
			continue
		}
		parts = append(parts, fmt.Sprintf("printf '%%s=%%s\\0' %s \"${%s}\"", name, name))
	}
	if len(parts) == 0 {
		return result
	}
	runCtx, cancel := context.WithTimeout(ctx, loginShellTimeout)
	defer cancel()
	cmd := exec.CommandContext(runCtx, shell, "-l", "-i", "-c", strings.Join(parts, "; "))
	out, err := cmd.Output()
	if err != nil && len(out) == 0 {
		return result
	}
	for _, entry := range bytes.Split(out, []byte{0}) {
		if len(entry) == 0 {
			continue
		}
		idx := bytes.IndexByte(entry, '=')
		if idx <= 0 {
			continue
		}
		key := string(entry[:idx])
		val := strings.TrimSpace(string(entry[idx+1:]))
		if val != "" {
			result[key] = val
		}
	}
	return result
}

func isSafeEnvVarName(name string) bool {
	if name == "" {
		return false
	}
	for i, r := range name {
		if i == 0 && (r < 'A' || r > 'Z') && r != '_' {
			return false
		}
		if (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '_' {
			return false
		}
	}
	return true
}

type hostSelfWriteGuard struct {
	aiHomeDir   string
	serverPort  int
	gatewayURLs []string
	secrets     []string
}

func (detector *NativeDetector) newSelfWriteGuard(aiHomeDir string) *hostSelfWriteGuard {
	port := detector.options.ServerPort
	var secrets []string
	if port <= 0 {
		port = defaultDetectServerPort
	}
	// 读取 server.json（若存在）中的端口与密钥签名，避免把 aih 写入宿主的代理配置误判为本机独立账号。
	serverJSONPath := filepath.Join(aiHomeDir, "server.json")
	if raw, err := os.ReadFile(serverJSONPath); err == nil {
		var cfg map[string]any
		if json.Unmarshal(raw, &cfg) == nil {
			if p, ok := asInt(cfg["port"]); ok && p > 0 {
				port = p
			}
			for _, key := range []string{"apiKey", "clientKey", "managementKey"} {
				if val := firstString(cfg, key); len(val) >= 8 && val != "dummy" {
					secrets = append(secrets, val)
				}
			}
		}
	}
	if detector.options.ClientKey != nil {
		if val := strings.TrimSpace(detector.options.ClientKey()); len(val) >= 8 && val != "dummy" {
			secrets = append(secrets, val)
		}
	}
	if detector.options.ManagementKey != nil {
		if val := strings.TrimSpace(detector.options.ManagementKey()); len(val) >= 8 && val != "dummy" {
			secrets = append(secrets, val)
		}
	}
	gatewayURLs := []string{
		fmt.Sprintf("http://127.0.0.1:%d", port),
		fmt.Sprintf("http://localhost:%d", port),
		fmt.Sprintf("http://[::1]:%d", port),
	}
	return &hostSelfWriteGuard{
		aiHomeDir:   filepath.Clean(aiHomeDir),
		serverPort:  port,
		gatewayURLs: gatewayURLs,
		secrets:     secrets,
	}
}

func (g *hostSelfWriteGuard) rejectsPath(filePath string) string {
	if g == nil || g.aiHomeDir == "" || filePath == "" {
		return ""
	}
	cleaned := filepath.Clean(filePath)
	rel, err := filepath.Rel(g.aiHomeDir, cleaned)
	if err != nil {
		return ""
	}
	if rel == "." || (!strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != "..") {
		return "aih_private_runtime_file"
	}
	return ""
}

func (g *hostSelfWriteGuard) rejectsText(text string) string {
	if g == nil || text == "" {
		return ""
	}
	lower := strings.ToLower(text)
	if strings.Contains(lower, "x-account-ref") || strings.Contains(lower, "model_providers.aih_server") {
		return "aih_managed_host_config"
	}
	for _, gwURL := range g.gatewayURLs {
		if strings.Contains(text, gwURL) {
			return "aih_gateway_host_config"
		}
	}
	for _, secret := range g.secrets {
		if strings.Contains(text, secret) {
			return "aih_client_key_host_config"
		}
	}
	return ""
}

func (g *hostSelfWriteGuard) rejectsAPIKey(apiKey, baseURL string) string {
	if g == nil {
		return ""
	}
	for _, secret := range g.secrets {
		if apiKey == secret {
			return "aih_client_key_host_config"
		}
	}
	trimmedURL := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if trimmedURL == "" {
		return ""
	}
	for _, gwURL := range g.gatewayURLs {
		if trimmedURL == gwURL || strings.HasPrefix(trimmedURL, gwURL+"/") {
			return "aih_gateway_host_config"
		}
	}
	parsed, err := url.Parse(trimmedURL)
	if err != nil {
		return ""
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "127.0.0.1" || host == "localhost" || host == "::1" {
		portText := parsed.Port()
		if portText == "" && strings.EqualFold(parsed.Scheme, "http") {
			portText = "80"
		}
		if portNum, err := strconv.Atoi(portText); err == nil && portNum == g.serverPort {
			return "aih_gateway_host_config"
		}
	}
	return ""
}

func readGuardedRegularFile(filePath string, guard *hostSelfWriteGuard) ([]byte, string, bool) {
	if guard != nil {
		if reason := guard.rejectsPath(filePath); reason != "" {
			return nil, reason, true
		}
	}
	info, err := os.Lstat(filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, "", false
		}
		return nil, "host_credential_file_unreadable", true
	}
	if !info.Mode().IsRegular() || (info.Mode()&os.ModeSymlink != 0) {
		return nil, "host_credential_file_unsupported", true
	}
	if info.Size() > maxDetectorArtifactBytes {
		return nil, "host_credential_file_too_large", true
	}
	raw, err := os.ReadFile(filePath)
	if err != nil {
		return nil, "host_credential_file_unreadable", true
	}
	if guard != nil {
		if reason := guard.rejectsText(string(raw)); reason != "" {
			return nil, reason, true
		}
	}
	if strings.EqualFold(filepath.Ext(filePath), ".json") && !json.Valid(raw) {
		return nil, "host_credential_file_corrupt", true
	}
	return raw, "", true
}

func parseArtifactValue(format string, raw []byte) (any, error) {
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

func marshalNativeAuthEnvelope(nativeAuth map[string]any) ([]byte, error) {
	rawNative, err := json.Marshal(nativeAuth)
	if err != nil {
		return nil, err
	}
	defer clear(rawNative)
	return json.Marshal(map[string]json.RawMessage{
		"native_auth_json": rawNative,
	})
}

func parseDotEnv(content string) map[string]string {
	out := map[string]string{}
	for _, rawLine := range strings.Split(content, "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(rawLine, "\r"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		idx := strings.IndexByte(line, '=')
		if idx <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		val := strings.TrimSpace(line[idx+1:])
		if len(val) >= 2 && ((val[0] == '"' && val[len(val)-1] == '"') || (val[0] == '\'' && val[len(val)-1] == '\'')) {
			val = val[1 : len(val)-1]
		}
		if key != "" && val != "" {
			out[key] = val
		}
	}
	return out
}

func profileDisplayName(profile accountapp.PublicProfile) string {
	if profile == nil {
		return ""
	}
	if named, ok := profile.(interface{ Email() string }); ok {
		return strings.TrimSpace(named.Email())
	}
	return ""
}

func (detector *NativeDetector) lookupEnvFunc() func(string) (string, bool) {
	if detector.options.LookupEnv != nil {
		return detector.options.LookupEnv
	}
	return os.LookupEnv
}

func (detector *NativeDetector) normalizePlatform() string {
	platform := strings.ToLower(strings.TrimSpace(detector.options.OSPlatform))
	if platform == "" {
		platform = runtime.GOOS
	}
	switch platform {
	case "darwin", "macos":
		return "darwin"
	case "windows", "win32":
		return "win32"
	case "linux":
		return "linux"
	default:
		return platform
	}
}

func firstString(obj map[string]any, keys ...string) string {
	if obj == nil {
		return ""
	}
	for _, key := range keys {
		if val, ok := obj[key].(string); ok {
			if trimmed := strings.TrimSpace(val); trimmed != "" {
				return trimmed
			}
		}
	}
	return ""
}

func asInt(value any) (int, bool) {
	switch v := value.(type) {
	case float64:
		return int(v), true
	case int:
		return v, true
	case int64:
		return int(v), true
	case json.Number:
		n, err := v.Int64()
		return int(n), err == nil
	default:
		return 0, false
	}
}

func decodeJWTClaims(token string) map[string]any {
	trimmed := strings.TrimSpace(token)
	if trimmed == "" || len(trimmed) > maxDetectorArtifactBytes {
		return nil
	}
	parts := strings.Split(trimmed, ".")
	if len(parts) < 2 {
		return nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		if padded, stdErr := base64.URLEncoding.DecodeString(parts[1]); stdErr == nil {
			decoded = padded
		} else {
			return nil
		}
	}
	var claims map[string]any
	if err := json.Unmarshal(decoded, &claims); err != nil {
		return nil
	}
	return claims
}
