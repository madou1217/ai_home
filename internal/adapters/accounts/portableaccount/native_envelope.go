package portableaccount

import (
	"encoding/json"
	"errors"
)

// NativeEnvelope maps portable artifacts into each official decoder's contract.
// Provider identity is validated by those decoders, never inferred from sourceRef.
func NativeEnvelope(provider string, raw json.RawMessage) ([]byte, error) {
	var native map[string]json.RawMessage
	if json.Unmarshal(raw, &native) != nil || native == nil {
		return nil, errors.New("invalid_native_backup_document")
	}
	switch provider {
	case "codex":
		auth := native["auth"]
		if len(auth) == 0 {
			auth = raw
		}
		return json.Marshal(map[string]json.RawMessage{"auth_json": auth})
	case "claude":
		credentials := native["credentials"]
		config := native["config"]
		if len(config) == 0 {
			config = native["globalConfig"]
		}
		if len(config) == 0 && len(native["oauthAccount"]) > 0 {
			config, _ = json.Marshal(map[string]json.RawMessage{"oauthAccount": native["oauthAccount"]})
		}
		if len(credentials) == 0 || len(config) == 0 {
			return nil, errors.New("claude_backup_identity_missing")
		}
		return json.Marshal(map[string]json.RawMessage{"credentials_json": credentials, "global_config_json": config})
	default:
		return json.Marshal(map[string]json.RawMessage{"native_auth_json": raw})
	}
}
