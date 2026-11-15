package remotebackup

import (
	"context"
	"encoding/json"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/portableaccount"
)

type supplementReader interface {
	ReadPortableSupplement(context.Context, accountcore.AccountRef, int64) (json.RawMessage, bool, error)
}

func applyPortableSupplement(ctx context.Context, store ExportStore, ref accountcore.AccountRef, record AccountRecord) (AccountRecord, error) {
	reader, ok := store.(supplementReader)
	if !ok {
		return record, nil
	}
	raw, found, err := reader.ReadPortableSupplement(ctx, ref, record.CredentialUpdatedAt)
	if err != nil {
		return record, err
	}
	if !found {
		return record, nil
	}
	payload, err := decodePortableJSON(raw)
	if err != nil {
		return record, err
	}
	env := map[string]string{}
	if prior, ok := payload["env"].(map[string]any); ok {
		for k, v := range prior {
			if text, ok := v.(string); ok {
				env[k] = text
			}
		}
	}
	record.Env = portableaccount.OverlayEnv(record.Provider, env, record.Env)
	if prior, ok := payload["nativeAuth"].(map[string]any); ok {
		record.NativeAuth = mergePortableMap(portableaccount.NormalizeSupplement(record.Provider, prior, record.NativeAuth), record.NativeAuth)
	}
	return record, nil
}
func mergePortableMap(prior, current map[string]any) map[string]any {
	next := make(map[string]any, len(prior)+len(current))
	for k, v := range prior {
		next[k] = v
	}
	for k, v := range current {
		a, aok := next[k].(map[string]any)
		b, bok := v.(map[string]any)
		if aok && bok {
			next[k] = mergePortableMap(a, b)
		} else {
			next[k] = v
		}
	}
	return next
}
