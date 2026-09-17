package sqliteaccount

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

// TestNativeProvidersRoundTripAndDefault exercises the real registration and
// default paths for every extended catalog provider without touching user HOME.
func TestNativeProvidersRoundTripAndDefault(t *testing.T) {
	providers := []string{
		"gemini", "opencode", "grok", "qoder", "qodercn", "kimi", "kiro",
		"zcode", "codebuddy", "codebuddycn", "workbuddy", "workbuddycn",
	}
	for _, providerID := range providers {
		providerID := providerID
		t.Run(providerID, func(t *testing.T) {
			store := openTestStore(t)
			credential := nativeFixtureCredential(t, providerID, "roundtrip-user")
			request := newRegistrationRequest(t, store, credential, nil)
			account, err := store.RegisterNew(context.Background(), request)
			if err != nil {
				t.Fatalf("RegisterNew() error = %v", err)
			}
			restored, err := store.GetCredential(context.Background(), account.Ref())
			if err != nil {
				t.Fatalf("GetCredential() error = %v", err)
			}
			if restored.ProviderID() != providerID || restored.IdentitySeed() != credential.IdentitySeed() {
				t.Fatalf("restored identity=(%s,%s), want=(%s,%s)", restored.ProviderID(), restored.IdentitySeed(), providerID, credential.IdentitySeed())
			}
			defaultValue, err := store.SetProviderDefault(context.Background(), mustProviderDefault(t, providerID, account.Ref()))
			if err != nil {
				t.Fatalf("SetProviderDefault() error = %v", err)
			}
			if got, err := store.GetProviderDefault(context.Background(), providerID); err != nil || got != defaultValue {
				t.Fatalf("GetProviderDefault()=(%#v,%v), want %#v", got, err, defaultValue)
			}
		})
	}
}

// TestNativeSQLiteTamperAndRotationBoundaries proves payload-derived identity:
// a foreign payload fails the stored credential-ref check, while same-user token
// rotation is accepted by the native reauthentication path.
func TestNativeSQLiteTamperAndRotationBoundaries(t *testing.T) {
	store := openTestStore(t)
	original := nativeFixtureCredential(t, "kimi", "tamper-user")
	request := newRegistrationRequest(t, store, original, nil)
	account, err := store.RegisterNew(context.Background(), request)
	if err != nil {
		t.Fatalf("RegisterNew() error = %v", err)
	}

	foreign := nativeFixtureCredential(t, "kimi", "foreign-user")
	foreignDocument, err := encodeCredentialJSON(nativeCredentialV1{NativeAuth: foreign.(*accountcore.NativeCredential).Payload()})
	if err != nil {
		t.Fatalf("encode foreign payload error = %v", err)
	}
	if _, err := store.db.Exec("UPDATE account_credentials SET credential_json = ? WHERE account_ref = ?", string(foreignDocument), account.Ref().String()); err != nil {
		t.Fatalf("tamper UPDATE error = %v", err)
	}
	if _, err := store.GetCredential(context.Background(), account.Ref()); !errors.Is(err, ErrInvalidCredential) {
		t.Fatalf("tampered GetCredential() error = %v, want ErrInvalidCredential", err)
	}

	if _, err := store.db.Exec("UPDATE account_credentials SET credential_json = ? WHERE account_ref = ?", mustNativeDocument(t, original), account.Ref().String()); err != nil {
		t.Fatalf("restore original payload error = %v", err)
	}
	rotated := nativeFixtureCredential(t, "kimi", "tamper-user", 1_700_000_060)
	command, err := accountapp.NewReauthentication(store.catalog, account.Ref(), rotated, nil, testAccountTime().Add(time.Minute))
	if err != nil {
		t.Fatalf("NewReauthentication() error = %v", err)
	}
	if _, err := store.Reauthenticate(context.Background(), command); err != nil {
		t.Fatalf("same-user Reauthenticate() error = %v", err)
	}
	if _, err := accountapp.NewReauthentication(store.catalog, account.Ref(), foreign, nil, testAccountTime().Add(2*time.Minute)); !errors.Is(err, accountapp.ErrReauthenticationIdentityMismatch) {
		t.Fatalf("foreign NewReauthentication() error = %v, want identity mismatch", err)
	}
}

func mustProviderDefault(t *testing.T, providerID string, accountRef accountcore.AccountRef) accountcore.ProviderDefault {
	t.Helper()
	value, err := accountcore.NewProviderDefault(providerID, accountRef, testAccountTime().Add(time.Second))
	if err != nil {
		t.Fatalf("NewProviderDefault() error = %v", err)
	}
	return value
}

func mustNativeDocument(t *testing.T, credential accountapp.Credential) string {
	t.Helper()
	native := credential.(*accountcore.NativeCredential)
	document, err := encodeCredentialJSON(nativeCredentialV1{NativeAuth: native.Payload()})
	if err != nil {
		t.Fatalf("encode native document error = %v", err)
	}
	return string(document)
}

func nativeFixtureCredential(t *testing.T, providerID, subject string, generation ...int64) accountapp.Credential {
	t.Helper()
	auth := nativeFixtureAuth(t, providerID, subject, generation...)
	payload, err := json.Marshal(map[string]any{"native_auth_json": auth})
	if err != nil {
		t.Fatalf("marshal native envelope error = %v", err)
	}
	credential, _, err := nativeaccount.NewDecoder().Decode(providerID, payload)
	if err != nil {
		t.Fatalf("Decode(%s) error = %v", providerID, err)
	}
	return credential
}

func nativeFixtureAuth(t *testing.T, providerID, subject string, generation ...int64) map[string]any {
	t.Helper()
	issued := int64(1_700_000_000)
	if len(generation) > 0 {
		issued = generation[0]
	}
	access := nativeFixtureJWT(t, map[string]any{"sub": subject, "iat": issued, "exp": issued + 3600})
	switch providerID {
	case "gemini":
		return map[string]any{"googleAccounts": map[string]any{"active": subject + "@example.invalid"}, "oauthCreds": map[string]any{"access_token": access, "expiry_date": (issued + 3600) * 1000}}
	case "opencode":
		return map[string]any{"auth": map[string]any{"anthropic": map[string]any{"type": "oauth", "account_id": subject, "refresh": "opencode-refresh", "access": access}}}
	case "grok":
		return map[string]any{"auth": map[string]any{"default": map[string]any{"user_id": subject, "access_token": access}}}
	case "qoder", "qodercn":
		return map[string]any{"userInfo": map[string]any{"uid": subject, "security_oauth_token": access}}
	case "kimi":
		return map[string]any{"credentials": map[string]any{"user_id": subject, "refresh_token": "kimi-refresh", "access_token": access}}
	case "kiro":
		endpoint := "https://codewhisperer.us-east-1.amazonaws.com"
		refresh := "kiro-refresh-" + subject
		return map[string]any{"auth": map[string]any{"access_token": access, "refresh_token": refresh}, "identityEvidence": map[string]any{"version": 1, "source": "aws-codewhisperer:GetUsageLimits", "endpoint": endpoint, "subject": subject, "tokenBinding": sha256JSON([]string{endpoint, access, refresh}), "observedAtMs": 1}}
	case "zcode":
		info, err := json.Marshal(map[string]any{"user_id": subject})
		if err != nil {
			t.Fatal(err)
		}
		return map[string]any{"credentials": map[string]any{"oauth:zai:user_info": string(info), "zcodejwttoken": access}}
	case "codebuddy", "codebuddycn", "workbuddy", "workbuddycn":
		issuer := map[string]string{"codebuddy": "https://www.codebuddy.ai/auth/realms/copilot", "workbuddy": "https://www.workbuddy.ai/auth/realms/copilot", "codebuddycn": "https://www.codebuddy.cn/auth/realms/copilot", "workbuddycn": "https://www.workbuddy.cn/auth/realms/copilot"}[providerID]
		domain := strings.TrimPrefix(issuer, "https://")
		domain = domain[:strings.IndexByte(domain, '/')]
		return map[string]any{"credentials": map[string]any{"account": map[string]any{"uid": subject}, "auth": map[string]any{"domain": domain, "accessToken": nativeFixtureJWT(t, map[string]any{"iss": issuer, "sub": subject, "iat": issued}), "refreshToken": nativeFixtureJWT(t, map[string]any{"iss": issuer, "sub": subject, "iat": issued})}}}
	default:
		t.Fatalf("unknown fixture provider %s", providerID)
		return nil
	}
}

func sha256JSON(value []string) string {
	payload, _ := json.Marshal(value)
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:])
}

func nativeFixtureJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	return "e30." + base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}

// Each Provider goes through the same real SQLite transaction. New credential
// evidence wins, a late old grant does not, and a foreign subject is refused.
func TestEveryNativeProviderReauthenticationPreservesAccountAndRejectsOldGeneration(t *testing.T) {
	for _, provider := range []string{"gemini", "opencode", "grok", "qoder", "qodercn", "kimi", "kiro", "zcode", "codebuddy", "codebuddycn", "workbuddy", "workbuddycn"} {
		t.Run(provider, func(t *testing.T) {
			store := openTestStore(t)
			ctx := context.Background()
			old := nativeFixtureCredential(t, provider, "stable-user", 1_700_000_000)
			account, err := store.RegisterNew(ctx, newRegistrationRequest(t, store, old, nil))
			if err != nil {
				t.Fatal(err)
			}
			newer := nativeFixtureCredential(t, provider, "stable-user", 1_700_000_060)
			command, err := accountapp.NewReauthentication(store.catalog, account.Ref(), newer, nil, testAccountTime().Add(time.Minute))
			if err != nil {
				t.Fatal(err)
			}
			updated, err := store.Reauthenticate(ctx, command)
			if err != nil {
				t.Fatal(err)
			}
			if updated.Ref() != account.Ref() || updated.CLIAccountID() != account.CLIAccountID() {
				t.Fatal("rotation changed account addressing")
			}
			restored, err := store.GetCredential(ctx, account.Ref())
			if err != nil {
				t.Fatal(err)
			}
			if mustNativeDocument(t, restored) != mustNativeDocument(t, newer) {
				t.Fatal("new generation was not persisted")
			}
			late, _ := accountapp.NewReauthentication(store.catalog, account.Ref(), old, nil, testAccountTime().Add(2*time.Minute))
			if _, err := store.Reauthenticate(ctx, late); err != nil {
				t.Fatal(err)
			}
			restored, err = store.GetCredential(ctx, account.Ref())
			if err != nil || mustNativeDocument(t, restored) != mustNativeDocument(t, newer) {
				t.Fatal("late old grant overwrote the newer one")
			}
			foreign := nativeFixtureCredential(t, provider, "foreign-user", 1_700_000_120)
			if _, err := accountapp.NewReauthentication(store.catalog, account.Ref(), foreign, nil, testAccountTime().Add(3*time.Minute)); !errors.Is(err, accountapp.ErrReauthenticationIdentityMismatch) {
				t.Fatal("foreign identity was accepted")
			}
		})
	}
}

func TestNativeCodecRejectsIndependentlyForgedIdentityAtWriteTime(t *testing.T) {
	store := openTestStore(t)
	foreign := nativeFixtureCredential(t, "kimi", "foreign-user").(*accountcore.NativeCredential)
	identity, err := accountcore.NewNativeSubjectIdentity("kimi", "claimed-user")
	if err != nil {
		t.Fatal(err)
	}
	forged, err := accountcore.NewNativeCredential(identity, foreign.Payload(), foreign.Generations()...)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.RegisterNew(context.Background(), newRegistrationRequest(t, store, forged, nil)); !errors.Is(err, ErrInvalidCredential) {
		t.Fatalf("write accepted unbound evidence: %v", err)
	}
}
