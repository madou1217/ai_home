package aihserver

import (
	"context"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/webuiclipboardapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuicontrolplaneapi"
)

// clipboardServerProfiles adapts the control-plane profile store for clipboard sync and WebUI.
// Management keys are only returned by Resolve for outbound sync calls; List returns sanitized views.
type clipboardServerProfiles struct {
	home string
}

func (p clipboardServerProfiles) Resolve(ctx context.Context, profileIDOrName string) (endpoint string, managementKey string, err error) {
	target := strings.TrimSpace(profileIDOrName)
	if target == "" {
		return "", "", fmt.Errorf("server_profile_id_required")
	}
	store, err := webuicontrolplaneapi.ListProfiles(ctx, p.home)
	if err != nil {
		return "", "", err
	}
	list := requirementProfileList(store)
	// First try exact profile ID match, then case-insensitive name match.
	var matched map[string]any
	for _, profile := range list {
		if requirementText(profile, "id") == target {
			matched = profile
			break
		}
	}
	if matched == nil {
		for _, profile := range list {
			if strings.EqualFold(requirementText(profile, "name"), target) {
				matched = profile
				break
			}
		}
	}
	if matched == nil {
		return "", "", fmt.Errorf("server_profile_not_found")
	}
	endpoint = strings.TrimRight(requirementText(matched, "endpoint"), "/")
	managementKey = requirementText(matched, "managementKey")
	if endpoint == "" || managementKey == "" {
		return "", "", fmt.Errorf("server_profile_incomplete")
	}
	return endpoint, managementKey, nil
}

func (p clipboardServerProfiles) List(ctx context.Context) ([]webuiclipboardapi.ServerProfileView, error) {
	store, err := webuicontrolplaneapi.ListProfiles(ctx, p.home)
	if err != nil {
		return nil, err
	}
	activeID := requirementText(store, "activeProfileId")
	views := make([]webuiclipboardapi.ServerProfileView, 0)
	for _, profile := range requirementProfileList(store) {
		id := requirementText(profile, "id")
		endpoint := strings.TrimRight(requirementText(profile, "endpoint"), "/")
		if id == "" || endpoint == "" {
			continue
		}
		label := requirementText(profile, "name")
		if label == "" {
			label = endpoint
		}
		views = append(views, webuiclipboardapi.ServerProfileView{
			ID:       id,
			Label:    label,
			Endpoint: endpoint,
			Active:   id == activeID,
		})
	}
	return views, nil
}
