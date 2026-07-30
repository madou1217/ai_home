package accountrouting

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

// TestRecruiterReturnsFirstUsableCandidate 验证征召器只解析首个可用账号。
func TestRecruiterReturnsFirstUsableCandidate(t *testing.T) {
	t.Parallel()

	first, firstCredential := newRecruitmentCandidate(t, "codex", 1, "first")
	second, secondCredential := newRecruitmentCandidate(t, "codex", 2, "second")
	source := &recruitmentCandidateSource{
		candidates: []accountapp.RoutingAccount{first, second},
	}
	resolver := newRecruitmentCredentialResolver(
		map[accountcore.AccountRef]credentialResolution{
			first.Ref():  {credential: firstCredential},
			second.Ref(): {credential: secondCredential},
		},
	)
	recruiter := newTestRecruiter(t, source, resolver)
	request := newTestRequest(t, "codex", "", 2)

	result, err := recruiter.Recruit(context.Background(), request)
	if err != nil {
		t.Fatalf("Recruit() error = %v", err)
	}
	if result.Account().Ref() != first.Ref() ||
		result.Credential().IdentitySeed() != firstCredential.IdentitySeed() ||
		result.Examined() != 1 ||
		result.NextAfterRef() != first.Ref() ||
		result.SourceExhausted() {
		t.Fatalf("Recruit() result = %#v", result)
	}
	if resolver.CallCount() != 1 {
		t.Fatalf("ResolveCredential() calls = %d, want 1", resolver.CallCount())
	}
}

// TestRecruiterSkipsRuntimeBlockedAccountBeforeCredential 验证运行态筛选先于敏感凭据读取。
func TestRecruiterSkipsRuntimeBlockedAccountBeforeCredential(t *testing.T) {
	t.Parallel()

	blocked, blockedCredential := newRecruitmentCandidate(
		t,
		"codex",
		1,
		"runtime-blocked",
	)
	ready, readyCredential := newRecruitmentCandidate(
		t,
		"codex",
		2,
		"runtime-ready",
	)
	source := &recruitmentCandidateSource{
		candidates: []accountapp.RoutingAccount{blocked, ready},
	}
	runtimeSource := &recruitmentEligibilitySource{
		eligibility: map[accountcore.AccountRef]runtimecore.Eligibility{
			blocked.Ref(): runtimecore.QuotaBlockedEligibility(),
		},
	}
	resolver := newRecruitmentCredentialResolver(
		map[accountcore.AccountRef]credentialResolution{
			blocked.Ref(): {credential: blockedCredential},
			ready.Ref():   {credential: readyCredential},
		},
	)
	recruiter := newTestRecruiterWithRuntime(
		t,
		source,
		runtimeSource,
		resolver,
	)
	request := newTestRequest(t, "codex", "", 2)

	result, err := recruiter.Recruit(context.Background(), request)
	if err != nil {
		t.Fatalf("Recruit() error = %v", err)
	}
	if result.Account().Ref() != ready.Ref() ||
		result.Examined() != 2 ||
		resolver.CallCount() != 1 {
		t.Fatalf(
			"Recruit() result=%#v credentialCalls=%d",
			result,
			resolver.CallCount(),
		)
	}
	routes := runtimeSource.Routes()
	if len(routes) != 2 ||
		routes[0].ModelID() != request.ModelID() ||
		routes[1].ModelID() != request.ModelID() {
		t.Fatalf("CheckEligibility() routes = %#v", routes)
	}
}

// TestRecruiterSkipsAccountWithoutTargetModel 验证模型权限不足不会污染运行态，
// 且不会阻止后续账号继续参与同一真实模型征召。
func TestRecruiterSkipsAccountWithoutTargetModel(t *testing.T) {
	t.Parallel()

	unsupported, unsupportedCredential := newRecruitmentCandidate(
		t,
		"codex",
		1,
		"model-unsupported",
	)
	ready, readyCredential := newRecruitmentCandidate(
		t,
		"codex",
		2,
		"model-ready",
	)
	source := &recruitmentCandidateSource{
		candidates: []accountapp.RoutingAccount{unsupported, ready},
	}
	models := &recruitmentModelAvailabilitySource{
		availability: map[accountcore.AccountRef]bool{
			unsupported.Ref(): false,
			ready.Ref():       true,
		},
	}
	resolver := newRecruitmentCredentialResolver(
		map[accountcore.AccountRef]credentialResolution{
			unsupported.Ref(): {credential: unsupportedCredential},
			ready.Ref():       {credential: readyCredential},
		},
	)
	recruiter := newTestRecruiterWithFilters(
		t,
		source,
		&recruitmentEligibilitySource{},
		models,
		resolver,
	)
	request := newTestRequest(t, "codex", "", 2)

	result, err := recruiter.Recruit(context.Background(), request)
	if err != nil {
		t.Fatalf("Recruit() error = %v", err)
	}
	if result.Account().Ref() != ready.Ref() ||
		result.Examined() != 2 ||
		resolver.CallCount() != 2 {
		t.Fatalf(
			"Recruit() result=%#v credentialCalls=%d",
			result,
			resolver.CallCount(),
		)
	}
	routes := models.Routes()
	if len(routes) != 2 ||
		routes[0].AccountRef() != unsupported.Ref() ||
		routes[1].AccountRef() != ready.Ref() ||
		routes[0].ModelID() != request.ModelID() ||
		routes[1].ModelID() != request.ModelID() {
		t.Fatalf("CheckAvailability() routes = %#v", routes)
	}
}

// TestRecruiterFailsClosedOnModelAvailabilityError 验证目录或缓存错误不会被
// 误判为账号不支持模型，也不会继续发送上游请求。
func TestRecruiterFailsClosedOnModelAvailabilityError(t *testing.T) {
	t.Parallel()

	candidate, credential := newRecruitmentCandidate(
		t,
		"codex",
		1,
		"model-check-failure",
	)
	source := &recruitmentCandidateSource{
		candidates: []accountapp.RoutingAccount{candidate},
	}
	expected := errors.New("synthetic model catalog failure")
	models := &recruitmentModelAvailabilitySource{err: expected}
	resolver := newRecruitmentCredentialResolver(
		map[accountcore.AccountRef]credentialResolution{
			candidate.Ref(): {credential: credential},
		},
	)
	recruiter := newTestRecruiterWithFilters(
		t,
		source,
		&recruitmentEligibilitySource{},
		models,
		resolver,
	)

	result, err := recruiter.Recruit(
		context.Background(),
		newTestRequest(t, "codex", "", 1),
	)
	if !errors.Is(err, ErrModelAvailabilityCheck) ||
		!errors.Is(err, expected) ||
		result.Examined() != 1 {
		t.Fatalf("Recruit() result=%#v error=%v", result, err)
	}
}

// TestRecruiterFailsClosedOnInvalidRuntimeEligibility 验证非法运行态投影不会被当成可用。
func TestRecruiterFailsClosedOnInvalidRuntimeEligibility(t *testing.T) {
	t.Parallel()

	candidate, credential := newRecruitmentCandidate(
		t,
		"claude",
		1,
		"invalid-runtime",
	)
	source := &recruitmentCandidateSource{
		candidates: []accountapp.RoutingAccount{candidate},
	}
	runtimeSource := &recruitmentEligibilitySource{
		eligibility: map[accountcore.AccountRef]runtimecore.Eligibility{
			candidate.Ref(): {},
		},
	}
	resolver := newRecruitmentCredentialResolver(
		map[accountcore.AccountRef]credentialResolution{
			candidate.Ref(): {credential: credential},
		},
	)
	recruiter := newTestRecruiterWithRuntime(
		t,
		source,
		runtimeSource,
		resolver,
	)

	_, err := recruiter.Recruit(
		context.Background(),
		newTestRequest(t, "claude", "", 1),
	)
	if !errors.Is(err, ErrInvalidRuntimeEligibility) ||
		resolver.CallCount() != 0 {
		t.Fatalf(
			"Recruit() error=%v credentialCalls=%d",
			err,
			resolver.CallCount(),
		)
	}
}

// TestRecruiterSkipsAccountScopedCredentialFailures 验证单账号认证故障不会阻塞后续候选。
func TestRecruiterSkipsAccountScopedCredentialFailures(t *testing.T) {
	t.Parallel()

	missing, _ := newRecruitmentCandidate(t, "claude", 1, "missing")
	reauth, _ := newRecruitmentCandidate(t, "claude", 2, "reauth")
	unavailable, _ := newRecruitmentCandidate(t, "claude", 3, "unavailable")
	ready, readyCredential := newRecruitmentCandidate(t, "claude", 4, "ready")
	source := &recruitmentCandidateSource{
		candidates: []accountapp.RoutingAccount{
			missing,
			reauth,
			unavailable,
			ready,
		},
	}
	resolver := newRecruitmentCredentialResolver(
		map[accountcore.AccountRef]credentialResolution{
			missing.Ref(): {
				err: accountapp.ErrCredentialNotFound,
			},
			reauth.Ref(): {
				err: accountcredentials.ErrReauthenticationRequired,
			},
			unavailable.Ref(): {
				err: accountcredentials.ErrRefreshUnavailable,
			},
			ready.Ref(): {
				credential: readyCredential,
			},
		},
	)
	recruiter := newTestRecruiter(t, source, resolver)
	request := newTestRequest(t, "claude", "", 5)

	result, err := recruiter.Recruit(context.Background(), request)
	if err != nil {
		t.Fatalf("Recruit() error = %v", err)
	}
	if result.Account().Ref() != ready.Ref() ||
		result.Examined() != 4 ||
		result.NextAfterRef() != ready.Ref() ||
		!result.SourceExhausted() {
		t.Fatalf("Recruit() result = %#v", result)
	}
}

// TestRecruiterReturnsProgressWhenPageHasNoUsableAccount 验证无可用账号时仍返回稳定续查游标。
func TestRecruiterReturnsProgressWhenPageHasNoUsableAccount(t *testing.T) {
	t.Parallel()

	first, _ := newRecruitmentCandidate(t, "codex", 1, "missing-1")
	second, _ := newRecruitmentCandidate(t, "codex", 2, "missing-2")
	source := &recruitmentCandidateSource{
		candidates: []accountapp.RoutingAccount{first, second},
	}
	resolver := newRecruitmentCredentialResolver(
		map[accountcore.AccountRef]credentialResolution{
			first.Ref():  {err: accountapp.ErrCredentialNotFound},
			second.Ref(): {err: accountcredentials.ErrRefreshRejected},
		},
	)
	recruiter := newTestRecruiter(t, source, resolver)
	request := newTestRequest(t, "codex", "", 2)

	result, err := recruiter.Recruit(context.Background(), request)
	if !errors.Is(err, ErrNoRoutableAccount) {
		t.Fatalf("Recruit() error = %v, want ErrNoRoutableAccount", err)
	}
	if result.Examined() != 2 ||
		result.NextAfterRef() != second.Ref() ||
		result.SourceExhausted() {
		t.Fatalf("Recruit() result = %#v", result)
	}
}

// TestRecruiterFailsClosedOnUnexpectedResolutionError 验证未知错误不会被误判为单账号不可用。
func TestRecruiterFailsClosedOnUnexpectedResolutionError(t *testing.T) {
	t.Parallel()

	first, _ := newRecruitmentCandidate(t, "codex", 1, "broken")
	second, secondCredential := newRecruitmentCandidate(t, "codex", 2, "unused")
	source := &recruitmentCandidateSource{
		candidates: []accountapp.RoutingAccount{first, second},
	}
	unexpected := errors.New("synthetic database failure")
	resolver := newRecruitmentCredentialResolver(
		map[accountcore.AccountRef]credentialResolution{
			first.Ref():  {err: unexpected},
			second.Ref(): {credential: secondCredential},
		},
	)
	recruiter := newTestRecruiter(t, source, resolver)
	request := newTestRequest(t, "codex", "", 2)

	result, err := recruiter.Recruit(context.Background(), request)
	if !errors.Is(err, unexpected) {
		t.Fatalf("Recruit() error = %v, want unexpected error", err)
	}
	if result.Examined() != 1 ||
		result.NextAfterRef() != first.Ref() ||
		resolver.CallCount() != 1 {
		t.Fatalf(
			"Recruit() result=%#v calls=%d",
			result,
			resolver.CallCount(),
		)
	}
}

// TestRecruiterRejectsCredentialBoundToAnotherAccount 验证解析结果不能改变候选身份。
func TestRecruiterRejectsCredentialBoundToAnotherAccount(t *testing.T) {
	t.Parallel()

	candidate, _ := newRecruitmentCandidate(t, "claude", 1, "candidate")
	_, foreignCredential := newRecruitmentCandidate(t, "claude", 2, "foreign")
	source := &recruitmentCandidateSource{
		candidates: []accountapp.RoutingAccount{candidate},
	}
	resolver := newRecruitmentCredentialResolver(
		map[accountcore.AccountRef]credentialResolution{
			candidate.Ref(): {credential: foreignCredential},
		},
	)
	recruiter := newTestRecruiter(t, source, resolver)
	request := newTestRequest(t, "claude", "", 1)

	_, err := recruiter.Recruit(context.Background(), request)
	if !errors.Is(err, ErrInvalidResolvedCredential) {
		t.Fatalf(
			"Recruit() error = %v, want ErrInvalidResolvedCredential",
			err,
		)
	}
}

// TestRecruiterValidatesDependenciesRequestAndContext 验证公共入口在 I/O 前失败关闭。
func TestRecruiterValidatesDependenciesRequestAndContext(t *testing.T) {
	t.Parallel()

	if _, err := NewRecruiter(Dependencies{}); !errors.Is(
		err,
		ErrInvalidDependencies,
	) {
		t.Fatalf("NewRecruiter() error = %v, want ErrInvalidDependencies", err)
	}
	source := &recruitmentCandidateSource{}
	resolver := newRecruitmentCredentialResolver(nil)
	recruiter := newTestRecruiter(t, source, resolver)

	if _, err := recruiter.Recruit(
		context.Background(),
		Request{},
	); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("Recruit(zero request) error = %v, want ErrInvalidRequest", err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	request := newTestRequest(t, "codex", "", 1)
	if _, err := recruiter.Recruit(cancelled, request); !errors.Is(
		err,
		context.Canceled,
	) {
		t.Fatalf("Recruit(cancelled) error = %v, want context.Canceled", err)
	}
	if source.CallCount() != 0 {
		t.Fatalf("ListRoutingCandidates() calls = %d, want 0", source.CallCount())
	}
}

// newTestRecruiter 创建仅依赖内存端口的征召器。
func newTestRecruiter(
	t *testing.T,
	source CandidateSource,
	resolver CredentialResolver,
) *Recruiter {
	t.Helper()

	return newTestRecruiterWithRuntime(
		t,
		source,
		&recruitmentEligibilitySource{},
		resolver,
	)
}

// newTestRecruiterWithRuntime 创建可注入运行态资格端口的征召器。
func newTestRecruiterWithRuntime(
	t *testing.T,
	source CandidateSource,
	runtimeSource RuntimeEligibilitySource,
	resolver CredentialResolver,
) *Recruiter {
	t.Helper()

	return newTestRecruiterWithFilters(
		t,
		source,
		runtimeSource,
		&recruitmentModelAvailabilitySource{},
		resolver,
	)
}

// newTestRecruiterWithFilters 创建可分别注入运行态和模型权限端口的征召器。
func newTestRecruiterWithFilters(
	t *testing.T,
	source CandidateSource,
	runtimeSource RuntimeEligibilitySource,
	models ModelAvailabilitySource,
	resolver CredentialResolver,
) *Recruiter {
	t.Helper()

	recruiter, err := NewRecruiter(Dependencies{
		Candidates:  source,
		Runtime:     runtimeSource,
		Credentials: resolver,
		Models:      models,
	})
	if err != nil {
		t.Fatalf("NewRecruiter() error = %v", err)
	}
	return recruiter
}

// newTestRequest 创建使用内置 Provider 合同的征召请求。
func newTestRequest(
	t *testing.T,
	providerID string,
	afterRef accountcore.AccountRef,
	limit int,
) Request {
	t.Helper()

	request, err := NewRequest(
		testRecruitmentCatalog(t),
		providerID,
		testModelID(providerID),
		afterRef,
		limit,
	)
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	return request
}

// testModelID 返回当前两种 Provider 的确定性真实模型 ID。
func testModelID(providerID string) string {
	if providerID == "claude" {
		return "claude-sonnet-4"
	}
	return "gpt-5.6-sol"
}

// testRecruitmentCatalog 创建生产内置 Provider 注册表。
func testRecruitmentCatalog(t *testing.T) *providers.Catalog {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	return catalog
}

// newRecruitmentCandidate 创建身份可验证的候选与无敏感测试凭据。
func newRecruitmentCandidate(
	t *testing.T,
	providerID string,
	alias int64,
	identity string,
) (accountapp.RoutingAccount, recruitmentCredential) {
	t.Helper()

	credential := recruitmentCredential{
		providerID:   providerID,
		identitySeed: providerID + ":routing-test:" + identity,
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	cliAccountID, err := accountcore.NewCLIAccountID(alias)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	candidate, err := accountapp.NewRoutingAccount(
		testRecruitmentCatalog(t),
		accountapp.RoutingAccountInput{
			Ref:          accountRef,
			ProviderID:   providerID,
			CLIAccountID: cliAccountID,
		},
	)
	if err != nil {
		t.Fatalf("NewRoutingAccount() error = %v", err)
	}
	return candidate, credential
}

// recruitmentCredential 是不会泄漏身份种子的测试凭据。
type recruitmentCredential struct {
	providerID   string
	identitySeed string
}

// ProviderID 返回测试凭据所属 Provider。
func (credential recruitmentCredential) ProviderID() string {
	return credential.providerID
}

// IdentitySeed 返回测试账号稳定身份种子。
func (credential recruitmentCredential) IdentitySeed() string {
	return credential.identitySeed
}

// String 返回不含身份种子的安全摘要。
func (credential recruitmentCredential) String() string {
	return fmt.Sprintf("recruitmentCredential{%s}", credential.providerID)
}

// GoString 复用安全测试摘要。
func (credential recruitmentCredential) GoString() string {
	return credential.String()
}

// recruitmentCandidateSource 是可计数的候选读取测试替身。
type recruitmentCandidateSource struct {
	mu         sync.Mutex
	candidates []accountapp.RoutingAccount
	err        error
	calls      int
}

// ListRoutingCandidates 返回已配置的有界候选页。
func (source *recruitmentCandidateSource) ListRoutingCandidates(
	_ context.Context,
	query accountapp.RoutingQuery,
) ([]accountapp.RoutingAccount, error) {
	source.mu.Lock()
	defer source.mu.Unlock()
	source.calls++
	if source.err != nil {
		return nil, source.err
	}
	count := min(len(source.candidates), query.Limit())
	return append(
		[]accountapp.RoutingAccount(nil),
		source.candidates[:count]...,
	), nil
}

// CallCount 返回候选读取次数。
func (source *recruitmentCandidateSource) CallCount() int {
	source.mu.Lock()
	defer source.mu.Unlock()
	return source.calls
}

// credentialResolution 保存单账号解析结果。
type credentialResolution struct {
	credential accountapp.Credential
	err        error
}

// recruitmentCredentialResolver 是按 AccountRef 返回结果的测试替身。
type recruitmentCredentialResolver struct {
	mu          sync.Mutex
	resolutions map[accountcore.AccountRef]credentialResolution
	calls       int
}

// newRecruitmentCredentialResolver 创建隔离调用计数的凭据测试端口。
func newRecruitmentCredentialResolver(
	resolutions map[accountcore.AccountRef]credentialResolution,
) *recruitmentCredentialResolver {
	return &recruitmentCredentialResolver{resolutions: resolutions}
}

// ResolveCredential 返回目标账号预设的凭据或错误。
func (resolver *recruitmentCredentialResolver) ResolveCredential(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.Credential, error) {
	resolver.mu.Lock()
	defer resolver.mu.Unlock()
	resolver.calls++
	resolution, found := resolver.resolutions[accountRef]
	if !found {
		return nil, accountapp.ErrCredentialNotFound
	}
	return resolution.credential, resolution.err
}

// CallCount 返回凭据解析调用次数。
func (resolver *recruitmentCredentialResolver) CallCount() int {
	resolver.mu.Lock()
	defer resolver.mu.Unlock()
	return resolver.calls
}

// recruitmentEligibilitySource 是按 AccountRef 返回资格的运行态测试端口。
type recruitmentEligibilitySource struct {
	mu          sync.Mutex
	eligibility map[accountcore.AccountRef]runtimecore.Eligibility
	err         error
	routes      []runtimecore.ModelRoute
}

// CheckEligibility 返回目标元组的预设资格，未配置时视为健康。
func (source *recruitmentEligibilitySource) CheckEligibility(
	_ context.Context,
	route runtimecore.ModelRoute,
) (runtimecore.Eligibility, error) {
	source.mu.Lock()
	defer source.mu.Unlock()
	source.routes = append(source.routes, route)
	if source.err != nil {
		return runtimecore.Eligibility{}, source.err
	}
	eligibility, found := source.eligibility[route.AccountRef()]
	if !found {
		return runtimecore.AvailableEligibility(), nil
	}
	return eligibility, nil
}

// Routes 返回资格端口收到的独立路由键快照。
func (source *recruitmentEligibilitySource) Routes() []runtimecore.ModelRoute {
	source.mu.Lock()
	defer source.mu.Unlock()
	return append([]runtimecore.ModelRoute(nil), source.routes...)
}

// recruitmentModelAvailabilitySource 是按 AccountRef 返回模型权限的测试端口。
type recruitmentModelAvailabilitySource struct {
	mu           sync.Mutex
	availability map[accountcore.AccountRef]bool
	err          error
	routes       []runtimecore.ModelRoute
}

// CheckAvailability 返回账号的预设模型权限，未配置时默认允许。
func (source *recruitmentModelAvailabilitySource) CheckAvailability(
	_ context.Context,
	route runtimecore.ModelRoute,
	_ accountapp.Credential,
) (bool, error) {
	source.mu.Lock()
	defer source.mu.Unlock()
	source.routes = append(source.routes, route)
	if source.err != nil {
		return false, source.err
	}
	available, found := source.availability[route.AccountRef()]
	if !found {
		return true, nil
	}
	return available, nil
}

// Routes 返回模型权限端口收到的独立路由键快照。
func (source *recruitmentModelAvailabilitySource) Routes() []runtimecore.ModelRoute {
	source.mu.Lock()
	defer source.mu.Unlock()
	return append([]runtimecore.ModelRoute(nil), source.routes...)
}
