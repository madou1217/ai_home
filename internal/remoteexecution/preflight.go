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

func BuildPreflight(facts Facts, target ExecutionTarget, workspace WorkspaceFact, runner RunnerFact, account AccountFact, model ModelFact) PreflightReport {
	stages := []PreflightStage{
		stage(StageServer, facts.ServerID != "", "server_identity_missing", "server identity is unavailable"),
		workspaceStage(target, workspace),
		stage(StageRunner, runner.ID != "", "runner_unavailable", "runner is unavailable"),
		stage(StageProvider, target.Provider != "", "provider_unavailable", "provider is not selected"),
		stage(StageAccount, account.AccountRef != "" && account.Enabled && account.CredentialKnown, "account_unavailable", "account is disabled or credential evidence is missing"),
		stage(StageModel, model.CatalogAvailable && model.Effective, "model_unavailable", "model has no effective catalog evidence"),
		stage(StageTools, runner.SupportsRemoteTools, "remote_tools_unsupported", "runner does not expose a verified remote tool channel"),
	}
	launchAvailable := model.NativeLaunchAvailable
	if target.Transport == TransportConnector && model.ServerCLIAvailable {
		// Connector agent terminals run the provider CLI on the Server host, so
		// an installed binary is real launch evidence for that transport.
		launchAvailable = true
	}
	if !launchAvailable {
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

// workspaceStage separates "the SSH path is recorded" from "the local connector
// is online now". An offline or revoked connector must never pass preflight.
func workspaceStage(target ExecutionTarget, workspace WorkspaceFact) PreflightStage {
	if strings.TrimSpace(target.WorkspaceID) == "" {
		return PreflightStage{Name: StageWorkspace, Status: StatusBlocked, Code: "workspace_unavailable", Detail: "workspace is not selected"}
	}
	switch strings.TrimSpace(target.Transport) {
	case "", TransportSSH:
		if strings.TrimSpace(target.WorkspaceRoot) == "" {
			return PreflightStage{Name: StageWorkspace, Status: StatusBlocked, Code: "workspace_unavailable", Detail: "workspace root is unavailable"}
		}
	case TransportConnector:
		if strings.TrimSpace(target.RootLabel) == "" {
			return PreflightStage{Name: StageWorkspace, Status: StatusBlocked, Code: "workspace_unavailable", Detail: "connector root label is unavailable"}
		}
		switch strings.ToLower(strings.TrimSpace(workspace.State)) {
		case "online":
		case "revoked":
			return PreflightStage{Name: StageWorkspace, Status: StatusBlocked, Code: "workspace_connector_revoked", Detail: "workspace connector enrollment was revoked"}
		default:
			return PreflightStage{Name: StageWorkspace, Status: StatusBlocked, Code: "workspace_connector_offline", Detail: "workspace connector is offline"}
		}
	default:
		return PreflightStage{Name: StageWorkspace, Status: StatusUnsupported, Code: "workspace_transport_unsupported", Detail: "workspace transport is not supported"}
	}
	return PreflightStage{Name: StageWorkspace, Status: StatusOK}
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
