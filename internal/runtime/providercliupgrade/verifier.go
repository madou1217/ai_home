package providercliupgrade

import (
	"context"
	"strings"
)

const (
	VerdictPass         = "pass"
	VerdictFail         = "fail"
	VerdictInconclusive = "inconclusive"
)

// Verification 描述一次安装验证的三态结论。
type Verification struct {
	Verdict string
	Detail  string
}

// IdentityVerifierDeps 提供通用同一性断言所需的回调。
type IdentityVerifierDeps struct {
	ResolveCLIPath    func(provider string) (string, error)
	ProbeVersion      func(ctx context.Context, cliPath string) (string, error)
	Realpath          func(cliPath string) string
	ExpectedOwnerPath string
}

// SameNormalizedVersion 按归一化后的纯版本号比较是否一致。
func SameNormalizedVersion(left string, right string) bool {
	return NormalizeVersionText(left) == NormalizeVersionText(right)
}

// VerifyByIdentity 执行通用同一性断言：重新解析将被启动的 CLI、核对实路径与自报版本。
func VerifyByIdentity(
	ctx context.Context,
	provider string,
	expectedVersion string,
	deps IdentityVerifierDeps,
) Verification {
	if deps.ResolveCLIPath == nil {
		return Verification{Verdict: VerdictInconclusive, Detail: "resolve_failed:resolver_nil"}
	}
	rawPath, err := deps.ResolveCLIPath(provider)
	if err != nil {
		return Verification{Verdict: VerdictInconclusive, Detail: "resolve_failed:" + err.Error()}
	}
	resolvedPath := strings.TrimSpace(rawPath)
	if resolvedPath == "" {
		return Verification{Verdict: VerdictFail, Detail: "cli_not_resolved_after_install"}
	}

	if expectedOwner := strings.TrimSpace(deps.ExpectedOwnerPath); expectedOwner != "" {
		realpathFn := deps.Realpath
		if realpathFn == nil {
			realpathFn = safeRealpath
		}
		actualOwner := strings.TrimSpace(realpathFn(resolvedPath))
		if actualOwner == "" {
			actualOwner = resolvedPath
		}
		if actualOwner != expectedOwner {
			return Verification{
				Verdict: VerdictFail,
				Detail:  "owner_mismatch:" + actualOwner + "!=" + expectedOwner,
			}
		}
	}

	if deps.ProbeVersion == nil {
		return Verification{Verdict: VerdictInconclusive, Detail: "probe_failed:prober_nil"}
	}
	rawReported, err := deps.ProbeVersion(ctx, resolvedPath)
	if err != nil {
		return Verification{Verdict: VerdictInconclusive, Detail: "probe_failed:" + err.Error()}
	}
	reported := strings.TrimSpace(rawReported)
	if reported == "" {
		return Verification{Verdict: VerdictInconclusive, Detail: "version_unreported"}
	}
	if SameNormalizedVersion(reported, expectedVersion) {
		return Verification{Verdict: VerdictPass, Detail: "version_matched:" + reported}
	}
	return Verification{
		Verdict: VerdictFail,
		Detail:  "version_mismatch:" + reported + "!=" + strings.TrimSpace(expectedVersion),
	}
}

// StrongVerifierFn 表示 provider 专属的强判据验证函数。
type StrongVerifierFn func(ctx context.Context, provider string, expectedVersion string) (Verification, error)

// CompositeVerify先过通用同一性断言，再执行可选强判据；强判据只能否决，不能把 fail 洗白。
func CompositeVerify(
	ctx context.Context,
	provider string,
	expectedVersion string,
	identityDeps IdentityVerifierDeps,
	strong StrongVerifierFn,
) Verification {
	baseline := VerifyByIdentity(ctx, provider, expectedVersion, identityDeps)
	if baseline.Verdict != VerdictPass {
		return baseline
	}
	if strong == nil {
		return baseline
	}
	res, err := strong(ctx, provider, expectedVersion)
	if err != nil {
		return Verification{Verdict: VerdictInconclusive, Detail: "strong_verifier_error:" + err.Error()}
	}
	if strings.TrimSpace(res.Verdict) == "" {
		return baseline
	}
	return res
}
