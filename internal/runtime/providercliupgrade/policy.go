package providercliupgrade

import "strings"

const (
	// DefaultSoakMs 是新版本发布后的静置观察窗口（5 分钟）。
	DefaultSoakMs = int64(5 * 60 * 1000)
	// DefaultSoakUnknownLimit 是连续拿不到发布时间后升级为 soak_unknown 告警的次数阈值。
	DefaultSoakUnknownLimit = int64(5)

	DecisionUpgrade    = "upgrade"
	DecisionSkip       = "skip"
	DecisionIneligible = "ineligible"
)

// PolicyConfig 控制版本升级策略。
type PolicyConfig struct {
	SoakMs           int64
	SoakUnknownLimit int64
}

// NormalizePolicyConfig 归一化策略阈值。
func NormalizePolicyConfig(cfg PolicyConfig) PolicyConfig {
	soakMs := cfg.SoakMs
	if soakMs < 0 {
		soakMs = DefaultSoakMs
	}
	unknownLimit := cfg.SoakUnknownLimit
	if unknownLimit < 1 {
		unknownLimit = DefaultSoakUnknownLimit
	}
	return PolicyConfig{
		SoakMs:           soakMs,
		SoakUnknownLimit: unknownLimit,
	}
}

// PolicyInput 汇总升级决策所需的全部版本和开关事实。
type PolicyInput struct {
	Now                   int64
	Enabled               bool
	Pinnable              bool
	UserPin               string
	BaselineHealthy       *bool
	KnownGoodRollbackable bool
	InstalledVersion      string
	LatestVersion         string
	PublishedAt           int64
	Releases              []ReleaseTime
	BlockedVersions       []string
	SoakUnknownCount      int64
}

// PolicyDecision 描述决策结论、目标版本及原因。
type PolicyDecision struct {
	Decision        string
	TargetVersion   string
	Reason          string
	SoakRemainingMs int64
}

// Decide 执行纯函数升级决策（与 Node upgrade-policy.js 完全同口径）。
func Decide(input PolicyInput, rawCfg PolicyConfig) PolicyDecision {
	cfg := NormalizePolicyConfig(rawCfg)
	now := input.Now
	installed := strings.TrimSpace(input.InstalledVersion)
	latest := strings.TrimSpace(input.LatestVersion)

	skip := func(reason string) PolicyDecision {
		return PolicyDecision{Decision: DecisionSkip, Reason: reason}
	}
	ineligible := func(reason string) PolicyDecision {
		return PolicyDecision{Decision: DecisionIneligible, Reason: reason}
	}

	if strings.TrimSpace(input.UserPin) != "" {
		return ineligible("user_pinned")
	}
	if !input.Enabled {
		return ineligible("disabled")
	}
	if !input.Pinnable {
		return ineligible("channel_not_pinnable")
	}
	if installed == "" {
		return skip("installed_version_unknown")
	}
	if latest == "" {
		return skip("latest_version_unknown")
	}
	if input.BaselineHealthy != nil && !*input.BaselineHealthy {
		return skip("baseline_unhealthy")
	}
	if !input.KnownGoodRollbackable {
		return skip("known_good_not_rollbackable")
	}
	if containsString(input.BlockedVersions, latest) {
		return skip("version_blocked")
	}

	parsedLatest, ok := ParseVersion(latest)
	if !ok {
		return skip("latest_version_unparsable")
	}
	if len(parsedLatest.Prerelease) > 0 {
		return skip("latest_is_prerelease")
	}

	cmp, ok := CompareVersions(latest, installed)
	if !ok {
		return skip("version_compare_failed")
	}
	if cmp <= 0 {
		return skip("up_to_date")
	}

	soakedRelease, hasSoaked := pickSoakedRelease(input.Releases, now, cfg.SoakMs, installed, input.BlockedVersions)

	publishedAt := input.PublishedAt
	if publishedAt <= 0 && hasSoaked {
		return PolicyDecision{
			Decision:      DecisionUpgrade,
			TargetVersion: soakedRelease.Version,
			Reason:        "upgrade_soaked_release",
		}
	}
	if publishedAt <= 0 {
		reason := "soak_pending_unknown_publish_time"
		if input.SoakUnknownCount >= cfg.SoakUnknownLimit {
			reason = "soak_unknown"
		}
		return PolicyDecision{
			Decision:      DecisionSkip,
			TargetVersion: latest,
			Reason:        reason,
		}
	}

	soakedFor := now - publishedAt
	if soakedFor < cfg.SoakMs {
		if hasSoaked {
			return PolicyDecision{
				Decision:      DecisionUpgrade,
				TargetVersion: soakedRelease.Version,
				Reason:        "upgrade_soaked_release",
			}
		}
		rem := cfg.SoakMs - soakedFor
		if rem < 0 {
			rem = 0
		}
		return PolicyDecision{
			Decision:        DecisionSkip,
			TargetVersion:   latest,
			Reason:          "soaking",
			SoakRemainingMs: rem,
		}
	}

	return PolicyDecision{
		Decision:      DecisionUpgrade,
		TargetVersion: latest,
		Reason:        "upgrade_available",
	}
}

func pickSoakedRelease(releases []ReleaseTime, now int64, soakMs int64, installedVersion string, blocked []string) (ReleaseTime, bool) {
	if now <= 0 || len(releases) == 0 {
		return ReleaseTime{}, false
	}
	var best ReleaseTime
	hasBest := false
	for _, rel := range releases {
		ver := strings.TrimSpace(rel.Version)
		if ver == "" || rel.PublishedAt <= 0 {
			continue
		}
		parsed, ok := ParseVersion(ver)
		if !ok || len(parsed.Prerelease) > 0 {
			continue
		}
		if now-rel.PublishedAt < soakMs || containsString(blocked, ver) {
			continue
		}
		newer, ok := CompareVersions(ver, installedVersion)
		if !ok || newer <= 0 {
			continue
		}
		if !hasBest {
			best = ReleaseTime{Version: ver, PublishedAt: rel.PublishedAt}
			hasBest = true
			continue
		}
		if cmp, ok := CompareVersions(ver, best.Version); ok && cmp > 0 {
			best = ReleaseTime{Version: ver, PublishedAt: rel.PublishedAt}
		}
	}
	return best, hasBest
}

func containsString(items []string, target string) bool {
	for _, item := range items {
		if item == target {
			return true
		}
	}
	return false
}
