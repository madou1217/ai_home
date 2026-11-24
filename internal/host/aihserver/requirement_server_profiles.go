package aihserver

import (
	"context"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/requirementruntime"
	"github.com/madou1217/ai_home/internal/transport/http/webuicontrolplaneapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuirequirementsapi"
)

// requirementServerProfiles is the host-side adapter between the control-plane
// profile store and the requirements scheduler. Keys only flow to the outbound
// management client; the browser catalog is sanitized.
type requirementServerProfiles struct {
	home string
}

func (profiles requirementServerProfiles) Resolve(ctx context.Context, profileID string) (requirementruntime.ServerProfile, error) {
	profileID = strings.TrimSpace(profileID)
	if profileID == "" {
		return requirementruntime.ServerProfile{}, fmt.Errorf("server_profile_id_required")
	}
	store, err := webuicontrolplaneapi.ListProfiles(ctx, profiles.home)
	if err != nil {
		return requirementruntime.ServerProfile{}, err
	}
	for _, profile := range requirementProfileList(store) {
		if requirementText(profile, "id") != profileID {
			continue
		}
		endpoint := strings.TrimRight(requirementText(profile, "endpoint"), "/")
		key := requirementText(profile, "managementKey")
		if endpoint == "" || key == "" {
			return requirementruntime.ServerProfile{}, fmt.Errorf("server_profile_incomplete")
		}
		label := requirementText(profile, "name")
		if label == "" {
			label = endpoint
		}
		return requirementruntime.ServerProfile{ID: profileID, Label: label, Endpoint: endpoint, ManagementKey: key}, nil
	}
	return requirementruntime.ServerProfile{}, fmt.Errorf("server_profile_not_found")
}

func (profiles requirementServerProfiles) List(ctx context.Context) ([]webuirequirementsapi.ServerProfileView, error) {
	store, err := webuicontrolplaneapi.ListProfiles(ctx, profiles.home)
	if err != nil {
		return nil, err
	}
	activeID := requirementText(store, "activeProfileId")
	views := make([]webuirequirementsapi.ServerProfileView, 0)
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
		views = append(views, webuirequirementsapi.ServerProfileView{
			ID: id, Label: label, Endpoint: endpoint, Active: id == activeID,
		})
	}
	return views, nil
}

func requirementProfileList(store map[string]any) []map[string]any {
	switch raw := store["profiles"].(type) {
	case []map[string]any:
		return raw
	case []any:
		profiles := make([]map[string]any, 0, len(raw))
		for _, item := range raw {
			if profile, ok := item.(map[string]any); ok {
				profiles = append(profiles, profile)
			}
		}
		return profiles
	default:
		return nil
	}
}

func requirementText(values map[string]any, key string) string {
	if values == nil {
		return ""
	}
	value, _ := values[key].(string)
	return strings.TrimSpace(value)
}
