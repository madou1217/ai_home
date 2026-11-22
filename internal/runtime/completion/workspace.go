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

func resolveWorkspaceCompletion(target *collector, context *resolverContext, prior []string, current string) []Candidate {
	if len(prior) == 1 {
		for _, sub := range []namedSummary{
			{Name: "connect", Summary: "连接一个本地目录（只暴露该目录，不启动模型）"},
			{Name: "ls", Summary: "列出已登记的本地工作区"},
			{Name: "enroll", Summary: "生成一次性 enrollment code"},
			{Name: "revoke", Summary: "撤销一个工作区登记"},
		} {
			target.add(sub.Name, sub.Summary, groupSubcommand, "")
		}
		return target.items
	}
	action := prior[1]
	flags := map[string][]string{
		"connect": {"--server", "--root", "--label", "--code", "--no-reconnect", "--help"},
		"ls":      {"--server", "--json", "--help"},
		"list":    {"--server", "--json", "--help"},
		"enroll":  {"--server", "--label", "--json", "--help"},
		"revoke":  {"--server", "--help"},
	}
	allowed, known := flags[action]
	if !known {
		return target.items
	}
	last := prior[len(prior)-1]
	if last == "--server" {
		for _, profile := range listCompletionServerProfiles(context, current) {
			target.add(profile.Value, profile.Description, groupOther, profile.Description)
		}
		return target.items
	}
	if action == "revoke" && context.workspaceLister != nil && !strings.HasPrefix(current, "-") {
		for _, choice := range context.workspaceLister(workspaceRequest{
			Action: "list", Server: workspaceOptionValue(prior, "--server"), Current: current,
		}) {
			target.add(choice.Value, choice.Description, groupOther, choice.Description)
		}
		return target.items
	}
	if strings.HasPrefix(current, "-") || last == action || len(prior) == 2 || strings.HasPrefix(last, "--") {
		for _, flag := range allowed {
			target.add(flag, describeFlag(flag), groupFlag, "")
		}
		return target.items
	}
	if action == "revoke" && context.workspaceLister != nil {
		for _, choice := range context.workspaceLister(workspaceRequest{
			Action: "list", Server: workspaceOptionValue(prior, "--server"), Current: current,
		}) {
			target.add(choice.Value, choice.Description, groupOther, choice.Description)
		}
		return target.items
	}
	return target.items
}

func workspaceOptionValue(prior []string, flag string) string {
	for index := len(prior) - 1; index >= 0; index-- {
		if prior[index] == flag && index+1 < len(prior) {
			return strings.TrimSpace(prior[index+1])
		}
	}
	return ""
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
