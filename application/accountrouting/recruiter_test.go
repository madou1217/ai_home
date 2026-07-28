package accountrouting

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
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

	recruiter, err := NewRecruiter(Dependencies{
		Candidates:  source,
		Credentials: resolver,
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
		afterRef,
		limit,
	)
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	return request
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
