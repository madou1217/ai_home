package webuiserverconfigapi

import (
	"encoding/json"
	"errors"
	"strings"

	corepolicy "github.com/madou1217/ai_home/core/upstreamretry"
)

func parseRawConfigObject(raw string, found bool) (map[string]any, error) {
	object := map[string]any{}
	if !found || strings.TrimSpace(raw) == "" {
		return object, nil
	}
	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil, err
	}
	if mapped, ok := decoded.(map[string]any); ok && mapped != nil {
		return mapped, nil
	}
	return object, nil
}

// mergeKnownFieldsPreservingUnknown writes sanitized known keys onto a copy of
// rawCurrent so unrelated / future / peer top-level config fields and nested
// unknown fields inside upstream429Retry survive saves.
func mergeKnownFieldsPreservingUnknown(rawCurrent map[string]any, saved ConfigView) map[string]any {
	stored := make(map[string]any, len(rawCurrent)+32)
	for key, value := range rawCurrent {
		stored[key] = value
	}
	known := configToMap(saved)
	delete(known, "apiKeyConfigured")
	delete(known, "managementKeyConfigured")
	for key, value := range known {
		if key == "upstream429Retry" {
			stored[key] = mergeNestedUpstream429Retry(rawCurrent["upstream429Retry"], saved.Upstream429Retry)
			continue
		}
		stored[key] = value
	}
	delete(stored, "apiKeyConfigured")
	delete(stored, "managementKeyConfigured")
	return stored
}

func mergeNestedUpstream429Retry(rawExisting any, policy corepolicy.GlobalPolicy) map[string]any {
	merged := map[string]any{}
	if existing, ok := rawExisting.(map[string]any); ok && existing != nil {
		for key, value := range existing {
			merged[key] = value
		}
	}
	sanitized := corepolicy.SanitizeGlobal(policy)
	merged["enabled"] = sanitized.Enabled
	merged["backoffSeconds"] = sanitized.BackoffSeconds
	return merged
}

func validateUpstream429Patch(patch map[string]any, base corepolicy.GlobalPolicy) (corepolicy.GlobalPolicy, bool, error) {
	raw, exists := patch["upstream429Retry"]
	if !exists {
		return base, false, nil
	}
	validated, err := corepolicy.ValidateGlobalPatchRaw(raw, base)
	if err != nil {
		return corepolicy.GlobalPolicy{}, true, err
	}
	return validated, true, nil
}

func upstream429ValidationError(err error) (string, string, bool) {
	var validationErr *corepolicy.ValidationError
	if errors.As(err, &validationErr) {
		return validationErr.Code, validationErr.Message, true
	}
	if errors.Is(err, corepolicy.ErrInvalidConfig) {
		return corepolicy.ErrCodeInvalidConfig, err.Error(), true
	}
	return "", "", false
}
