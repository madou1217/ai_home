package completion

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/remoteexecutionapi"
	"github.com/madou1217/ai_home/internal/remoteexecution"
	"github.com/madou1217/ai_home/internal/transport/http/webuicontrolplaneapi"
)

const remoteCompletionTimeout = 2 * time.Second

// listRemoteTargetCandidates is deliberately fail-closed. A remote catalog
// outage yields no candidates; it never substitutes local model/account facts.
func listRemoteTargetCandidates(aiHome string, request remoteTargetRequest) []remoteTargetChoice {
	store, err := webuicontrolplaneapi.ListProfiles(context.Background(), aiHome)
	if err != nil {
		return nil
	}
	if request.Action == "profiles" {
		return completionProfileChoices(store, request.Current)
	}
	profile := selectCompletionProfile(store, request.Server)
	if profile == nil {
		return nil
	}
	client, err := remoteexecutionapi.New(&http.Client{Timeout: remoteCompletionTimeout}, remoteexecutionapi.Config{
		BaseURL:       textValue(profile["endpoint"]),
		ManagementKey: textValue(profile["managementKey"]),
	})
	if err != nil {
		return nil
	}
	selector := remoteexecution.TargetSelector{
		ServerProfileID: textValue(profile["id"]),
		ServerID:        request.ServerID,
		WorkspaceID:     request.Workspace,
		ConnectionID:    request.Connection,
		Harness:         request.Harness,
		Provider:        request.Provider,
		AccountRef:      request.Account,
		Model:           request.Model,
	}
	ctx, cancel := context.WithTimeout(context.Background(), remoteCompletionTimeout)
	defer cancel()
	response, err := client.List(ctx, selector)
	if err != nil {
		return nil
	}
	choices := remoteTargetChoices(response.Candidates, request.Field, request.Current)
	choices = appendRemoteTargetChoices(choices, remoteInventoryChoices(response.Inventory, request.Field, request.Current))
	if request.Field == "server-id" {
		choices = appendRemoteTargetChoices(choices, []remoteTargetChoice{{
			Value: response.ServerID, Description: "远端 AIH Server", Group: "远程 Server",
		}})
	}
	return choices
}

func selectCompletionProfile(store map[string]any, requested string) map[string]any {
	requested = strings.TrimSpace(requested)
	if requested == "" {
		requested = textValue(store["activeProfileId"])
	}
	for _, profile := range completionProfiles(store) {
		if textValue(profile["id"]) == requested || textValue(profile["name"]) == requested || strings.TrimRight(textValue(profile["endpoint"]), "/") == strings.TrimRight(requested, "/") {
			return profile
		}
	}
	return nil
}

func remoteTargetChoices(candidates []remoteexecution.TargetCandidate, field, current string) []remoteTargetChoice {
	choices := make([]remoteTargetChoice, 0, len(candidates))
	seen := map[string]struct{}{}
	add := func(value, description, group string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		if _, ok := seen[value]; ok {
			return
		}
		if !matchesPrefix(value, current) && !matchesContains(description, current) {
			return
		}
		seen[value] = struct{}{}
		choices = append(choices, remoteTargetChoice{Value: value, Description: description, Group: group})
	}
	for _, candidate := range candidates {
		switch field {
		case "workspace":
			add(candidate.Workspace.ID, candidate.Workspace.Label, "远程 Workspace")
		case "server-id":
			add(candidate.ServerID, "远端 AIH Server", "远程 Server")
		case "connection":
			add(candidate.Workspace.ConnectionID, candidate.Workspace.ConnectionLabel, "远程 SSH Connection")
		case "harness":
			add(candidate.Runner.ID, "远程 Harness", "远程 Harness")
		case "provider":
			add(candidate.Model.Provider, "远程 Provider", "远程 Provider")
		case "account":
			add(candidate.Account.AccountRef, "远程 Account", "远程 Account")
		case "model":
			add(candidate.Model.CatalogModelID, "远程 Catalog Model", "远程 Model")
			add(candidate.Model.CLIModelName, "远程 CLI Model", "远程 Model")
		default:
			add(candidate.ID, candidate.Workspace.Label, "远程 Target")
		}
	}
	return choices
}

func appendRemoteTargetChoices(existing, additions []remoteTargetChoice) []remoteTargetChoice {
	seen := make(map[string]struct{}, len(existing)+len(additions))
	for _, choice := range existing {
		seen[choice.Value] = struct{}{}
	}
	for _, choice := range additions {
		if strings.TrimSpace(choice.Value) == "" {
			continue
		}
		if _, found := seen[choice.Value]; found {
			continue
		}
		seen[choice.Value] = struct{}{}
		existing = append(existing, choice)
	}
	return existing
}

func remoteInventoryChoices(inventory remoteexecutionapi.InventorySummary, field, current string) []remoteTargetChoice {
	choices := make([]remoteTargetChoice, 0)
	add := func(value, description, group string) {
		value = strings.TrimSpace(value)
		if value == "" || (!matchesPrefix(value, current) && !matchesContains(description, current)) {
			return
		}
		choices = append(choices, remoteTargetChoice{Value: value, Description: description, Group: group})
	}
	switch field {
	case "workspace":
		for _, item := range inventory.Workspaces {
			add(item.ID, item.Label, "远程 Workspace")
		}
	case "connection":
		for _, item := range inventory.Workspaces {
			add(item.ConnectionID, item.ConnectionLabel, "远程 SSH Connection")
		}
	case "harness":
		for _, item := range inventory.Runners {
			add(item.ID, "远程 Harness", "远程 Harness")
		}
	case "provider":
		for _, item := range inventory.Runners {
			add(item.Provider, "远程 Provider", "远程 Provider")
		}
		for _, item := range inventory.Accounts {
			add(item.Provider, "远程 Provider", "远程 Provider")
		}
	case "account":
		for _, item := range inventory.Accounts {
			add(item.AccountRef, "远程 Account", "远程 Account")
		}
	case "model":
		for _, item := range inventory.Models {
			add(item.CatalogModelID, "远程 Catalog Model", "远程 Model")
			add(item.CLIModelName, "远程 CLI Model", "远程 Model")
		}
	}
	return choices
}

func completionProfileChoices(store map[string]any, current string) []remoteTargetChoice {
	profiles := completionProfiles(store)
	choices := make([]remoteTargetChoice, 0, len(profiles))
	for _, profile := range profiles {
		id, name := textValue(profile["id"]), textValue(profile["name"])
		if id == "" {
			continue
		}
		description := name
		if description == "" {
			description = textValue(profile["endpoint"])
		}
		if !matchesPrefix(id, current) && !matchesPrefix(name, current) && !matchesContains(description, current) {
			continue
		}
		choices = append(choices, remoteTargetChoice{Value: id, Description: description, Group: "Server Profile"})
	}
	return choices
}

func completionProfiles(store map[string]any) []map[string]any {
	value := store["profiles"]
	switch profiles := value.(type) {
	case []map[string]any:
		return profiles
	case []any:
		result := make([]map[string]any, 0, len(profiles))
		for _, raw := range profiles {
			if profile, ok := raw.(map[string]any); ok {
				result = append(result, profile)
			}
		}
		return result
	default:
		return nil
	}
}

func textValue(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}
