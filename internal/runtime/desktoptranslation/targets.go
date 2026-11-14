package desktoptranslation

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/translation"
)

var ErrTarget = errors.New("translation_server_target_unavailable")

type ResolvedTarget struct{ Origin, ManagementKey string }
type TargetResolver func(context.Context, translation.SystemServerTarget) (ResolvedTarget, error)

// ResolveTarget never sends the local management key to an arbitrary loopback port
// or remote origin. Remote credentials must belong to an explicit persisted profile.
func ResolveTarget(ctx context.Context, databasePath, localOrigin, localKey string, target translation.SystemServerTarget) (ResolvedTarget, error) {
	origin, err := normalizeOrigin(target.Origin)
	if err != nil {
		return ResolvedTarget{}, err
	}
	local, err := normalizeOrigin(localOrigin)
	if err == nil && origin == local && target.ServerID == "" {
		return ResolvedTarget{Origin: origin, ManagementKey: localKey}, nil
	}
	if target.ServerID == "" {
		return ResolvedTarget{Origin: origin}, nil
	}
	raw, found, err := appstate.ReadKV(ctx, databasePath, "control-plane:profiles")
	if err != nil || !found {
		return ResolvedTarget{}, ErrTarget
	}
	var data struct {
		Profiles []struct {
			ID            string `json:"id"`
			Endpoint      string `json:"endpoint"`
			ManagementKey string `json:"managementKey"`
		}
	}
	if json.Unmarshal([]byte(raw), &data) != nil {
		return ResolvedTarget{}, ErrTarget
	}
	for _, profile := range data.Profiles {
		if profile.ID == target.ServerID {
			endpoint, e := normalizeOrigin(profile.Endpoint)
			if e != nil || endpoint != origin {
				return ResolvedTarget{}, ErrTarget
			}
			return ResolvedTarget{Origin: endpoint, ManagementKey: profile.ManagementKey}, nil
		}
	}
	return ResolvedTarget{}, ErrTarget
}
func normalizeOrigin(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", ErrTarget
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	parsed.Host = strings.ToLower(parsed.Host)
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	return parsed.String(), nil
}
