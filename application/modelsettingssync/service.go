package modelsettingssync

import (
	"context"
	"encoding/json"
	"errors"
)

var ErrInvalidSettings = errors.New("invalid_model_settings_sync")

type Service struct{ Store Store }

func (service Service) Save(ctx context.Context, document Document) (Result, error) {
	if ctx == nil || service.Store == nil || document.Value == "" || document.UpdatedAtMS <= 0 {
		return Result{}, ErrInvalidSettings
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	return service.Store.SaveModelSettings(ctx, document)
}

// ReadSettings reads only routing fields from the already normalized document.
// The full document remains the persistence value; there are not two truths.
func ReadSettings(value string) (Settings, error) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal([]byte(value), &object); err != nil || object == nil {
		return Settings{}, ErrInvalidSettings
	}
	var settings Settings
	if err := json.Unmarshal([]byte(value), &settings); err != nil {
		return Settings{}, ErrInvalidSettings
	}
	return settings, nil
}
