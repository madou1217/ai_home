package providercliupgrade

import (
	"context"
	"strings"
)

// ClearBrokenVerifier 封装解除熔断前所需的两步验证（探测当前版本 + 校验可用性）。
type ClearBrokenVerifier interface {
	ProbeInstalledVersion(ctx context.Context, provider string) (string, error)
	Verify(ctx context.Context, provider string, version string) (Verification, error)
}

// ClearBrokenResult 描述解除熔断的执行结论与更新后账本。
type ClearBrokenResult struct {
	OK       bool
	Ledger   Ledger
	Reason   string
	Detail   string
	Version  string
	Verified bool
}

// ClearBrokenProvider 在确认账本处于熔断态且（可选）当前 CLI 验证通过后清除熔断。
func ClearBrokenProvider(
	ctx context.Context,
	provider string,
	ledger Ledger,
	verifier ClearBrokenVerifier,
	nowMs int64,
) ClearBrokenResult {
	record := ledger.Record(provider)
	if record.State != StateBroken && record.Enabled {
		return ClearBrokenResult{OK: false, Ledger: ledger, Reason: "not_broken"}
	}

	version := record.InstalledVersion
	detail := ""
	verified := false
	if verifier != nil {
		probed, err := verifier.ProbeInstalledVersion(ctx, provider)
		if err != nil {
			return ClearBrokenResult{
				OK:     false,
				Ledger: ledger,
				Reason: "installed_version_unknown",
				Detail: err.Error(),
			}
		}
		version = strings.TrimSpace(probed)
		if version == "" {
			return ClearBrokenResult{
				OK:     false,
				Ledger: ledger,
				Reason: "installed_version_unknown",
			}
		}
		verdict, err := verifier.Verify(ctx, provider, version)
		if err != nil {
			return ClearBrokenResult{
				OK:      false,
				Ledger:  ledger,
				Reason:  "verify_inconclusive",
				Detail:  err.Error(),
				Version: version,
			}
		}
		if verdict.Verdict != VerdictPass {
			reason := "verify_inconclusive"
			if verdict.Verdict == VerdictFail {
				reason = "verify_failed"
			}
			return ClearBrokenResult{
				OK:      false,
				Ledger:  ledger,
				Reason:  reason,
				Detail:  verdict.Detail,
				Version: version,
			}
		}
		detail = verdict.Detail
		verified = true
	}

	caps := ResolveChannelCapabilities(record.Channel, provider)
	blocked := make([]string, 0, len(record.BlockedVersions))
	for _, b := range record.BlockedVersions {
		if b != version {
			blocked = append(blocked, b)
		}
	}
	historyDetail := "manual_clear:skipped"
	if verified {
		if detail == "" {
			historyDetail = "manual_clear:verified"
		} else {
			historyDetail = "manual_clear:" + detail
		}
	}
	healthy := true
	patched := record
	patched.State = StateHealthy
	patched.Enabled = true
	patched.DisabledReason = ""
	patched.BlockedVersions = blocked
	patched.InstalledVersion = version
	patched.KnownGoodVersion = version
	patched.KnownGoodRollbackable = caps.Pinnable
	patched.BaselineHealthy = &healthy
	patched.TargetVersion = ""
	patched.LastApplyError = ""
	patched.ConsecutiveFailures = 0
	patched.ConsecutiveDefers = 0
	patched.ConsecutiveQuiescentTicks = 0
	patched.LastDeferReason = ""
	patched.History = AppendHistory(record, map[string]any{
		"at":      nowMs,
		"from":    record.InstalledVersion,
		"to":      version,
		"outcome": "cleared",
		"detail":  historyDetail,
	})

	return ClearBrokenResult{
		OK:       true,
		Ledger:   ledger.WithProvider(provider, patched),
		Reason:   "cleared",
		Detail:   detail,
		Version:  version,
		Verified: verified,
	}
}
