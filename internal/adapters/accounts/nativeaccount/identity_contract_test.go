package nativeaccount_test

import (
	"encoding/json"
	"os"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

func TestExtendedNativeIdentityMatchesSharedNodeVectors(t *testing.T) {
	document, err := os.ReadFile("../../../../contracts/extended-native-identity.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Vectors []struct {
			Name         string          `json:"name"`
			Provider     string          `json:"provider"`
			NativeAuth   json.RawMessage `json:"nativeAuth"`
			IdentitySeed string          `json:"identitySeed"`
			AccountRef   string          `json:"accountRef"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(document, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, vector := range fixture.Vectors {
		t.Run(vector.Name, func(t *testing.T) {
			credential, err := nativeaccount.NewDecoder().DecodeNativeAuth(vector.Provider, vector.NativeAuth)
			if vector.IdentitySeed == "" {
				if err == nil {
					t.Fatal("unverifiable identity was accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if credential.IdentitySeed() != vector.IdentitySeed {
				t.Fatalf("identity=%q want %q", credential.IdentitySeed(), vector.IdentitySeed)
			}
			ref, err := accountcore.DeriveAccountRef(credential)
			if err != nil || ref.String() != vector.AccountRef {
				t.Fatalf("ref=%v error=%v want=%s", ref, err, vector.AccountRef)
			}
		})
	}
}
