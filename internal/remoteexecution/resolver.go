package remoteexecution

import "strings"

// Resolver applies the same deterministic selection rules for every caller.
type Resolver struct{}

func (Resolver) Resolve(facts Facts, rawSelector TargetSelector) (Resolution, error) {
	selector := NormalizeSelector(rawSelector)
	if err := validateFacts(facts); err != nil {
		return Resolution{}, err
	}
	if selector.ServerID != "" && selector.ServerID != facts.ServerID {
		return Resolution{}, &ResolutionError{Code: "target_server_not_found", Field: "serverId", Value: selector.ServerID, Detail: "selected server identity does not match this AIH Server"}
	}

	workspace, err := selectWorkspace(facts.Workspaces, selector)
	if err != nil {
		return Resolution{}, err
	}
	runner, err := selectRunner(facts.Runners, selector)
	if err != nil {
		return Resolution{}, err
	}
	provider := selector.Provider
	if provider == "" {
		provider = strings.ToLower(strings.TrimSpace(runner.Provider))
	}
	if provider == "" {
		return Resolution{}, &ResolutionError{Code: "target_incomplete", Field: "provider", Detail: "provider must be selected or declared by the harness"}
	}

	account, err := selectAccount(facts.Accounts, facts.Models, selector, provider)
	if err != nil {
		return Resolution{}, err
	}
	model, err := selectModel(facts.Models, selector, provider, account.AccountRef)
	if err != nil {
		return Resolution{}, err
	}
	if model.Provider != provider || model.AccountRef != account.AccountRef {
		return Resolution{}, &ResolutionError{Code: "target_incomplete", Field: "model", Detail: "model does not belong to the selected provider and account"}
	}

	transport := strings.TrimSpace(workspace.Transport)
	if transport == "" {
		transport = TransportSSH
	}
	target := ExecutionTarget{
		ServerProfileID: selector.ServerProfileID,
		ServerID:        facts.ServerID,
		WorkspaceID:     workspace.ID,
		ConnectionID:    workspace.ConnectionID,
		WorkspaceRoot:   workspace.RemoteRoot,
		RootLabel:       workspace.RootLabel,
		Harness:         runner.ID,
		Provider:        provider,
		AccountRef:      account.AccountRef,
		CatalogModelID:  model.CatalogModelID,
		CLIModelName:    model.CLIModelName,
		Transport:       transport,
	}
	target.ID = BuildTargetID(target)
	return Resolution{Target: target, Preflight: BuildPreflight(facts, target, workspace, runner, account, model)}, nil
}

func validateFacts(facts Facts) error {
	if strings.TrimSpace(facts.ServerID) == "" {
		return &ResolutionError{Code: "server_identity_unavailable", Field: "serverId", Detail: "server identity is missing"}
	}
	for _, workspace := range facts.Workspaces {
		if strings.TrimSpace(workspace.ID) == "" {
			return &ResolutionError{Code: "invalid_workspace_fact", Detail: "workspace id is required"}
		}
		if strings.TrimSpace(workspace.RemoteRoot) == "" && strings.TrimSpace(workspace.RootLabel) == "" {
			return &ResolutionError{Code: "invalid_workspace_fact", Detail: "workspace needs a remote root or a connector root label"}
		}
	}
	return nil
}

func selectWorkspace(workspaces []WorkspaceFact, selector TargetSelector) (WorkspaceFact, error) {
	matches := make([]WorkspaceFact, 0, len(workspaces))
	for _, workspace := range workspaces {
		if selector.WorkspaceID != "" && workspace.ID != selector.WorkspaceID {
			continue
		}
		if selector.ConnectionID != "" && workspace.ConnectionID != selector.ConnectionID {
			continue
		}
		matches = append(matches, workspace)
	}
	return chooseOneWorkspace(matches, selector.WorkspaceID != "" || selector.ConnectionID != "")
}

func chooseOneWorkspace(matches []WorkspaceFact, explicit bool) (WorkspaceFact, error) {
	switch len(matches) {
	case 0:
		code := "target_workspace_required"
		if explicit {
			code = "target_workspace_not_found"
		}
		return WorkspaceFact{}, &ResolutionError{Code: code, Field: "workspaceId"}
	case 1:
		return matches[0], nil
	default:
		return WorkspaceFact{}, &ResolutionError{Code: "target_ambiguous", Field: "workspaceId", Detail: "more than one workspace matches; select workspaceId explicitly"}
	}
}

func selectRunner(runners []RunnerFact, selector TargetSelector) (RunnerFact, error) {
	matches := make([]RunnerFact, 0, len(runners))
	for _, runner := range runners {
		if selector.Harness != "" && strings.ToLower(runner.ID) != selector.Harness {
			continue
		}
		if selector.Provider != "" && strings.ToLower(runner.Provider) != selector.Provider {
			continue
		}
		matches = append(matches, runner)
	}
	if len(matches) == 0 {
		return RunnerFact{}, &ResolutionError{Code: "target_runner_not_found", Field: "harness", Value: selector.Harness}
	}
	if len(matches) > 1 {
		return RunnerFact{}, &ResolutionError{Code: "target_ambiguous", Field: "harness", Detail: "more than one runner matches; select harness explicitly"}
	}
	return matches[0], nil
}

func selectAccount(accounts []AccountFact, models []ModelFact, selector TargetSelector, provider string) (AccountFact, error) {
	matches := make([]AccountFact, 0, len(accounts))
	for _, account := range accounts {
		if account.Provider != provider {
			continue
		}
		if selector.AccountRef != "" && account.AccountRef != selector.AccountRef {
			continue
		}
		if selector.Model != "" && !hasModel(models, provider, account.AccountRef, selector.Model) {
			continue
		}
		matches = append(matches, account)
	}
	if len(matches) == 0 {
		code := "target_account_required"
		if selector.AccountRef != "" {
			code = "target_account_not_found"
		}
		return AccountFact{}, &ResolutionError{Code: code, Field: "accountRef", Value: selector.AccountRef}
	}
	if len(matches) > 1 {
		return AccountFact{}, &ResolutionError{Code: "target_ambiguous", Field: "accountRef", Detail: "more than one account matches; select accountRef explicitly"}
	}
	return matches[0], nil
}

func selectModel(models []ModelFact, selector TargetSelector, provider, accountRef string) (ModelFact, error) {
	matches := make([]ModelFact, 0, len(models))
	for _, model := range models {
		if model.Provider != provider || model.AccountRef != accountRef || !model.Effective {
			continue
		}
		if selector.Model != "" && model.CatalogModelID != selector.Model && model.CLIModelName != selector.Model {
			continue
		}
		matches = append(matches, model)
	}
	if len(matches) == 0 {
		code := "target_model_required"
		if selector.Model != "" {
			code = "target_model_not_found"
		}
		return ModelFact{}, &ResolutionError{Code: code, Field: "model", Value: selector.Model}
	}
	if len(matches) > 1 {
		return ModelFact{}, &ResolutionError{Code: "target_ambiguous", Field: "model", Detail: "more than one model matches; select model explicitly"}
	}
	return matches[0], nil
}

func hasModel(models []ModelFact, provider, accountRef, model string) bool {
	for _, candidate := range models {
		if candidate.Provider == provider && candidate.AccountRef == accountRef && candidate.Effective &&
			(candidate.CatalogModelID == model || candidate.CLIModelName == model) {
			return true
		}
	}
	return false
}

// Candidates returns safe, non-executable candidates for UI display. It only
// emits combinations backed by actual account/model facts.
func (Resolver) Candidates(facts Facts) []TargetCandidate {
	if validateFacts(facts) != nil {
		return []TargetCandidate{}
	}
	result := make([]TargetCandidate, 0)
	for _, workspace := range facts.Workspaces {
		for _, runner := range facts.Runners {
			for _, model := range facts.Models {
				if !model.Effective || model.Provider != runner.Provider {
					continue
				}
				for _, account := range facts.Accounts {
					if account.AccountRef != model.AccountRef || account.Provider != model.Provider {
						continue
					}
					transport := strings.TrimSpace(workspace.Transport)
					if transport == "" {
						transport = TransportSSH
					}
					target := ExecutionTarget{
						ServerID: facts.ServerID, WorkspaceID: workspace.ID, ConnectionID: workspace.ConnectionID,
						WorkspaceRoot: workspace.RemoteRoot, RootLabel: workspace.RootLabel,
						Harness: runner.ID, Provider: model.Provider,
						AccountRef: model.AccountRef, CatalogModelID: model.CatalogModelID,
						CLIModelName: model.CLIModelName, Transport: transport,
					}
					target.ID = BuildTargetID(target)
					result = append(result, TargetCandidate{
						ID: target.ID, ServerID: facts.ServerID, Workspace: workspace, Runner: runner,
						Account: account, Model: model,
						Preflight: BuildPreflight(facts, target, workspace, runner, account, model),
					})
				}
			}
		}
	}
	return result
}
