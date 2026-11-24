package completion

import (
	"context"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/workspaceconnectorapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuicontrolplaneapi"
)

type workspaceRequest struct {
	Action  string
	Server  string
	Field   string
	Current string
}

// listWorkspaceCandidates is fail-closed: a missing Server profile or an
// unreachable management API yields no candidates and never local guesses.
func listWorkspaceCandidates(aiHome string, request workspaceRequest) []remoteTargetChoice {
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
	client, err := workspaceconnectorapi.New(&http.Client{Timeout: remoteCompletionTimeout}, workspaceconnectorapi.Config{
		BaseURL:       textValue(profile["endpoint"]),
		ManagementKey: textValue(profile["managementKey"]),
	})
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), remoteCompletionTimeout)
	defer cancel()
	response, err := client.List(ctx)
	if err != nil {
		return nil
	}
	choices := make([]remoteTargetChoice, 0, len(response.Workspaces))
	for _, workspace := range response.Workspaces {
		description := strings.Join(nonEmpty(workspace.Label, workspace.State, workspace.RootLabel), " · ")
		if description == "" {
			description = "本地工作区 Connector"
		}
		if !matchesPrefix(workspace.ID, request.Current) && !matchesContains(description, request.Current) {
			continue
		}
		choices = append(choices, remoteTargetChoice{Value: workspace.ID, Description: description, Group: "工作区 Connector"})
	}
	return choices
}

func nonEmpty(values ...string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			result = append(result, value)
		}
	}
	return result
}
