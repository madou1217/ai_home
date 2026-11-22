package remoteexecution

import "strings"

// PreflightStage is a single observable readiness check.
type PreflightStage struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Code   string `json:"code,omitempty"`
	Detail string `json:"detail,omitempty"`
}

// PreflightReport never hides an unsupported capability behind an overall
// success. Ready is true only when every required stage is OK.
type PreflightReport struct {
	Ready  bool             `json:"ready"`
	Stages []PreflightStage `json:"stages"`
}

func BuildPreflight(facts Facts, target ExecutionTarget, runner RunnerFact, account AccountFact, model ModelFact) PreflightReport {
	stages := []PreflightStage{
		stage(StageServer, facts.ServerID != "", "server_identity_missing", "server identity is unavailable"),
		stage(StageWorkspace, target.WorkspaceID != "" && target.WorkspaceRoot != "", "workspace_unavailable", "workspace root is unavailable"),
		stage(StageRunner, runner.ID != "", "runner_unavailable", "runner is unavailable"),
		stage(StageProvider, target.Provider != "", "provider_unavailable", "provider is not selected"),
		stage(StageAccount, account.AccountRef != "" && account.Enabled && account.CredentialKnown, "account_unavailable", "account is disabled or credential evidence is missing"),
		stage(StageModel, model.CatalogAvailable && model.Effective, "model_unavailable", "model has no effective catalog evidence"),
		stage(StageTools, runner.SupportsRemoteTools, "remote_tools_unsupported", "runner does not expose a verified remote tool channel"),
	}
	if !model.NativeLaunchAvailable {
		stages = append(stages, PreflightStage{Name: "launch", Status: StatusUnsupported, Code: "native_launch_unavailable", Detail: "native runner launch is not verified"})
	}
	ready := true
	for _, item := range stages {
		if item.Status != StatusOK {
			ready = false
			break
		}
	}
	return PreflightReport{Ready: ready, Stages: stages}
}

func stage(name string, ok bool, code, detail string) PreflightStage {
	if ok {
		return PreflightStage{Name: name, Status: StatusOK}
	}
	return PreflightStage{Name: name, Status: StatusBlocked, Code: code, Detail: detail}
}

func (report PreflightReport) Status() string {
	if report.Ready {
		return StatusOK
	}
	for _, stage := range report.Stages {
		if stage.Status == StatusUnsupported {
			return StatusUnsupported
		}
	}
	return StatusBlocked
}

func (report PreflightReport) FailedStages() []string {
	result := make([]string, 0)
	for _, stage := range report.Stages {
		if stage.Status != StatusOK {
			result = append(result, strings.TrimSpace(stage.Name))
		}
	}
	return result
}
