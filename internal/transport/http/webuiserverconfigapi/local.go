package webuiserverconfigapi

import (
	"context"
	"encoding/json"
)

// ReadConfig returns the public view without secrets.
func ReadConfig(ctx context.Context, aiHomeDir string) (ConfigView, error) {
	config, err := ReadFullConfig(ctx, aiHomeDir)
	if err != nil {
		return ConfigView{}, err
	}
	return publicServerConfig(config), nil
}

// ReadFullConfig returns the normalized configuration including secrets.
func ReadFullConfig(ctx context.Context, aiHomeDir string) (ConfigView, error) {
	source, err := OpenSource(aiHomeDir)
	if err != nil {
		return ConfigView{}, err
	}
	raw, found, err := source.ReadServerConfig(ctx)
	if err != nil {
		return ConfigView{}, err
	}
	return sanitizeFullServerConfigFromJSON(raw, found)
}

// ApplyConfigPatch merges a known-key patch into config:server using the same
// normalization as the HTTP write endpoint, including apiKey/managementKey.
func ApplyConfigPatch(ctx context.Context, aiHomeDir string, patch map[string]any) (ConfigView, error) {
	source, err := OpenSource(aiHomeDir)
	if err != nil {
		return ConfigView{}, err
	}
	var saved ConfigView
	err = source.UpdateServerConfig(ctx, func(current string, found bool) (string, error) {
		base, err := sanitizeFullServerConfigFromJSON(current, found)
		if err != nil {
			return "", err
		}
		merged := mergeServerConfigPatch(base, patch)
		saved = sanitizeServerConfig(merged)
		stored := configToMap(saved)
		delete(stored, "apiKeyConfigured")
		delete(stored, "managementKeyConfigured")
		encoded, err := json.Marshal(stored)
		if err != nil {
			return "", err
		}
		return string(encoded), nil
	})
	return saved, err
}

// PublicConfig strips secrets and sets the configured flags for display.
func PublicConfig(config ConfigView) ConfigView {
	return publicServerConfig(config)
}
