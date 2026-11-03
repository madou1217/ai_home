package nativeaccount

import (
	"encoding/json"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

type identityPolicy func(providerID string, auth map[string]any) (accountcore.NativeIdentity, error)

// decodeExtended is the anti-corruption boundary for already materialized native
// artifacts. Identity is always re-derived from the nested provider evidence.
func decodeExtended(providerID string, policy identityPolicy) decodeStrategy {
	return func(data []byte) (accountapp.Credential, accountapp.PublicProfile, error) {
		artifacts, err := decodeArtifactObject(data, "native_auth_json")
		if err != nil {
			return nil, nil, invalidArtifacts("原生凭据 envelope 无效")
		}
		var auth map[string]any
		if err := decodeStrictJSON(artifacts["native_auth_json"], &auth); err != nil || len(auth) == 0 {
			return nil, nil, invalidArtifacts("原生凭据结构无效")
		}
		identity, err := policy(providerID, auth)
		if err != nil {
			return nil, nil, invalidArtifacts("原生凭据身份不可验证")
		}
		credential, err := accountcore.NewNativeCredential(identity, artifacts["native_auth_json"], nativeGenerations(providerID, auth)...)
		if err != nil {
			return nil, nil, invalidArtifacts("原生凭据领域值无效")
		}
		return credential, nil, nil
	}
}

// decodeStrictJSON rejects duplicate object keys at every JSON nesting level.
func decodeStrictJSON(data []byte, destination any) error {
	if err := rejectDuplicateKeys(data); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytesReader(data))
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	return requireJSONEOF(decoder)
}
