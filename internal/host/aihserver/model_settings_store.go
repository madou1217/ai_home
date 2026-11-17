package aihserver

import (
	"context"
	"encoding/json"
	"time"

	"github.com/madou1217/ai_home/application/modelsettingssync"
	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
)

// modelSettingsStore keeps transport normalization outside the application. The
// full v5 settings and its routing policy plan are committed by one Go writer.
type modelSettingsStore struct{ store modelsettingssync.Store }

func (adapter modelSettingsStore) Save(ctx context.Context, document any) (modelcatalogsettings.Settings, error) {
	settings := modelcatalogsettings.Normalize(document)
	settings.UpdatedAtMS = time.Now().UnixMilli()
	payload, err := json.Marshal(settings)
	if err != nil {
		return modelcatalogsettings.Settings{}, err
	}
	_, err = (modelsettingssync.Service{Store: adapter.store}).Save(ctx, modelsettingssync.Document{Value: string(payload), UpdatedAtMS: settings.UpdatedAtMS})
	if err != nil {
		return modelcatalogsettings.Settings{}, err
	}
	return settings, nil
}

// UpdateSettings is the OpenAI-model delete port. Its callback runs in the same
// transaction as policy release; never read outside and then overwrite Save.
func (adapter modelSettingsStore) UpdateSettings(ctx context.Context, mutate func(modelcatalogsettings.Settings) (modelcatalogsettings.Settings, error)) (modelcatalogsettings.Settings, error) {
	var saved modelcatalogsettings.Settings
	if adapter.store == nil || mutate == nil {
		return saved, modelsettingssync.ErrInvalidSettings
	}
	_, err := adapter.store.UpdateModelSettings(ctx, func(raw string, _ bool) (modelsettingssync.Document, error) {
		current := modelcatalogsettings.Normalize(raw)
		next, err := mutate(current)
		if err != nil {
			return modelsettingssync.Document{}, err
		}
		next.Version = modelcatalogsettings.SettingsVersion
		next.UpdatedAtMS = time.Now().UnixMilli()
		value, err := json.Marshal(next)
		if err != nil {
			return modelsettingssync.Document{}, err
		}
		saved = next
		return modelsettingssync.Document{Value: string(value), UpdatedAtMS: next.UpdatedAtMS}, nil
	})
	if err != nil {
		return modelcatalogsettings.Settings{}, err
	}
	return saved, nil
}
