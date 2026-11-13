package providercliupgrade

import (
	"context"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

const MaxConsecutiveFailures int64 = 2

var windowsDrivePrefixRe = regexp.MustCompile(`(?i)^[a-z]:[\\/]`)

// UpdateCheckResult 描述单次本地+远端版本检查的结果。
type UpdateCheckResult struct {
	InstalledVersion string
	LatestVersion    string
	PublishedAt      int64
	PackageName      string
	Releases         []ReleaseTime
}

// CycleDeps 声明跑一轮单 provider 升级闭环所需的可注入依赖。
type CycleDeps struct {
	Now                   func() int64
	DetectChannel         func(ctx context.Context, provider string) (ChannelDetection, error)
	CheckUpdate           func(ctx context.Context, provider string) (UpdateCheckResult, error)
	CheckQuiescence       func(ctx context.Context, provider string) (QuiescenceStatus, error)
	RunPlans              func(ctx context.Context, plans []InstallPlan, provider string, version string, phase string) PlanResult
	Verify                func(ctx context.Context, provider string, expectedVersion string) (Verification, error)
	ReinstallCodexCLIHook func(ctx context.Context) error
	Log                   func(entry map[string]any)
}

// CycleConfig 控制单轮升级闭环策略。
type CycleConfig struct {
	ApplyEnabled     bool
	GoOS             string
	BaseEnv          map[string]string
	SoakMs           int64
	SoakUnknownLimit int64
}

// CycleOutcome 描述单个 provider 一轮升级闭环的结论与新账本。
type CycleOutcome struct {
	OK            bool
	Ledger        Ledger
	State         string
	Reason        string
	TargetVersion string
	Busy          bool
	Evidence      []string
}

// SameCLIPath 判断两条 CLI 解析路径是否指向同一入口；任一为空返回 nil。
func SameCLIPath(left string, right string) *bool {
	a := strings.TrimSpace(left)
	b := strings.TrimSpace(right)
	if a == "" || b == "" {
		return nil
	}
	var same bool
	if windowsDrivePrefixRe.MatchString(a) || windowsDrivePrefixRe.MatchString(b) {
		same = strings.EqualFold(a, b)
	} else {
		same = a == b
	}
	return &same
}

// RunProviderCycle 执行单个 provider 的「检查 -> 闸门 -> 升级 -> 验证 -> 回滚 -> 记账」闭环。
func RunProviderCycle(
	ctx context.Context,
	provider string,
	ledger Ledger,
	deps CycleDeps,
	cfg CycleConfig,
) CycleOutcome {
	nowMs := currentEpochMs(deps.Now)
	record := ledger.Record(provider)
	goos := strings.TrimSpace(cfg.GoOS)
	if goos == "" {
		goos = runtime.GOOS
	}

	commit := func(next ProviderRecord) Ledger {
		return ledger.WithProvider(provider, next)
	}
	emit := func(entry map[string]any) {
		if deps.Log == nil {
			return
		}
		payload := map[string]any{
			"provider": provider,
			"at":       nowMs,
		}
		for k, v := range entry {
			payload[k] = v
		}
		deps.Log(payload)
	}

	if !ledger.Global.Enabled {
		return CycleOutcome{OK: true, Ledger: ledger, State: record.State, Reason: "global_disabled"}
	}
	if record.State == StateBroken {
		return CycleOutcome{OK: true, Ledger: ledger, State: StateBroken, Reason: "provider_broken"}
	}

	channel, err := deps.DetectChannel(ctx, provider)
	if err != nil {
		patched := record
		patched.LastCheckError = err.Error()
		return CycleOutcome{OK: true, Ledger: commit(patched), State: record.State, Reason: "channel_detect_failed"}
	}

	if strings.TrimSpace(channel.ResolvedPath) == "" {
		patched := record
		patched.LastCheckAt = nowMs
		patched.LastCheckError = ""
		patched.Channel = channel.Channel
		patched.OwnerPath = channel.OwnerPath
		patched.ResolvedPath = ""
		patched.ShadowedNpmInstall = channel.ShadowedNpmInstall
		patched.InstalledVersion = ""
		return CycleOutcome{OK: true, Ledger: commit(patched), State: record.State, Reason: "not_installed"}
	}

	update, err := deps.CheckUpdate(ctx, provider)
	if err != nil {
		patched := record
		patched.LastCheckAt = nowMs
		patched.LastCheckError = err.Error()
		return CycleOutcome{OK: true, Ledger: commit(patched), State: record.State, Reason: "check_failed"}
	}

	installedVersion := update.InstalledVersion
	applyBase := func(dst *ProviderRecord) {
		dst.LastCheckAt = nowMs
		dst.LastCheckError = ""
		dst.Channel = channel.Channel
		dst.OwnerPath = channel.OwnerPath
		dst.ResolvedPath = channel.ResolvedPath
		dst.ShadowedNpmInstall = channel.ShadowedNpmInstall
		dst.InstalledVersion = installedVersion
		dst.LatestVersion = update.LatestVersion
	}

	samePtr := SameCLIPath(record.ResolvedPath, channel.ResolvedPath)
	identityChanged := samePtr != nil && !*samePtr
	if identityChanged {
		emit(map[string]any{
			"event": "cli_identity_changed",
			"from":  record.ResolvedPath,
			"to":    channel.ResolvedPath,
		})
	}

	var baselineHealthy *bool
	if !identityChanged && record.BaselineHealthy != nil {
		v := *record.BaselineHealthy
		baselineHealthy = &v
	}
	knownGoodVersion := ""
	if !identityChanged {
		knownGoodVersion = NormalizeVersionText(record.KnownGoodVersion)
	}
	var knownGoodRollbackable bool
	if knownGoodVersion != "" {
		knownGoodRollbackable = channel.Pinnable
	} else if !identityChanged {
		knownGoodRollbackable = record.KnownGoodRollbackable
	}

	if knownGoodVersion == "" && installedVersion != "" {
		baseline, verifyErr := verifySafely(ctx, deps.Verify, provider, installedVersion)
		if verifyErr != nil {
			baseline = Verification{Verdict: VerdictInconclusive, Detail: verifyErr.Error()}
		}
		healthy := baseline.Verdict != VerdictFail
		baselineHealthy = &healthy
		if healthy {
			knownGoodVersion = installedVersion
			knownGoodRollbackable = channel.Pinnable
		} else {
			emit(map[string]any{"event": "baseline_unhealthy", "detail": baseline.Detail})
			patched := record
			applyBase(&patched)
			f := false
			patched.BaselineHealthy = &f
			patched.State = StateBaselineUnhealthy
			return CycleOutcome{
				OK:     true,
				Ledger: commit(patched),
				State:  StateBaselineUnhealthy,
				Reason: "baseline_unhealthy",
			}
		}
	}

	decision := Decide(PolicyInput{
		Now:                   nowMs,
		Enabled:               record.Enabled,
		Pinnable:              channel.Pinnable,
		UserPin:               record.UserPin,
		BaselineHealthy:       baselineHealthy,
		KnownGoodRollbackable: knownGoodRollbackable,
		InstalledVersion:      installedVersion,
		LatestVersion:         update.LatestVersion,
		PublishedAt:           update.PublishedAt,
		Releases:              update.Releases,
		BlockedVersions:       record.BlockedVersions,
		SoakUnknownCount:      record.SoakUnknownCount,
	}, PolicyConfig{
		SoakMs:           cfg.SoakMs,
		SoakUnknownLimit: cfg.SoakUnknownLimit,
	})

	applyCarry := func(dst *ProviderRecord) {
		applyBase(dst)
		dst.BaselineHealthy = baselineHealthy
		dst.KnownGoodVersion = knownGoodVersion
		dst.KnownGoodRollbackable = knownGoodRollbackable
	}

	if decision.Decision != DecisionUpgrade {
		patched := record
		applyCarry(&patched)
		patched.State = StateHealthy
		patched.TargetVersion = decision.TargetVersion
		if decision.Reason == "soak_pending_unknown_publish_time" {
			patched.SoakUnknownCount = record.SoakUnknownCount + 1
		}
		return CycleOutcome{
			OK:     true,
			Ledger: commit(patched),
			State:  StateHealthy,
			Reason: decision.Reason,
		}
	}

	gated := RequiresQuiescence(channel.Channel, goos, provider)
	var quiescence QuiescenceStatus
	if gated && deps.CheckQuiescence != nil {
		q, qErr := deps.CheckQuiescence(ctx, provider)
		if qErr != nil {
			q = QuiescenceStatus{Busy: true, Evidence: []string{"quiescence_check_error"}, ObservedAt: nowMs}
		}
		quiescence = q
	} else {
		quiescence = QuiescenceStatus{Busy: false, Evidence: []string{"side_by_side_install"}, ObservedAt: nowMs}
	}

	if !cfg.ApplyEnabled {
		patched := record
		applyCarry(&patched)
		patched.State = StateHealthy
		patched.TargetVersion = decision.TargetVersion
		patched.ConsecutiveQuiescentTicks = 0
		if quiescence.Busy {
			patched.LastDeferReason = "busy"
		} else {
			patched.LastDeferReason = "apply_disabled"
		}
		return CycleOutcome{
			OK:            true,
			Ledger:        commit(patched),
			State:         StateHealthy,
			Reason:        "apply_disabled",
			TargetVersion: decision.TargetVersion,
			Busy:          quiescence.Busy,
			Evidence:      quiescence.Evidence,
		}
	}

	quiescentTicks := int64(0)
	if !quiescence.Busy {
		quiescentTicks = record.ConsecutiveQuiescentTicks + 1
	}
	if gated && (quiescence.Busy || !IsQuiescentEnough(quiescentTicks)) {
		reason := "awaiting_quiescence"
		deferReason := "awaiting_quiescence"
		if quiescence.Busy {
			reason = "deferred_busy"
			deferReason = "busy"
		}
		patched := record
		applyCarry(&patched)
		patched.State = StateDeferred
		patched.TargetVersion = decision.TargetVersion
		patched.ConsecutiveQuiescentTicks = quiescentTicks
		patched.ConsecutiveDefers = record.ConsecutiveDefers + 1
		patched.LastDeferReason = deferReason
		return CycleOutcome{
			OK:       true,
			Ledger:   commit(patched),
			State:    StateDeferred,
			Reason:   reason,
			Evidence: quiescence.Evidence,
		}
	}

	target := decision.TargetVersion
	pkgName := strings.TrimSpace(channel.PackageName)
	if pkgName == "" {
		pkgName = strings.TrimSpace(update.PackageName)
	}
	installDir := strings.TrimSpace(channel.InstallDir)
	if installDir == "" && channel.ResolvedPath != "" {
		installDir = filepath.Dir(channel.ResolvedPath)
	}

	plans, planErrReason := BuildPinnedPlans(PlanBuildInput{
		Channel:     channel.Channel,
		PackageName: pkgName,
		Version:     target,
		GoOS:        goos,
		InstallDir:  installDir,
		Provider:    provider,
		CLIPath:     channel.ResolvedPath,
		BaseEnv:     cfg.BaseEnv,
	})
	if planErrReason != "" {
		patched := record
		applyCarry(&patched)
		patched.State = StateHealthy
		patched.LastApplyError = planErrReason
		return CycleOutcome{OK: true, Ledger: commit(patched), State: StateHealthy, Reason: planErrReason}
	}

	emit(map[string]any{"event": "apply_start", "from": installedVersion, "to": target})
	applied := deps.RunPlans(ctx, plans, provider, target, "upgrade")
	if !applied.OK {
		failure := ClassifyInstallFailure(applied)
		failures := record.ConsecutiveFailures
		nextState := StateDeferred
		if failure.CountsTowardBreaker {
			failures = record.ConsecutiveFailures + 1
			nextState = StateHealthy
		}
		blocked := append([]string(nil), record.BlockedVersions...)
		if failure.Category == CategoryNotFound && !containsString(blocked, target) {
			blocked = append(blocked, target)
		}
		emit(map[string]any{"event": "apply_failed", "to": target, "category": failure.Category})
		patched := record
		applyCarry(&patched)
		patched.State = nextState
		patched.TargetVersion = target
		patched.LastApplyAt = nowMs
		patched.LastApplyError = failure.Category
		patched.BlockedVersions = blocked
		patched.ConsecutiveFailures = failures
		patched.ConsecutiveQuiescentTicks = 0
		return CycleOutcome{
			OK:     true,
			Ledger: commit(patched),
			State:  nextState,
			Reason: "apply_failed_" + failure.Category,
		}
	}

	postRes := RunPostInstallActions(ctx, CollectPostInstallActions(plans), deps.ReinstallCodexCLIHook)
	var verdict Verification
	if !postRes.OK {
		verdict = Verification{Verdict: VerdictFail, Detail: "post_install_failed:" + postRes.FailedAction}
	} else {
		v, vErr := verifySafely(ctx, deps.Verify, provider, target)
		if vErr != nil {
			verdict = Verification{Verdict: VerdictInconclusive, Detail: vErr.Error()}
		} else {
			verdict = v
		}
	}

	if verdict.Verdict != VerdictFail {
		advanced := verdict.Verdict == VerdictPass
		emit(map[string]any{"event": "apply_verified", "to": target, "verdict": verdict.Verdict})
		patched := record
		applyCarry(&patched)
		patched.State = StateHealthy
		patched.InstalledVersion = target
		patched.TargetVersion = ""
		if advanced {
			patched.KnownGoodVersion = target
			patched.KnownGoodRollbackable = channel.Pinnable
		}
		patched.LastApplyAt = nowMs
		patched.LastApplyError = ""
		patched.ConsecutiveFailures = 0
		patched.ConsecutiveQuiescentTicks = 0
		patched.History = AppendHistory(record, map[string]any{
			"at":      nowMs,
			"from":    installedVersion,
			"to":      target,
			"outcome": verdict.Verdict,
		})
		return CycleOutcome{
			OK:     true,
			Ledger: commit(patched),
			State:  StateHealthy,
			Reason: "verified_" + verdict.Verdict,
		}
	}

	emit(map[string]any{"event": "verify_failed", "to": target, "detail": verdict.Detail})
	blockedVersions := append([]string(nil), record.BlockedVersions...)
	if !containsString(blockedVersions, target) {
		blockedVersions = append(blockedVersions, target)
	}

	markBroken := func(reason string, detail string) CycleOutcome {
		emit(map[string]any{"event": "broken", "to": target, "reason": reason, "detail": detail})
		patched := record
		applyCarry(&patched)
		patched.State = StateBroken
		patched.Enabled = false
		patched.DisabledReason = reason
		patched.TargetVersion = target
		patched.InstalledVersion = target
		patched.BlockedVersions = blockedVersions
		patched.LastApplyAt = nowMs
		patched.LastApplyError = reason
		patched.ConsecutiveFailures = record.ConsecutiveFailures + 1
		patched.History = AppendHistory(record, map[string]any{
			"at":      nowMs,
			"from":    installedVersion,
			"to":      target,
			"outcome": "broken",
			"detail":  reason,
		})
		return CycleOutcome{
			OK:     true,
			Ledger: commit(patched),
			State:  StateBroken,
			Reason: reason,
		}
	}

	rollbackPlans, rbPlanErr := BuildPinnedPlans(PlanBuildInput{
		Channel:     channel.Channel,
		PackageName: pkgName,
		Version:     knownGoodVersion,
		GoOS:        goos,
		InstallDir:  installDir,
		Provider:    provider,
		CLIPath:     channel.ResolvedPath,
		BaseEnv:     cfg.BaseEnv,
	})
	if rbPlanErr != "" {
		return markBroken("rollback_plan_unavailable", rbPlanErr)
	}

	rolled := deps.RunPlans(ctx, rollbackPlans, provider, knownGoodVersion, "rollback")
	if !rolled.OK {
		return markBroken("rollback_install_failed", ClassifyInstallFailure(rolled).Category)
	}

	rolledPost := RunPostInstallActions(ctx, CollectPostInstallActions(rollbackPlans), deps.ReinstallCodexCLIHook)
	if !rolledPost.OK {
		return markBroken("rollback_post_install_failed", rolledPost.FailedAction)
	}

	rolledVerdict, rvErr := verifySafely(ctx, deps.Verify, provider, knownGoodVersion)
	if rvErr != nil {
		rolledVerdict = Verification{Verdict: VerdictInconclusive, Detail: rvErr.Error()}
	}
	if rolledVerdict.Verdict == VerdictFail {
		return markBroken("rollback_verify_failed", rolledVerdict.Detail)
	}

	emit(map[string]any{"event": "rolled_back", "from": target, "to": knownGoodVersion})
	patched := record
	applyCarry(&patched)
	patched.State = StateRolledBack
	patched.InstalledVersion = knownGoodVersion
	patched.TargetVersion = ""
	patched.BlockedVersions = blockedVersions
	patched.LastApplyAt = nowMs
	patched.LastApplyError = "verify_failed"
	patched.ConsecutiveFailures = record.ConsecutiveFailures + 1
	patched.ConsecutiveQuiescentTicks = 0
	patched.History = AppendHistory(record, map[string]any{
		"at":      nowMs,
		"from":    installedVersion,
		"to":      target,
		"outcome": "rolled_back",
		"detail":  verdict.Detail,
	})
	return CycleOutcome{
		OK:     true,
		Ledger: commit(patched),
		State:  StateRolledBack,
		Reason: "rolled_back",
	}
}

func verifySafely(
	ctx context.Context,
	verifyFn func(ctx context.Context, provider string, expectedVersion string) (Verification, error),
	provider string,
	expectedVersion string,
) (Verification, error) {
	if verifyFn == nil {
		return Verification{Verdict: VerdictInconclusive, Detail: "verifier_unavailable"}, nil
	}
	return verifyFn(ctx, provider, expectedVersion)
}
