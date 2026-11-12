// Package deletionhost 承接账号删除时的宿主投影：直连授权回收与默认账号落点。
//
// 这两件事原本写在 Node 的删除路由里（revokeHostGrantHook / landOnAihServerDefault）。
// 迁到 Go 后语义逐条对齐：
//
//   - 「是不是默认账号」读的是 Node 的 app_kv account:default:<provider>，
//     而不是 Go 自己的 account_defaults：删除路由的判定口径必须与 Node 一致，
//     否则同一个账号在两侧会被判成不同的默认状态；
//   - 落点复用 internal/host/aihdefault（「无默认 ⇒ AIH Server」的唯一实现处）：
//     先让宿主同步成功，再记档位，绝不留下「档位说 AIH Server、宿主指向别处」；
//   - 直连授权回收只处理 codex：Node 的 ACCOUNT_LIFECYCLE 只有 codex 声明了
//     revokeHostGrant，其它 Provider 返回 nil（不是「回收失败」）。
//
// 宿主配置文件本身的同步仍未迁到 Go（lib/account/host-sync.js），因此这里把它
// 表达成 GatewaySync 端口：端口缺省时按 Node 同款原因码如实上报
// host_sync_unavailable，绝不在没写宿主文件的情况下先改档位。
package deletionhost

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/host/aihdefault"
)

const (
	// codexProviderID 是唯一声明了「回收宿主直连授权」的 Provider。
	codexProviderID = "codex"
	// defaultAccountKeyPrefix 与 Node 的 buildDefaultAccountKey 保持同一键名。
	defaultAccountKeyPrefix = "account:default:"
	// codexProviderKey 与 Node 的 AIH_CODEX_PROVIDER_KEY、Go 的
	// content/codex.DefaultProviderID 是同一个受管 provider id（三处必须一致）。
	codexProviderKey = "aih_server"
	// nativeBaseURLMarker 与 Node 的 NATIVE_API_BASE_URL_MARKER 逐字一致：
	// 只有紧邻这一行的根级 openai_base_url 才算 aih 写下的直连授权。
	nativeBaseURLMarker = "# AI Home managed API endpoint for native openai sessions"
)

const (
	// ReasonNoHostGrant 表示宿主上没有本账号的授权（正常网关档账号）。
	ReasonNoHostGrant = "no_host_grant"
	// ReasonHostSyncUnavailable 与 Node 的 host_sync_unavailable 同义。
	ReasonHostSyncUnavailable = "host_sync_unavailable"
	// ReasonHostSyncFailed 与 Node 的 host_sync_failed 同义。
	ReasonHostSyncFailed = "host_sync_failed"
	// ReasonHostScopeUnavailable 表示没有宿主 HOME，无法判断宿主授权。
	ReasonHostScopeUnavailable = "host_scope_unavailable"
	// ReasonDefaultProfileUpdateFailed 与 Node 的同名原因一致。
	ReasonDefaultProfileUpdateFailed = "default_profile_update_failed"
	// ReasonGrantRevokeUnavailable 表示该 Provider 在 Go 侧还没有回收端口。
	ReasonGrantRevokeUnavailable = "host_grant_revoke_unavailable"
)

var (
	pinHeaderPattern    = regexp.MustCompile(`"X-Account-Ref"\s*=\s*"(acct_[A-Za-z0-9]+)"`)
	baseURLValuePattern = regexp.MustCompile(`^\s*openai_base_url\s*=\s*"((?:[^"\\]|\\.)*)"`)
)

// GatewaySync 把宿主全局配置切到无钉选网关档
// （Node: syncGlobalConfigToHost(provider, ”, { gateway: true })）。
type GatewaySync func(ctx context.Context, providerID string) error

// Options 汇总宿主投影的唯一外部依赖。
type Options struct {
	// AIHomeDir 是 app-state.db 所在的数据根。
	AIHomeDir string
	// HostHomeDir 是宿主 HOME，用于读取 ~/.codex/config.toml。
	HostHomeDir string
	// Catalog 决定哪些 Provider 存在「AIH Server 默认」这一档。
	Catalog *providers.Catalog
	// Credentials 读取 codex 静态凭据里的 OPENAI_BASE_URL；
	// nil 时该判据失效，钉选与默认账号记录仍能定位授权。
	Credentials accountapp.CredentialVersionStore
	// GatewaySync 缺省表示宿主文件投影还没迁到 Go。
	GatewaySync GatewaySync
}

// Service 是 application/accounts.DeletionHostGrant 与
// DeletionServerDefault 的宿主投影实现。
type Service struct {
	aiHomeDir    string
	databasePath string
	hostHomeDir  string
	catalog      *providers.Catalog
	credentials  accountapp.CredentialVersionStore
	gatewaySync  GatewaySync
}

// New 创建宿主投影服务；AIH 数据根必须能定位 app-state.db。
func New(options Options) (*Service, error) {
	aiHomeDir := strings.TrimSpace(options.AIHomeDir)
	if aiHomeDir == "" || options.Catalog == nil {
		return nil, errors.New("账号删除宿主投影缺少 AIH 数据根或 Provider 目录")
	}
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil, err
	}
	return &Service{
		aiHomeDir:    aiHomeDir,
		databasePath: databasePath,
		hostHomeDir:  strings.TrimSpace(options.HostHomeDir),
		catalog:      options.Catalog,
		credentials:  options.Credentials,
		gatewaySync:  options.GatewaySync,
	}, nil
}

// IsDefaultAccount 判断目标账号是不是该 Provider 当前的默认账号。
//
// 读的是 Node 的 app_kv 指针，而不是 Go 的 account_defaults：删除路由原本按这份
// 数据决定「删掉的是不是默认」，换一份来源会让同一个账号在两侧得到不同结论。
func (service *Service) IsDefaultAccount(
	ctx context.Context,
	providerID string,
	accountRef accountcore.AccountRef,
) (bool, error) {
	if service == nil || ctx == nil || !accountRef.IsValid() {
		return false, accountapp.ErrInvalidDeletionRequest
	}
	key := defaultAccountKey(providerID)
	if key == "" {
		return false, nil
	}
	raw, found, err := appstate.ReadKV(ctx, service.databasePath, key)
	if err != nil {
		return false, err
	}
	if !found {
		return false, nil
	}
	return strings.TrimSpace(unquote(raw)) == accountRef.String(), nil
}

// LandServerDefault 把 Provider 落到「无钉选网关档」。
//
// 复用 aihdefault.LandOnServerDefault：宿主同步成功后才记档位。端口缺省时返回
// 与 Node 同款的 host_sync_unavailable，档位保持原样——错配比不做更难排查。
func (service *Service) LandServerDefault(
	ctx context.Context,
	providerID string,
) (accountapp.ServerDefaultLanding, error) {
	if service == nil || ctx == nil {
		return accountapp.ServerDefaultLanding{}, accountapp.ErrInvalidDeletionRequest
	}
	result := aihdefault.LandOnServerDefault(
		ctx,
		service.defaultStore(),
		providerID,
		service.gatewaySyncPort(),
	)
	return accountapp.ServerDefaultLanding{
		OK:            result.OK,
		Landed:        result.Landed,
		AlreadyLanded: result.AlreadyLanded,
		Provider:      result.Provider,
		Profile:       result.Profile,
		Reason:        result.Reason,
	}, nil
}

// RevokeHostGrant 回收账号在宿主 Codex 上的直连授权。
//
// 三条判据都指向同一个账号：aih 默认账号记录、受管钉选、根级受管直连端点。
// 没有命中就是「本来就没有授权」（正常的网关档账号），什么都不改写。
func (service *Service) RevokeHostGrant(
	ctx context.Context,
	account accountcore.Account,
) (accountapp.GrantRevocation, error) {
	if service == nil || ctx == nil || !account.IsValid() {
		return accountapp.GrantRevocation{}, accountapp.ErrInvalidDeletionRequest
	}
	provider := strings.ToLower(strings.TrimSpace(account.ProviderID()))
	if provider != codexProviderID {
		// Node 的 ACCOUNT_LIFECYCLE 只有 codex 声明了 revokeHostGrant；
		// 其它 Provider 没有这个概念，调用方拿到零值（Node 返回 null）。
		return accountapp.GrantRevocation{
			OK:     true,
			Reason: ReasonGrantRevokeUnavailable,
		}, nil
	}
	detection := service.detectCodexGrant(ctx, account.Ref())
	if !detection.granted {
		return accountapp.GrantRevocation{
			OK:      true,
			Revoked: false,
			Reason:  ReasonNoHostGrant,
		}, nil
	}
	if service.gatewaySync == nil {
		// 不能先改档位再等宿主：档位与宿主配置必须成对，否则下一次启动
		// 会读到「档位说 AIH Server、宿主指向账号直连」的错配。
		return accountapp.GrantRevocation{
			OK:      false,
			Revoked: false,
			Reason:  ReasonHostSyncUnavailable,
		}, nil
	}
	if err := service.gatewaySync(ctx, codexProviderID); err != nil {
		return accountapp.GrantRevocation{
			OK:      false,
			Revoked: false,
			Reason:  ReasonHostSyncFailed,
			Message: err.Error(),
		}, nil
	}
	// 宿主已回收（真正的泄漏面），默认账号记录写失败只降级报告。
	service.clearDefaultAccount(ctx, account.Ref())
	if err := service.defaultStore().WriteProviderProfile(
		ctx,
		codexProviderID,
		aihdefault.ServerProfileID,
	); err != nil {
		return accountapp.GrantRevocation{
			OK:                    true,
			Revoked:               true,
			DefaultProfileUpdated: false,
			Reason:                ReasonDefaultProfileUpdateFailed,
			Message:               err.Error(),
		}, nil
	}
	return accountapp.GrantRevocation{
		OK:                    true,
		Revoked:               true,
		DefaultProfileUpdated: true,
	}, nil
}

// codexGrantDetection 是一次宿主授权判定的事实。
type codexGrantDetection struct {
	granted    bool
	reasons    []string
	configPath string
	scope      string
	baseURL    string
}

// detectCodexGrant 复刻 Node 的 detectCodexHostGrant。
//
// base url 判据读的是 codex 静态凭据里的 OPENAI_BASE_URL；OAuth 账号没有这一项，
// 与 Node 的 credential record env 缺失时同义。
func (service *Service) detectCodexGrant(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) codexGrantDetection {
	detection := codexGrantDetection{scope: ReasonHostScopeUnavailable}
	if service.hostHomeDir == "" {
		return detection
	}
	configPath := filepath.Join(service.hostHomeDir, ".codex", "config.toml")
	detection.configPath = configPath
	document, err := os.ReadFile(configPath)
	if err != nil {
		// 未安装 codex / 宿主目录不存在时不创建任何东西。
		detection.scope = "host_config_absent"
		return detection
	}
	content := string(document)
	detection.scope = "host_config"
	if isDefault, _ := service.IsDefaultAccount(ctx, codexProviderID, accountRef); isDefault {
		detection.reasons = append(detection.reasons, "default_account")
	}
	if readPinnedAccountRef(content) == accountRef.String() {
		detection.reasons = append(detection.reasons, "pinned_account_ref")
	}
	directBaseURL := readDirectBaseURL(content)
	detection.baseURL = directBaseURL
	accountBaseURL := service.codexBaseURL(ctx, accountRef)
	if directBaseURL != "" && accountBaseURL != "" &&
		normalizeEndpoint(directBaseURL) == normalizeEndpoint(accountBaseURL) {
		detection.reasons = append(detection.reasons, "native_base_url")
	}
	detection.granted = len(detection.reasons) > 0
	return detection
}

// codexBaseURL 读取账号凭据里的上游地址；读不到按空串处理（判据失效）。
func (service *Service) codexBaseURL(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) string {
	if service.credentials == nil {
		return ""
	}
	snapshot, err := service.credentials.GetCredentialSnapshot(ctx, accountRef)
	if err != nil {
		return ""
	}
	value, ok := snapshot.Credential().(interface{ BaseURL() string })
	if !ok {
		return ""
	}
	return strings.TrimSpace(value.BaseURL())
}

// clearDefaultAccount 只在指针确实指向本账号时删除，避免误清别的默认账号。
func (service *Service) clearDefaultAccount(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) {
	key := defaultAccountKey(codexProviderID)
	if key == "" {
		return
	}
	// 读失败就不动指针：清错的代价比留下一条陈旧指针大得多。
	if isDefault, err := service.IsDefaultAccount(
		ctx,
		codexProviderID,
		accountRef,
	); err != nil || !isDefault {
		return
	}
	_ = appstate.DeleteKV(ctx, service.databasePath, key)
}

func (service *Service) defaultStore() aihdefault.Store {
	return aihdefault.Store{
		DatabasePath: service.databasePath,
		Catalog:      service.catalog,
	}
}

// gatewaySyncPort 把可空端口翻成 aihdefault.GatewaySync。
func (service *Service) gatewaySyncPort() aihdefault.GatewaySync {
	if service.gatewaySync == nil {
		return nil
	}
	return aihdefault.GatewaySync(service.gatewaySync)
}

// readPinnedAccountRef 读受管 provider 段里的账号钉选。
func readPinnedAccountRef(content string) string {
	lines := strings.Split(content, "\n")
	header := "[model_providers." + codexProviderKey + "]"
	start := -1
	for index, line := range lines {
		if strings.TrimSpace(line) == header {
			start = index
			break
		}
	}
	if start < 0 {
		return ""
	}
	for _, line := range lines[start+1:] {
		if strings.HasPrefix(strings.TrimSpace(line), "[") {
			break
		}
		if match := pinHeaderPattern.FindStringSubmatch(line); match != nil {
			return match[1]
		}
	}
	return ""
}

// readDirectBaseURL 读根级受管直连端点（紧邻 aih 派发标记的那一行）。
func readDirectBaseURL(content string) string {
	lines := strings.Split(content, "\n")
	for index, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") {
			return ""
		}
		if trimmed != nativeBaseURLMarker {
			continue
		}
		if index+1 >= len(lines) {
			return ""
		}
		match := baseURLValuePattern.FindStringSubmatch(lines[index+1])
		if match == nil {
			return ""
		}
		return unescapeTOMLString(match[1])
	}
	return ""
}

func normalizeEndpoint(value string) string {
	return strings.ToLower(strings.TrimRight(strings.TrimSpace(value), "/"))
}

func unescapeTOMLString(value string) string {
	replacer := strings.NewReplacer(`\"`, `"`, `\\`, `\`)
	return replacer.Replace(value)
}

// unquote 把 app_kv 里的 JSON 字符串还原成裸字符串。
func unquote(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if len(trimmed) >= 2 && trimmed[0] == '"' && trimmed[len(trimmed)-1] == '"' {
		return trimmed[1 : len(trimmed)-1]
	}
	return trimmed
}

func defaultAccountKey(providerID string) string {
	provider := strings.ToLower(strings.TrimSpace(providerID))
	if provider == "" {
		return ""
	}
	return defaultAccountKeyPrefix + provider
}

var (
	_ accountapp.DeletionHostGrant     = (*Service)(nil)
	_ accountapp.DeletionServerDefault = (*Service)(nil)
)
