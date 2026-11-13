package providercliupgrade

import "regexp"

const (
	CategoryLockBusy    = "lock_busy"
	CategoryNetwork     = "network"
	CategoryNotFound    = "not_found"
	CategoryHardFailure = "hard_failure"
)

var (
	lockBusyRe = regexp.MustCompile(`(?i)\bEPERM\b|\bEBUSY\b|\bETXTBSY\b|operation not permitted|being used by another process|resource busy|access is denied`)
	notFoundRe = regexp.MustCompile(`(?i)\bE404\b|No matching version found|is not in this registry|version not found|404 Not Found`)
	networkRe  = regexp.MustCompile(`(?i)\bENOTFOUND\b|\bETIMEDOUT\b|\bECONNREFUSED\b|\bECONNRESET\b|\bEAI_AGAIN\b|\bENETUNREACH\b|network|proxy|tunneling socket|registry\b.*(unreachable|failed)|\b(407|502|503|504)\b`)
)

// PlanResult 表示执行安装或回滚计划的输出。
type PlanResult struct {
	OK     bool
	Error  string
	Stdout string
	Stderr string
}

// InstallFailure 表示归类后的安装失败结果及是否计入熔断计数。
type InstallFailure struct {
	Category            string
	CountsTowardBreaker bool
	Evidence            string
}

// ClassifyInstallFailure 对安装失败归类；仅 hard_failure 计入熔断。
func ClassifyInstallFailure(result PlanResult) InstallFailure {
	combined := result.Error + "\n" + result.Stderr + "\n" + result.Stdout
	evidence := combined
	if len(evidence) > 500 {
		evidence = evidence[:500]
	}
	switch {
	case lockBusyRe.MatchString(combined):
		return InstallFailure{Category: CategoryLockBusy, CountsTowardBreaker: false, Evidence: evidence}
	case notFoundRe.MatchString(combined):
		return InstallFailure{Category: CategoryNotFound, CountsTowardBreaker: false, Evidence: evidence}
	case networkRe.MatchString(combined):
		return InstallFailure{Category: CategoryNetwork, CountsTowardBreaker: false, Evidence: evidence}
	default:
		return InstallFailure{Category: CategoryHardFailure, CountsTowardBreaker: true, Evidence: evidence}
	}
}
