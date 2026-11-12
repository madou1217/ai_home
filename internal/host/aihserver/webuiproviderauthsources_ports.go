package aihserver

// 认证来源链的身份指纹端口：把「账号池里已入库的账号」与「本机登录态」两侧的指纹
// 交给 webuiproviderauthsourcesapi，让 /provider-auth-sources 能判 alreadyImported。
//
// 为什么放在宿主层：指纹要读凭据内容并按 Provider 策略派生，只有适配器知道这些规则；
// 传输层的只读契约包不引适配器，也就不读凭据。
//
// 口径与 Node 的 collectProviderAuthIdentities / hostAuthIdentity 对齐：
//   - 账号池侧：每个已入库账号的凭据种子（node 侧 capability.accountIdentity 同一形态）；
//   - 本机侧：官方 artifact 交给 nativeaccount 解码器派生，claude/codex 与 Go 自己的
//     导入链路同一条策略，因此「同一身份再次导入」两侧必然相等。

import (
	"context"
	"errors"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeartifact"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

const (
	// providerAuthIdentityPageSize 是遍历账号池的分页大小（与账号页读模型的上限一致）。
	providerAuthIdentityPageSize = accountapp.MaxOverviewLimit
	// providerAuthIdentityPageLimit 给遍历设上限：认证来源链是一次只读请求，不能因为
	// 账号异常多而无限翻页。超出上限只是少算几个指纹（fail-open，不会误标已入库）。
	providerAuthIdentityPageLimit = 16
	// hostLocalSourceSuffix 是本机来源 id 的后缀（与 sources.go 的 hostLocalSources 一致）。
	hostLocalSourceSuffix = "-host-local"
)

// errHostKeychainDisabled 表示宿主侧不做 Keychain 读取。
//
// 去重指纹只看文件：读 Keychain 会弹系统授权框，而且 Node 的 hostAuthIdentity 同样只读
// 凭据文件，两端口径必须一致。
var errHostKeychainDisabled = errors.New("host keychain disabled for auth source identity")

// providerAuthIdentities 返回「账号池里该 Provider 已入库账号种子」端口的实现。
//
// store 为 nil（账号存储未装配）时返回 nil，调用方据此把 alreadyImported 列为未填字段，
// 而不是假装「账号池是空的」。
func providerAuthIdentities(store *sqliteaccount.Store) func(context.Context, string) (map[string]struct{}, error) {
	if store == nil {
		return nil
	}
	return func(ctx context.Context, provider string) (map[string]struct{}, error) {
		identities := make(map[string]struct{})
		normalized := strings.ToLower(strings.TrimSpace(provider))
		if normalized == "" {
			return identities, nil
		}
		cursor := accountcore.AccountRef("")
		for page := 0; page < providerAuthIdentityPageLimit; page++ {
			query, err := accountapp.NewOverviewQuery(cursor, providerAuthIdentityPageSize)
			if err != nil {
				return nil, err
			}
			overviews, err := store.ListAccountOverviews(ctx, query)
			if err != nil {
				return nil, err
			}
			if len(overviews) == 0 {
				break
			}
			for _, overview := range overviews {
				account := overview.Account()
				if account.ProviderID() != normalized {
					continue
				}
				credential, err := store.GetCredential(ctx, account.Ref())
				if err != nil || credential == nil {
					// 单条凭据读不出来不影响其它账号的去重判断（Node 同样逐条吞错）。
					continue
				}
				if seed := strings.TrimSpace(credential.IdentitySeed()); seed != "" {
					identities[seed] = struct{}{}
				}
			}
			if len(overviews) < providerAuthIdentityPageSize {
				break
			}
			cursor = overviews[len(overviews)-1].Account().Ref()
		}
		return identities, nil
	}
}

// providerLocalAuthIdentity 返回「本机来源当前登录态种子」端口的实现。
//
// 只覆盖 Go 有官方 artifact 策略的 Provider（claude / codex）；其它 Provider 返回 false，
// 由调用方退化成「不做去重判断」。宿主 HOME 未知时返回 nil（端口未接线）。
//
// 与 Node 的 hostAuthIdentity 有一处刻意的差别：Go 走官方导入链路，claude 需要
// ~/.claude.json 里的 oauthAccount（账号 UUID 的权威来源）。这份文件缺失时 Go 不判指纹——
// 方向是 fail-open（界面仍显示导入入口），不会把可用的登录态误标成已入库。
func providerLocalAuthIdentity(hostHomeDir string) func(context.Context, string, string) (string, bool) {
	home := strings.TrimSpace(hostHomeDir)
	if home == "" {
		return nil
	}
	return func(ctx context.Context, provider, sourceID string) (string, bool) {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return "", false
		}
		normalized := strings.ToLower(strings.TrimSpace(provider))
		// 只有「读宿主登录态」这一类来源有指纹；host-scan（cline / CodeBuddy 家族）在
		// Node 侧同样没有 identity 函数。
		if !strings.HasSuffix(strings.TrimSpace(sourceID), hostLocalSourceSuffix) ||
			strings.TrimSuffix(strings.TrimSpace(sourceID), hostLocalSourceSuffix) != normalized {
			return "", false
		}
		reader := newHostAuthArtifactReader(home)
		if !reader.Supports(normalized) {
			return "", false
		}
		artifacts, err := reader.Read(normalized)
		if err != nil {
			return "", false
		}
		defer clear(artifacts.Envelope)
		credential, _, err := nativeaccount.NewDecoder().Decode(normalized, artifacts.Envelope)
		if err != nil || credential == nil {
			return "", false
		}
		seed := strings.TrimSpace(credential.IdentitySeed())
		if seed == "" {
			return "", false
		}
		return seed, true
	}
}

// newHostAuthArtifactReader 构造只读宿主官方 artifact 的读取器。
//
// UserHomeDir 固定为宿主 HOME（服务进程自己的 HOME 可能是账号投影）；
// LookupEnv 一律拒绝，避免 CLAUDE_CONFIG_DIR / CODEX_HOME 把结论带到别的目录上。
func newHostAuthArtifactReader(hostHomeDir string) *nativeartifact.Reader {
	return nativeartifact.New(nativeartifact.Options{
		UserHomeDir: func() (string, error) { return hostHomeDir, nil },
		LookupEnv:   func(string) (string, bool) { return "", false },
		ReadClaudeSecureStorage: func(string, bool) (nativeartifact.ClaudeSecureStorageRecord, error) {
			return nativeartifact.ClaudeSecureStorageRecord{}, errHostKeychainDisabled
		},
	})
}
