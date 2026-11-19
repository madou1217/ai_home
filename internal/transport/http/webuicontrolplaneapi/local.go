package webuicontrolplaneapi

import "context"

// ListProfiles returns the normalized control-plane profile store.
func ListProfiles(ctx context.Context, aiHomeDir string) (map[string]any, error) {
	cache := newProfileCache(aiHomeDir)
	return cache.ReadStore(ctx)
}

// SaveProfile merges one profile into the store and returns the saved profile.
func SaveProfile(ctx context.Context, aiHomeDir string, profile map[string]any, options map[string]any) (map[string]any, map[string]any, error) {
	cache := newProfileCache(aiHomeDir)
	var saved map[string]any
	var next map[string]any
	err := cache.UpdateStore(ctx, func(store map[string]any) (map[string]any, error) {
		updated, savedProfile, err := saveProfileInStore(store, profile, options)
		if err != nil {
			return nil, err
		}
		saved, next = savedProfile, updated
		return updated, nil
	})
	return saved, next, err
}

// SetActiveProfile marks one profile as active.
func SetActiveProfile(ctx context.Context, aiHomeDir, profileID string) (map[string]any, error) {
	cache := newProfileCache(aiHomeDir)
	var next map[string]any
	err := cache.UpdateStore(ctx, func(store map[string]any) (map[string]any, error) {
		next = setActiveInStore(store, profileID)
		return next, nil
	})
	return next, err
}

// RemoveProfile deletes one profile from the store.
func RemoveProfile(ctx context.Context, aiHomeDir, profileID string) (map[string]any, error) {
	cache := newProfileCache(aiHomeDir)
	var next map[string]any
	err := cache.UpdateStore(ctx, func(store map[string]any) (map[string]any, error) {
		next = removeFromStore(store, profileID)
		return next, nil
	})
	return next, err
}

// NormalizeEndpoint applies the same URL normalization used by the HTTP API.
func NormalizeEndpoint(value string) string {
	return normalizeEndpoint(value)
}
