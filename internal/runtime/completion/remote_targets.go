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
	client, err := remoteexecutionapi.New(&httpClientWithTimeout{timeout: remoteCompletionTimeout}, remoteexecutionapi.Config{
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
	return remoteTargetChoices(response.Candidates, request.Field, request.Current)
}

// httpClientWithTimeout keeps completion's short deadline local to this lookup.
type httpClientWithTimeout struct {
	timeout time.Duration
}

func (client *httpClientWithTimeout) Do(request *http.Request) (*http.Response, error) {
	return (&http.Client{Timeout: client.timeout}).Do(request)
}

func selectCompletionProfile(store map[string]any, requested string) map[string]any {
	requested = strings.TrimSpace(requested)
	if requested == "" {
		requested = textValue(store["activeProfileId"])
	}
	profiles, _ := store["profiles"].([]any)
	for _, raw := range profiles {
		profile, ok := raw.(map[string]any)
		if !ok {
			continue
		}
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

func completionProfileChoices(store map[string]any, current string) []remoteTargetChoice {
	profiles, _ := store["profiles"].([]any)
	choices := make([]remoteTargetChoice, 0, len(profiles))
	for _, raw := range profiles {
		profile, ok := raw.(map[string]any)
		if !ok {
			continue
		}
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

func textValue(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}
