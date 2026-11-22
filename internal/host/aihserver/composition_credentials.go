package aihserver

import (
	"context"
	"fmt"
	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/upstreamretry"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/agyoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/claudeoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/clineoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/codexoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/geminioauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/grokoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/kimioauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/kirooauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/staticcredential"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/tokenrefresh"
	"github.com/madou1217/ai_home/internal/adapters/accounts/kirocred"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	agyprojection "github.com/madou1217/ai_home/internal/adapters/agy/projection"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
	runtimeupstreamretry "github.com/madou1217/ai_home/internal/runtime/upstreamretry"
	"github.com/madou1217/ai_home/internal/transport/http/codebuddyfamilyrelay"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// credentialRefreshRuntime 是组合根中凭据刷新/登录策略的产物。
//
// 从 newHandlers 拆出：Provider 刷新策略、kiro 刷新器与 agy 投影回写是独立演进面，
// 集中在一个文件后新增 Provider 不再修改主装配流水线。
type credentialRefreshRuntime struct {
	oauthClient           *http.Client
	codexProvider         *codexoauth.Provider
	claudeProvider        *claudeoauth.Provider
	upstream429Store      *runtimeupstreamretry.Store
	upstream429Controller *upstreamretry.Controller
	credentials           *accountcredentials.Resolver
	ownsCredentialRefresh func(accountcore.AccountRef) bool
}

func newCredentialRefreshRuntime(
	ctx context.Context,
	aiHomeDir string,
	store *sqliteaccount.Store,
	errorLog *log.Logger,
	egressClients *accountEgressClients,
	delegateCredentialRefresh bool,
) (*credentialRefreshRuntime, error) {
	// kiro 的 OAuth 凭据在发现前刷新；刷新走纯 HTTP 并 CAS 回写。
	kiroRefresher, err := kirocred.New(
		store,
		&http.Client{
			Timeout:       modelCatalogHTTPTimeout,
			CheckRedirect: rejectOAuthRedirect,
			// 刷新与普通上游调用共用账号出口；Context 无决策时保持默认网络。
			Transport: &egressContextTransport{
				base:    http.DefaultTransport,
				clients: egressClients,
			},
		},
		time.Now,
	)
	if err != nil {
		return nil, fmt.Errorf("创建 kiro 凭据刷新器失败: %w", err)
	}
	// kiro 的 access token 会过期：推理已由 Go 承接，凭据解析必须能刷新，
	// 否则 relay 拿着过期 token 打上游（真机 403 AccessDeniedException）。
	kiroProvider, err := kirooauth.New(kiroRefresher)
	if err != nil {
		return nil, fmt.Errorf("创建 kiro 凭据刷新策略失败: %w", err)
	}
	oauthClient := &http.Client{
		Timeout:       oauthHTTPTimeout,
		CheckRedirect: rejectOAuthRedirect,
		// 各 Provider 的 OAuth 刷新共用这个客户端；按请求 Context 里的
		// 账号出口决策选择代理，未绑定时沿用默认网络。
		Transport: &egressContextTransport{
			base:    http.DefaultTransport,
			clients: egressClients,
		},
	}
	// kimi access_token 只有 15 分钟，刷新走 auth.kimi.com 的 form 合同（与 CLI 一致）。
	kimiProvider, err := kimioauth.New(oauthClient, kimioauth.Options{ClientVersion: kimiClientVersion()})
	if err != nil {
		return nil, fmt.Errorf("创建 kimi OAuth Refresh Strategy 失败: %w", err)
	}
	codexProvider, err := codexoauth.New(oauthClient, time.Now)
	if err != nil {
		return nil, fmt.Errorf("创建 Codex OAuth Strategy 失败: %w", err)
	}
	claudeProvider, err := claudeoauth.New(oauthClient, time.Now)
	if err != nil {
		return nil, fmt.Errorf("创建 Claude OAuth Strategy 失败: %w", err)
	}
	upstream429Store, upstream429Controller := newUpstream429RetryRuntime(ctx, aiHomeDir, errorLog)
	// agy 刷新可能带账号级出口绑定（Node 的 account:egress:<ref>）。Go 接管
	// 刷新后必须沿用同一绑定：url/system/tun/pool/direct 先由 egress 解析成
	// 具体出站目标（fail-closed），再交给刷新策略；未绑定时保持进程默认。
	// 绑定只存在于 Node 台账账号；无台账投影账号通常没有绑定，行为与默认一致。
	agyEgress := runtimeegress.NewAccountResolver(aiHomeDir)
	agyEgressResolver := func(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (agyoauth.Egress, error) {
		decision, err := agyEgress.Resolve(ctx, accountRef)
		if err != nil {
			return agyoauth.Egress{}, err
		}
		if !decision.Bound {
			return agyoauth.Egress{Mode: "default"}, nil
		}
		if decision.Target.Direct || strings.TrimSpace(decision.Target.ProxyURL) == "" {
			return agyoauth.Egress{Mode: "direct"}, nil
		}
		return agyoauth.Egress{
			Mode:     "proxy",
			ProxyURL: decision.Target.ProxyURL,
		}, nil
	}
	agyEgressClientFactory := func(proxyURL string) agyoauth.HTTPClient {
		return newOAuthEgressClient(proxyURL, oauthHTTPTimeout)
	}
	agyProvider, err := agyoauth.NewWithEgress(
		oauthClient,
		agyEgressClientFactory,
		agyEgressResolver,
	)
	if err != nil {
		return nil, fmt.Errorf("创建 AGY OAuth Refresh Strategy 失败: %w", err)
	}
	// gemini / grok / cline 的刷新已迁 Go：三家只做协议交换，到期判断与 CAS 写回
	// 由 accountcredentials.Resolver 统一负责。
	geminiProvider, err := geminioauth.New(oauthClient, geminioauth.Options{})
	if err != nil {
		return nil, fmt.Errorf("创建 Gemini OAuth Refresh Strategy 失败: %w", err)
	}
	grokProvider, err := grokoauth.New(oauthClient, grokoauth.Options{})
	if err != nil {
		return nil, fmt.Errorf("创建 Grok OAuth Refresh Strategy 失败: %w", err)
	}
	clineProvider, err := clineoauth.New(oauthClient, clineoauth.Options{})
	if err != nil {
		return nil, fmt.Errorf("创建 Cline OAuth Refresh Strategy 失败: %w", err)
	}
	geminiStrategy, err := tokenrefresh.NewStrategy(geminiProvider)
	if err != nil {
		return nil, fmt.Errorf("创建 Gemini 刷新策略失败: %w", err)
	}
	grokStrategy, err := tokenrefresh.NewStrategy(grokProvider)
	if err != nil {
		return nil, fmt.Errorf("创建 Grok 刷新策略失败: %w", err)
	}
	clineStrategy, err := tokenrefresh.NewStrategy(clineProvider)
	if err != nil {
		return nil, fmt.Errorf("创建 Cline 刷新策略失败: %w", err)
	}
	// 家族四支与 Qoder 双区没有 Go 侧刷新实现（凭据由厂商 CLI 续期并同步进凭据库），
	// 但凭据解析器要求每个 Provider 都有一条策略才能读取凭据，所以显式
	// 登记静态策略（声明「永不刷新」，见 staticcredential 包注释）。Canonical 的组合
	// 同样登记，避免这些账号在两条解析链上出现「一条能读、一条读不到」的分叉。
	//
	// Qoder 额度 refresh 走的就是这条链路：凭据是 CLI 的 opaque blob，token 由
	// qodercred 用厂商 wasm 解密，不需要（也没有）Go 侧 OAuth 刷新。
	// 这里列的是「Go 已有采集/转发能力、但凭据由厂商 CLI 续期」的 Provider：
	// 缺一条策略，凭据解析就直接失败，额度协调器与显式 refresh 都会 500。
	// kiro / zcode / cline 的旧探针已下线（descriptor quota.supported=false），
	// 没有静态策略时它们的 Go 采集根本跑不起来，只能靠旧连接推送数据。
	staticCredentialProviders := append(
		append([]string{}, codebuddyfamilyrelay.FamilyProviders...),
		"qoder",
		"qodercn",
		"zcode",
	)
	staticCredentialStrategies := make(
		[]accountcredentials.RefreshStrategy,
		0,
		len(staticCredentialProviders),
	)
	for _, providerID := range staticCredentialProviders {
		strategy, err := staticcredential.New(providerID)
		if err != nil {
			return nil, fmt.Errorf(
				"创建静态凭据策略失败(%s): %w",
				providerID,
				err,
			)
		}
		staticCredentialStrategies = append(staticCredentialStrategies, strategy)
	}
	// 两处解析器（WebUI/账号域与推理）共用同一份刷新策略集合：
	// 新增 Provider 只改这一处调用，不再维护两份字面量列表。
	credentialRefreshStrategies := func(oauth ...accountcredentials.RefreshStrategy) []accountcredentials.RefreshStrategy {
		return append(oauth, staticCredentialStrategies...)
	}
	// 凭据刷新所有权以 Node 的 account_refs 台账为准：台账里的账号由宿主刷新，
	// 委托模式下 Go 不重复刷新；无台账投影的账号（台账里没有，例如 Go 完成 agy 登录）
	// 没有宿主凭据，必须由 Go 接管，否则 Token 过期后两侧都无人刷新。
	appStateDatabasePath, appStatePathErr := appstate.DatabasePath(aiHomeDir)
	ownsCredentialRefresh := func(accountRef accountcore.AccountRef) bool {
		// agy 是 Go 权威账号：Node 台账即使有行（UI 投影）也不代表它真的会刷新。
		// 实测 Node 侧不刷新 agy，委托模式下两侧都不动，Token 过期后整类 gemini
		// 请求 401。这里按 Provider 强制 Go 接管，和 Node 无关。
		//
		// kiro 同理且更隐蔽：Node 只在它自己的 kiro transport 里「发请求前顺手刷新」，
		// 而 kiro 推理已由 Go 承接，Node 那条路径永远不会被走到。账号在台账里存在
		// （Node 导入的），于是 Go 判定「宿主负责」也不刷新 —— 2026-11-13 AWS 服务器
		// 上 5 个 kiro 账号的 token 停在过期状态，聊天与模型刷新一起 403。
		if overview, overviewErr := store.GetAccountOverview(
			context.Background(), accountRef,
		); overviewErr == nil {
			switch overview.Account().ProviderID() {
			case "agy", "kiro", "gemini":
				return true
			}
		}
		if appStatePathErr != nil {
			return false
		}
		_, found, lookupErr := appstate.LookupNodeAccountProvider(
			context.Background(),
			appStateDatabasePath,
			accountRef.String(),
		)
		if lookupErr != nil {
			// 台账不可读时保守沿用宿主独占语义，避免两个刷新者竞争轮换 Token。
			return false
		}
		return !found
	}
	credentials, err := accountcredentials.NewResolver(
		accountcredentials.Dependencies{
			Store: store,
			Strategies: credentialRefreshStrategies(
				codexProvider,
				claudeProvider,
				agyProvider,
				kimiProvider,
				kiroProvider,
				geminiStrategy,
				grokStrategy,
				clineStrategy,
			),
			Clock:            time.Now,
			Egress:           managerAccountEgress{clients: egressClients},
			RefreshDelegated: delegateCredentialRefresh,
			OwnsRefresh:      ownsCredentialRefresh,
			// agy 的 CLI 读运行投影而不是账本：Node 在刷新成功后会把新 token
			// 物化到 run/auth-projections，迁移后由 Go 刷新也必须做同一件事，
			// 否则已启动的会话和配置文件页一直看到旧 token。
			OnCredentialRefreshed: func(
				accountRef accountcore.AccountRef,
				credential accountapp.Credential,
			) {
				auth, ok := credential.(*agy.OAuthAuth)
				if !ok || auth == nil {
					return
				}
				if err := agyprojection.Write(aiHomeDir, accountRef.String(), auth); err != nil {
					log.Printf(
						"agy 凭据投影同步失败: account=%s err=%v",
						accountRef,
						err,
					)
				}
				// 默认账号还要同步真实 HOME 的全局 CLI 凭据，否则 aih 之外的
				// agy CLI/桌面端会一直拿旧 token（与 Node host-sync 同口径）。
				if hostHome, homeErr := os.UserHomeDir(); homeErr == nil {
					syncCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
					if err := syncDefaultAgyAuthToHost(
						syncCtx,
						store,
						hostHome,
						accountRef,
						auth,
					); err != nil {
						log.Printf(
							"默认 agy 账号全局凭据同步失败: account=%s err=%v",
							accountRef,
							err,
						)
					}
					cancel()
				}
			},
		},
	)
	if err != nil {
		return nil, fmt.Errorf("创建账号凭据解析器失败: %w", err)
	}
	return &credentialRefreshRuntime{
		oauthClient:           oauthClient,
		codexProvider:         codexProvider,
		claudeProvider:        claudeProvider,
		upstream429Store:      upstream429Store,
		upstream429Controller: upstream429Controller,
		credentials:           credentials,
		ownsCredentialRefresh: ownsCredentialRefresh,
	}, nil
}
