package accountauth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
)

// TestServiceCompletesThroughCanonicalRegistrationChain 验证 Job 只编排 artifact 解码和统一注册。
func TestServiceCompletesThroughCanonicalRegistrationChain(t *testing.T) {
	t.Parallel()

	fixture := newServiceFixture(t)
	started, err := fixture.service.Start(
		context.Background(),
		registerStart("codex"),
	)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if started.Job().Status() != StatusPending ||
		started.Job().Purpose() != PurposeRegister ||
		started.Job().TargetAccountRef() != "" ||
		started.AuthorizationURL() != fixture.codex.flow.authorizationURL {
		t.Fatalf("Start() = %#v", started)
	}

	completed, err := fixture.service.Complete(
		context.Background(),
		started.Job().ID(),
		"https://localhost.invalid/callback?code=secret",
	)
	if err != nil {
		t.Fatalf("Complete() error = %v", err)
	}
	if completed.Status() != StatusCompleted ||
		!completed.AccountRef().IsValid() ||
		completed.CLIAccountID().Int64() != 1 ||
		completed.FailureCode() != "" {
		t.Fatalf("completed Job = %#v", completed)
	}
	if fixture.decoder.calls != 1 ||
		fixture.decoder.providerID != "codex" ||
		string(fixture.decoder.artifactCopy) != `{"official":"artifact"}` ||
		fixture.registrar.calls != 1 {
		t.Fatalf(
			"统一注册链调用错误: decoder=%#v registrar=%#v",
			fixture.decoder,
			fixture.registrar,
		)
	}
	if got := fixture.codex.flow.lastCallback; got != "https://localhost.invalid/callback?code=secret" {
		t.Fatalf("Flow callback = %q", got)
	}
	if _, err := fixture.service.Complete(
		context.Background(),
		started.Job().ID(),
		"second-callback",
	); !errors.Is(err, ErrJobNotPending) {
		t.Fatalf("重复 Complete() error = %v", err)
	}
}

// TestServiceCompletesThroughReauthenticationChain 验证 reauth 不会误走新账号注册。
func TestServiceCompletesThroughReauthenticationChain(t *testing.T) {
	t.Parallel()

	fixture := newServiceFixture(t)
	credential, profile := newAccountAuthCodexOAuth(t)
	fixture.decoder.credential = credential
	fixture.decoder.profile = profile
	targetRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}

	started, err := fixture.service.Start(context.Background(), StartRequest{
		ProviderID:       "codex",
		TargetAccountRef: targetRef,
	})
	if err != nil {
		t.Fatalf("Start(reauth) error = %v", err)
	}
	if started.Job().Purpose() != PurposeReauth ||
		started.Job().TargetAccountRef() != targetRef ||
		fixture.reauth.validateCalls != 1 ||
		fixture.reauth.validatedProviderID != "codex" {
		t.Fatalf(
			"reauth start = %#v reauth=%#v",
			started.Job(),
			fixture.reauth,
		)
	}
	completed, err := fixture.service.Complete(
		context.Background(),
		started.Job().ID(),
		"https://localhost.invalid/callback?code=reauth",
	)
	if err != nil {
		t.Fatalf("Complete(reauth) error = %v", err)
	}
	if completed.Status() != StatusCompleted ||
		completed.AccountRef() != targetRef ||
		completed.CLIAccountID().Int64() != 7 ||
		fixture.reauth.calls != 1 ||
		fixture.registrar.calls != 0 {
		t.Fatalf(
			"reauth complete = %#v reauth=%#v registrar=%#v",
			completed,
			fixture.reauth,
			fixture.registrar,
		)
	}
}

// TestServiceRejectsUnsupportedTargetBeforeCreatingOAuthFlow 验证目标预检失败不生成 state。
func TestServiceRejectsUnsupportedTargetBeforeCreatingOAuthFlow(t *testing.T) {
	t.Parallel()

	fixture := newServiceFixture(t)
	fixture.reauth.validateErr = accountapp.ErrReauthenticationUnsupported
	targetRef, err := accountcore.ParseAccountRef("acct_1234567890abcdef1234")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}

	_, err = fixture.service.Start(context.Background(), StartRequest{
		ProviderID:       "codex",
		TargetAccountRef: targetRef,
	})
	if !errors.Is(err, accountapp.ErrReauthenticationUnsupported) {
		t.Fatalf("Start(unsupported reauth) error = %v", err)
	}
	if fixture.codex.beginCalls != 0 {
		t.Fatalf("目标预检失败仍创建 OAuth Flow %d 次", fixture.codex.beginCalls)
	}
}

// TestServiceEnforcesOneActiveJobPerProvider 验证 Provider 级并发约束不会阻塞另一个 Provider。
func TestServiceEnforcesOneActiveJobPerProvider(t *testing.T) {
	t.Parallel()

	fixture := newServiceFixture(t)
	codexJob, err := fixture.service.Start(
		context.Background(),
		registerStart("codex"),
	)
	if err != nil {
		t.Fatalf("Start(codex) error = %v", err)
	}
	if _, err := fixture.service.Start(
		context.Background(),
		registerStart("codex"),
	); !errors.Is(err, ErrActiveJobExists) {
		t.Fatalf("重复 Start(codex) error = %v", err)
	}
	if _, err := fixture.service.Start(
		context.Background(),
		registerStart("claude"),
	); err != nil {
		t.Fatalf("Start(claude) error = %v", err)
	}
	if _, err := fixture.service.Cancel(codexJob.Job().ID()); err != nil {
		t.Fatalf("Cancel() error = %v", err)
	}
	if _, err := fixture.service.Start(
		context.Background(),
		registerStart("codex"),
	); err != nil {
		t.Fatalf("取消后 Start(codex) error = %v", err)
	}
}

// TestServiceExpiresAndPrunesJobs 验证超时 Job 先可观察为 expired，再在保留期后删除。
func TestServiceExpiresAndPrunesJobs(t *testing.T) {
	t.Parallel()

	fixture := newServiceFixture(t)
	started, err := fixture.service.Start(
		context.Background(),
		registerStart("codex"),
	)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	fixture.clock.advance(2 * time.Minute)
	expired, err := fixture.service.Get(started.Job().ID())
	if err != nil {
		t.Fatalf("Get(expired) error = %v", err)
	}
	if expired.Status() != StatusExpired ||
		expired.FailureCode() != "expired" {
		t.Fatalf("expired Job = %#v", expired)
	}
	if _, err := fixture.service.Complete(
		context.Background(),
		started.Job().ID(),
		"late",
	); !errors.Is(err, ErrJobExpired) {
		t.Fatalf("过期 Complete() error = %v", err)
	}
	if _, err := fixture.service.Start(
		context.Background(),
		registerStart("codex"),
	); err != nil {
		t.Fatalf("过期后 Start() error = %v", err)
	}
	fixture.clock.advance(2 * time.Minute)
	if _, err := fixture.service.Get(
		started.Job().ID(),
	); !errors.Is(err, ErrJobNotFound) {
		t.Fatalf("保留期后 Get() error = %v", err)
	}
}

// TestServiceAllowsOnlyOneConcurrentCompletion 验证并发回调只有一个能消费私有 Flow。
func TestServiceAllowsOnlyOneConcurrentCompletion(t *testing.T) {
	t.Parallel()

	fixture := newServiceFixture(t)
	fixture.codex.flow.started = make(chan struct{})
	fixture.codex.flow.release = make(chan struct{})
	started, err := fixture.service.Start(
		context.Background(),
		registerStart("codex"),
	)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	firstResult := make(chan error, 1)
	go func() {
		_, completeErr := fixture.service.Complete(
			context.Background(),
			started.Job().ID(),
			"first",
		)
		firstResult <- completeErr
	}()
	<-fixture.codex.flow.started
	if _, err := fixture.service.Complete(
		context.Background(),
		started.Job().ID(),
		"second",
	); !errors.Is(err, ErrJobNotPending) {
		t.Fatalf("并发 Complete() error = %v", err)
	}
	close(fixture.codex.flow.release)
	if err := <-firstResult; err != nil {
		t.Fatalf("首个 Complete() error = %v", err)
	}
	if fixture.codex.flow.exchangeCalls != 1 {
		t.Fatalf("Exchange() calls = %d", fixture.codex.flow.exchangeCalls)
	}
}

// TestServiceRecordsSafeFailureCode 验证 Job 不保存 Provider 内部错误文本。
func TestServiceRecordsSafeFailureCode(t *testing.T) {
	t.Parallel()

	fixture := newServiceFixture(t)
	fixture.codex.flow.exchangeErr = errors.Join(
		ErrProviderUnavailable,
		errors.New("upstream contained secret-token"),
	)
	started, err := fixture.service.Start(
		context.Background(),
		registerStart("codex"),
	)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	failed, err := fixture.service.Complete(
		context.Background(),
		started.Job().ID(),
		"callback-secret",
	)
	if !errors.Is(err, ErrProviderUnavailable) {
		t.Fatalf("Complete() error = %v", err)
	}
	if failed.Status() != StatusFailed ||
		failed.FailureCode() != "provider_unavailable" {
		t.Fatalf("failed Job = %#v", failed)
	}
}

// serviceFixture 集中创建状态机测试所需的可控依赖。
type serviceFixture struct {
	service   *Service
	clock     *clockStub
	codex     *providerStub
	claude    *providerStub
	decoder   *decoderStub
	registrar *registrarStub
	reauth    *reauthenticatorStub
}

// newServiceFixture 创建使用短 TTL、短保留期的确定性测试服务。
func newServiceFixture(t *testing.T) serviceFixture {
	t.Helper()

	clock := &clockStub{
		current: time.Date(2026, 7, 27, 12, 0, 0, 0, time.UTC),
	}
	codexProvider := &providerStub{
		providerID: "codex",
		flow: &flowStub{
			authorizationURL: "https://auth.openai.com/oauth/authorize?redacted=1",
			artifact:         []byte(`{"official":"artifact"}`),
		},
	}
	claudeProvider := &providerStub{
		providerID: "claude",
		flow: &flowStub{
			authorizationURL: "https://claude.com/cai/oauth/authorize?redacted=1",
			artifact:         []byte(`{"official":"artifact"}`),
		},
	}
	decoder := &decoderStub{}
	registrar := newRegistrarStub(t)
	reauth := newReauthenticatorStub(t)
	idGenerator := &sequentialIDGenerator{}
	service, err := newService(Dependencies{
		Providers:  []OAuthProvider{codexProvider, claudeProvider},
		Decoder:    decoder,
		Registrar:  registrar,
		Reauth:     reauth,
		Clock:      clock.now,
		GenerateID: idGenerator.next,
	}, serviceSettings{
		jobTTL:            time.Minute,
		terminalRetention: time.Minute,
		maxJobs:           4,
	})
	if err != nil {
		t.Fatalf("newService() error = %v", err)
	}
	return serviceFixture{
		service:   service,
		clock:     clock,
		codex:     codexProvider,
		claude:    claudeProvider,
		decoder:   decoder,
		registrar: registrar,
		reauth:    reauth,
	}
}

// providerStub 返回预先配置的一次性 OAuth Flow。
type providerStub struct {
	providerID string
	flow       *flowStub
	beginCalls int
}

// ProviderID 返回测试 Provider 标识。
func (provider *providerStub) ProviderID() string {
	return provider.providerID
}

// Begin 返回测试 Flow；每个 Job 都使用独立值副本。
func (provider *providerStub) Begin(context.Context) (OAuthFlow, error) {
	provider.beginCalls++
	cloned := &flowStub{
		authorizationURL: provider.flow.authorizationURL,
		artifact:         append([]byte(nil), provider.flow.artifact...),
		exchangeErr:      provider.flow.exchangeErr,
		started:          provider.flow.started,
		release:          provider.flow.release,
	}
	provider.flow = cloned
	return cloned, nil
}

// flowStub 记录回调消费次数，并可阻塞并发测试。
type flowStub struct {
	mu               sync.Mutex
	authorizationURL string
	artifact         []byte
	exchangeErr      error
	lastCallback     string
	exchangeCalls    int
	started          chan struct{}
	release          chan struct{}
}

// AuthorizationURL 返回固定测试授权地址。
func (flow *flowStub) AuthorizationURL() string {
	return flow.authorizationURL
}

// Exchange 记录回调，并返回独立 artifact 缓冲区。
func (flow *flowStub) Exchange(
	_ context.Context,
	callback string,
) ([]byte, error) {
	flow.mu.Lock()
	flow.exchangeCalls++
	flow.lastCallback = callback
	started := flow.started
	release := flow.release
	exchangeErr := flow.exchangeErr
	artifact := append([]byte(nil), flow.artifact...)
	flow.mu.Unlock()
	if started != nil {
		close(started)
	}
	if release != nil {
		<-release
	}
	if exchangeErr != nil {
		return nil, exchangeErr
	}
	return artifact, nil
}

// decoderStub 记录 Provider 和 artifact，返回已校验的 Codex API Key 凭据。
type decoderStub struct {
	calls        int
	providerID   string
	artifactCopy []byte
	credential   accountapp.Credential
	profile      accountapp.PublicProfile
}

// Decode 实现原生 artifact 反腐端口。
func (decoder *decoderStub) Decode(
	providerID string,
	artifactsJSON []byte,
) (accountapp.Credential, accountapp.PublicProfile, error) {
	decoder.calls++
	decoder.providerID = providerID
	decoder.artifactCopy = append([]byte(nil), artifactsJSON...)
	if decoder.credential != nil {
		return decoder.credential, decoder.profile, nil
	}
	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey: "synthetic-accountauth-test-key",
	})
	return credential, nil, err
}

// reauthenticatorStub 使用真实账号领域验证 reauth 结果仍绑定目标身份。
type reauthenticatorStub struct {
	t                   *testing.T
	catalog             *providers.Catalog
	validateErr         error
	validatedTarget     accountcore.AccountRef
	validatedProviderID string
	validateCalls       int
	calls               int
}

// newReauthenticatorStub 创建可返回稳定数字别名的 reauth 测试端口。
func newReauthenticatorStub(t *testing.T) *reauthenticatorStub {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	return &reauthenticatorStub{t: t, catalog: catalog}
}

// ValidateTarget 记录 OAuth Flow 创建前的目标检查。
func (stub *reauthenticatorStub) ValidateTarget(
	_ context.Context,
	accountRef accountcore.AccountRef,
	providerID string,
) error {
	stub.validateCalls++
	stub.validatedTarget = accountRef
	stub.validatedProviderID = providerID
	return stub.validateErr
}

// Reauthenticate 保持目标身份并返回固定已有别名。
func (stub *reauthenticatorStub) Reauthenticate(
	_ context.Context,
	accountRef accountcore.AccountRef,
	credential accountapp.Credential,
	_ accountapp.PublicProfile,
) (accountcore.Account, error) {
	stub.t.Helper()
	stub.calls++
	derivedRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil || derivedRef != accountRef {
		return accountcore.Account{}, accountapp.ErrReauthenticationIdentityMismatch
	}
	alias, err := accountcore.NewCLIAccountID(7)
	if err != nil {
		return accountcore.Account{}, err
	}
	return accountcore.NewAccount(stub.catalog, accountcore.NewAccountInput{
		Identity:     credential,
		CLIAccountID: alias,
		CreatedAt:    time.Date(2026, 7, 27, 11, 0, 0, 0, time.UTC),
	})
}

// registrarStub 使用真实账号领域构造器返回注册结果。
type registrarStub struct {
	t       *testing.T
	catalog *providers.Catalog
	calls   int
}

// newRegistrarStub 创建内置 Provider Catalog。
func newRegistrarStub(t *testing.T) *registrarStub {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	return &registrarStub{t: t, catalog: catalog}
}

// Register 记录调用并分配固定数字别名。
func (registrar *registrarStub) Register(
	_ context.Context,
	credential accountapp.Credential,
	_ accountapp.PublicProfile,
) (accountcore.Account, error) {
	registrar.t.Helper()
	registrar.calls++
	cliAccountID, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		return accountcore.Account{}, err
	}
	return accountcore.NewAccount(registrar.catalog, accountcore.NewAccountInput{
		Identity:     credential,
		CLIAccountID: cliAccountID,
		CreatedAt:    time.Date(2026, 7, 27, 12, 0, 0, 0, time.UTC),
	})
}

// clockStub 提供可手动推进的测试时钟。
type clockStub struct {
	mu      sync.Mutex
	current time.Time
}

// now 返回当前测试时间。
func (clock *clockStub) now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return clock.current
}

// advance 推进测试时间。
func (clock *clockStub) advance(duration time.Duration) {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	clock.current = clock.current.Add(duration)
}

// sequentialIDGenerator 生成可预测且符合生产格式的唯一 Job ID。
type sequentialIDGenerator struct {
	mu    sync.Mutex
	value uint64
}

// next 返回下一个 128 位小写十六进制 ID。
func (generator *sequentialIDGenerator) next() (string, error) {
	generator.mu.Lock()
	defer generator.mu.Unlock()
	generator.value++
	const prefix = "0000000000000000"
	suffix := []byte("0000000000000000")
	value := generator.value
	for index := len(suffix) - 1; index >= 0 && value > 0; index-- {
		const digits = "0123456789abcdef"
		suffix[index] = digits[value&0xf]
		value >>= 4
	}
	return prefix + string(suffix), nil
}

// registerStart 创建不带目标账号的新注册命令。
func registerStart(providerID string) StartRequest {
	return StartRequest{ProviderID: providerID}
}

// newAccountAuthCodexOAuth 创建 reauth 状态机使用的同身份凭据和公开资料。
func newAccountAuthCodexOAuth(
	t *testing.T,
) (*codex.OAuthAuth, codex.AccountProfile) {
	t.Helper()

	credential, err := codex.NewOAuthAuth(codex.OAuthInput{
		AccessToken:  "synthetic-accountauth-oauth-access",
		RefreshToken: "synthetic-accountauth-oauth-refresh",
		IDToken:      accountAuthTestJWT(t),
		RefreshedAtMS: time.Date(
			2026,
			7,
			27,
			12,
			0,
			0,
			0,
			time.UTC,
		).UnixMilli(),
		ExplicitAccountID: "accountauth-workspace",
	})
	if err != nil {
		t.Fatalf("codex.NewOAuthAuth() error = %v", err)
	}
	profile, err := codex.NewAccountProfile(credential.Profile())
	if err != nil {
		t.Fatalf("codex.NewAccountProfile() error = %v", err)
	}
	return credential, profile
}

// accountAuthTestJWT 创建只用于本地领域构造的合成 Codex ID Token。
func accountAuthTestJWT(t *testing.T) string {
	t.Helper()

	header, err := json.Marshal(map[string]any{"alg": "none", "typ": "JWT"})
	if err != nil {
		t.Fatalf("json.Marshal(header) error = %v", err)
	}
	payload, err := json.Marshal(map[string]any{
		"sub":   "accountauth-user",
		"email": "accountauth@example.invalid",
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": "accountauth-workspace",
			"chatgpt_plan_type":  "plus",
		},
	})
	if err != nil {
		t.Fatalf("json.Marshal(payload) error = %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(header) + "." +
		base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}
