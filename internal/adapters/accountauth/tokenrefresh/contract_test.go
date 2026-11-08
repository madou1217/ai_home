package tokenrefresh_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/clineoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/geminioauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/grokoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/tokenrefresh"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

// 固定时钟：到期窗口、过期时间与凭据版本都以它为基准。
var contractNow = time.Unix(1_760_000_000, 0).UTC()

// clineToken 构造身份不变的 WorkOS JWT；jti 只用来区分不同代令牌。
func clineToken(suffix string) string {
	claims, _ := json.Marshal(map[string]any{
		"sub":         "user_1",
		"external_id": "usr-1",
		"jti":         suffix,
	})
	return "workos:eyJhbGciOiJub25lIn0." +
		base64.RawURLEncoding.EncodeToString(claims) + ".sig"
}

// providerCase 是三家策略共享的行为矩阵所需的最小描述。
type providerCase struct {
	name       string
	providerID string
	// storeToken 是凭据文档里保存的 access token 形态（cline 带 workos: 前缀）。
	storeToken func(suffix string) string
	// wireToken 是刷新响应里返回的 token 形态（cline 是裸 JWT）。
	wireToken func(suffix string) string
	// payload 生成凭据文档；expiresAt 决定到期判断结果。
	payload func(accessToken string, expiresAt time.Time) string
	// successBody 生成刷新成功响应。
	successBody func(wireToken string, now time.Time) string
	// accessTokenOf 从凭据文档读当前 access token，用于断言写回结果。
	accessTokenOf func(t *testing.T, credential accountapp.Credential) string
	// newRefresher 构造指向 fake 端点的策略。
	newRefresher func(endpoint string, clock func() time.Time) (tokenrefresh.Refresher, error)
}

func plainToken(prefix string) func(string) string {
	return func(suffix string) string { return prefix + "-" + suffix }
}

func jsonSuccessBody(wireToken string, _ time.Time) string {
	return fmt.Sprintf(
		`{"access_token":%q,"refresh_token":"refreshed-refresh","expires_in":3600}`,
		wireToken,
	)
}

func contractCases() []providerCase {
	return []providerCase{
		{
			name:       "gemini",
			providerID: "gemini",
			storeToken: plainToken("gemini"),
			wireToken:  plainToken("gemini"),
			payload: func(accessToken string, expiresAt time.Time) string {
				return fmt.Sprintf(
					`{"googleAccounts":{"active":"user@example.com"},"oauthCreds":{"access_token":%q,"refresh_token":"old-refresh","expiry_date":%d}}`,
					accessToken, expiresAt.UnixMilli(),
				)
			},
			successBody: jsonSuccessBody,
			accessTokenOf: func(t *testing.T, credential accountapp.Credential) string {
				document := payloadOf(t, credential)
				oauth := tokenrefresh.Object(document["oauthCreds"])
				if oauth == nil {
					t.Fatalf("oauthCreds missing")
				}
				return tokenrefresh.Text(oauth, "access_token")
			},
			newRefresher: func(endpoint string, clock func() time.Time) (tokenrefresh.Refresher, error) {
				return geminioauth.New(
					&http.Client{Timeout: 5 * time.Second},
					geminioauth.Options{TokenEndpoint: endpoint, Clock: clock},
				)
			},
		},
		{
			name:       "grok",
			providerID: "grok",
			storeToken: plainToken("grok"),
			wireToken:  plainToken("grok"),
			payload: func(accessToken string, expiresAt time.Time) string {
				return fmt.Sprintf(
					`{"auth":{"grok::client-1":{"key":%q,"refresh_token":"old-refresh","user_id":"user-1","expires_at":%q}}}`,
					accessToken, tokenrefresh.ISOString(expiresAt),
				)
			},
			successBody: jsonSuccessBody,
			accessTokenOf: func(t *testing.T, credential accountapp.Credential) string {
				document := payloadOf(t, credential)
				auth := tokenrefresh.Object(document["auth"])
				profile := tokenrefresh.Object(auth["grok::client-1"])
				if profile == nil {
					t.Fatalf("grok profile missing")
				}
				return tokenrefresh.Text(profile, "key")
			},
			newRefresher: func(endpoint string, clock func() time.Time) (tokenrefresh.Refresher, error) {
				return grokoauth.New(
					&http.Client{Timeout: 5 * time.Second},
					grokoauth.Options{TokenEndpoint: endpoint, Clock: clock},
				)
			},
		},
		{
			name:       "cline",
			providerID: "cline",
			storeToken: clineToken,
			wireToken:  func(suffix string) string { return strings.TrimPrefix(clineToken(suffix), "workos:") },
			payload: func(accessToken string, expiresAt time.Time) string {
				return fmt.Sprintf(
					`{"auth":{"version":1,"providers":{"cline":{"settings":{"auth":{"accessToken":%q,"refreshToken":"old-refresh","expiresAt":%d}}}}}}`,
					accessToken, expiresAt.UnixMilli(),
				)
			},
			successBody: func(wireToken string, now time.Time) string {
				return fmt.Sprintf(
					`{"success":true,"data":{"accessToken":%q,"refreshToken":"refreshed-refresh","expiresAt":%q}}`,
					wireToken, tokenrefresh.ISOString(now.Add(time.Hour)),
				)
			},
			accessTokenOf: func(t *testing.T, credential accountapp.Credential) string {
				document := payloadOf(t, credential)
				auth := tokenrefresh.Object(document["auth"])
				providers := tokenrefresh.Object(auth["providers"])
				settings := tokenrefresh.Object(tokenrefresh.Object(providers["cline"])["settings"])
				return tokenrefresh.Text(tokenrefresh.Object(settings["auth"]), "accessToken")
			},
			newRefresher: func(endpoint string, clock func() time.Time) (tokenrefresh.Refresher, error) {
				return clineoauth.New(
					&http.Client{Timeout: 5 * time.Second},
					clineoauth.Options{BaseURL: endpoint, Clock: clock},
				)
			},
		},
	}
}

func payloadOf(t *testing.T, credential accountapp.Credential) map[string]any {
	t.Helper()
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil {
		t.Fatalf("credential type = %T", credential)
	}
	document, err := tokenrefresh.DecodeDocument(native.Payload())
	if err != nil {
		t.Fatalf("DecodeDocument() error = %v", err)
	}
	return document
}

func newCredential(t *testing.T, providerID string, payload string) *accountcore.NativeCredential {
	t.Helper()
	credential, err := nativeaccount.NewDecoder().DecodeNativeAuth(providerID, []byte(payload))
	if err != nil {
		t.Fatalf("DecodeNativeAuth(%s) error = %v", providerID, err)
	}
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil {
		t.Fatalf("credential type = %T", credential)
	}
	return native
}

// fakeStore 只实现 CAS 语义：Replace 可注入一次「其他进程先写入」的冲突。
type fakeStore struct {
	mutex        sync.Mutex
	snapshot     accountapp.CredentialSnapshot
	writes       int
	conflict     bool
	conflictWith accountapp.CredentialSnapshot
}

func (store *fakeStore) GetCredentialSnapshot(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialSnapshot, error) {
	store.mutex.Lock()
	defer store.mutex.Unlock()
	if !store.snapshot.IsValid() || store.snapshot.AccountRef() != accountRef {
		return accountapp.CredentialSnapshot{}, errors.New("snapshot not found")
	}
	return store.snapshot, nil
}

func (store *fakeStore) ReplaceCredential(
	_ context.Context,
	replacement accountapp.CredentialReplacement,
) error {
	store.mutex.Lock()
	defer store.mutex.Unlock()
	store.writes++
	if store.conflict {
		store.conflict = false
		store.snapshot = store.conflictWith
		return accountapp.ErrCredentialConflict
	}
	next, err := accountapp.NewCredentialSnapshot(
		replacement.AccountRef(),
		replacement.Credential().ProviderID(),
		replacement.Credential(),
		replacement.UpdatedAt(),
	)
	if err != nil {
		return err
	}
	store.snapshot = next
	return nil
}

func (store *fakeStore) snapshotOf(t *testing.T) accountapp.CredentialSnapshot {
	t.Helper()
	store.mutex.Lock()
	defer store.mutex.Unlock()
	return store.snapshot
}

func (store *fakeStore) writeCount() int {
	store.mutex.Lock()
	defer store.mutex.Unlock()
	return store.writes
}

func seedStore(
	t *testing.T,
	providerID string,
	credential *accountcore.NativeCredential,
	updatedAt time.Time,
) (*fakeStore, accountcore.AccountRef) {
	t.Helper()
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	snapshot, err := accountapp.NewCredentialSnapshot(accountRef, providerID, credential, updatedAt)
	if err != nil {
		t.Fatalf("NewCredentialSnapshot() error = %v", err)
	}
	return &fakeStore{snapshot: snapshot}, accountRef
}

func newResolver(
	t *testing.T,
	store *fakeStore,
	refresher tokenrefresh.Refresher,
) *accountcredentials.Resolver {
	t.Helper()
	strategy, err := tokenrefresh.NewStrategy(refresher)
	if err != nil {
		t.Fatalf("NewStrategy() error = %v", err)
	}
	resolver, err := accountcredentials.NewResolver(accountcredentials.Dependencies{
		Store:      store,
		Strategies: []accountcredentials.RefreshStrategy{strategy},
		Clock:      func() time.Time { return contractNow },
	})
	if err != nil {
		t.Fatalf("NewResolver() error = %v", err)
	}
	return resolver
}

// startEndpoint 启动 fake HTTP 端点并统计调用次数。
func startEndpoint(t *testing.T, status int, body string) (*httptest.Server, func() int) {
	t.Helper()
	var mutex sync.Mutex
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		mutex.Lock()
		calls++
		mutex.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(status)
		_, _ = io.WriteString(writer, body)
	}))
	t.Cleanup(server.Close)
	return server, func() int {
		mutex.Lock()
		defer mutex.Unlock()
		return calls
	}
}

// TestRefresherContract 用同一份矩阵验证三家的共享刷新语义：
// 未到期跳过、到期刷新、强制刷新、HTTP 失败不写回、CAS 冲突回读。
func TestRefresherContract(t *testing.T) {
	for _, testCase := range contractCases() {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Run("未到期跳过", func(t *testing.T) {
				server, calls := startEndpoint(t, http.StatusOK, "{}")
				refresher, err := testCase.newRefresher(server.URL, func() time.Time { return contractNow })
				if err != nil {
					t.Fatalf("newRefresher() error = %v", err)
				}
				credential := newCredential(t, testCase.providerID,
					testCase.payload(testCase.storeToken("old"), contractNow.Add(time.Hour)))
				store, accountRef := seedStore(t, testCase.providerID, credential, contractNow.Add(-time.Hour))
				result, err := newResolver(t, store, refresher).Resolve(context.Background(), accountRef)
				if err != nil {
					t.Fatalf("Resolve() error = %v", err)
				}
				if result.Refreshed() || calls() != 0 || store.writeCount() != 0 {
					t.Fatalf("refreshed = %v, calls = %d, writes = %d",
						result.Refreshed(), calls(), store.writeCount())
				}
				if got := testCase.accessTokenOf(t, result.Credential()); got != testCase.storeToken("old") {
					t.Fatalf("access token = %q", got)
				}
			})

			t.Run("到期刷新并CAS写回", func(t *testing.T) {
				server, calls := startEndpoint(t, http.StatusOK,
					testCase.successBody(testCase.wireToken("refreshed"), contractNow))
				refresher, err := testCase.newRefresher(server.URL, func() time.Time { return contractNow })
				if err != nil {
					t.Fatalf("newRefresher() error = %v", err)
				}
				credential := newCredential(t, testCase.providerID,
					testCase.payload(testCase.storeToken("old"), contractNow.Add(-time.Minute)))
				store, accountRef := seedStore(t, testCase.providerID, credential, contractNow.Add(-time.Hour))
				result, err := newResolver(t, store, refresher).Resolve(context.Background(), accountRef)
				if err != nil {
					t.Fatalf("Resolve() error = %v", err)
				}
				if !result.Refreshed() || calls() != 1 || store.writeCount() != 1 {
					t.Fatalf("refreshed = %v, calls = %d, writes = %d",
						result.Refreshed(), calls(), store.writeCount())
				}
				if got := testCase.accessTokenOf(t, store.snapshotOf(t).Credential()); got != testCase.storeToken("refreshed") {
					t.Fatalf("stored access token = %q", got)
				}
			})

			t.Run("强制刷新", func(t *testing.T) {
				server, calls := startEndpoint(t, http.StatusOK,
					testCase.successBody(testCase.wireToken("forced"), contractNow))
				refresher, err := testCase.newRefresher(server.URL, func() time.Time { return contractNow })
				if err != nil {
					t.Fatalf("newRefresher() error = %v", err)
				}
				credential := newCredential(t, testCase.providerID,
					testCase.payload(testCase.storeToken("old"), contractNow.Add(time.Hour)))
				store, accountRef := seedStore(t, testCase.providerID, credential, contractNow.Add(-time.Hour))
				binding, err := newResolver(t, store, refresher).
					ForceRefreshCredentialBinding(context.Background(), accountRef)
				if err != nil {
					t.Fatalf("ForceRefreshCredentialBinding() error = %v", err)
				}
				if calls() != 1 || store.writeCount() != 1 {
					t.Fatalf("calls = %d, writes = %d", calls(), store.writeCount())
				}
				if got := testCase.accessTokenOf(t, binding.Credential()); got != testCase.storeToken("forced") {
					t.Fatalf("access token = %q", got)
				}
			})

			t.Run("HTTP失败不写回", func(t *testing.T) {
				server, calls := startEndpoint(t, http.StatusInternalServerError,
					`{"error":"server_error"}`)
				refresher, err := testCase.newRefresher(server.URL, func() time.Time { return contractNow })
				if err != nil {
					t.Fatalf("newRefresher() error = %v", err)
				}
				credential := newCredential(t, testCase.providerID,
					testCase.payload(testCase.storeToken("old"), contractNow.Add(-time.Minute)))
				store, accountRef := seedStore(t, testCase.providerID, credential, contractNow.Add(-time.Hour))
				_, err = newResolver(t, store, refresher).
					ForceRefreshCredentialBinding(context.Background(), accountRef)
				if !errors.Is(err, accountcredentials.ErrRefreshUnavailable) {
					t.Fatalf("error = %v", err)
				}
				if calls() != 1 || store.writeCount() != 0 {
					t.Fatalf("calls = %d, writes = %d", calls(), store.writeCount())
				}
				if got := testCase.accessTokenOf(t, store.snapshotOf(t).Credential()); got != testCase.storeToken("old") {
					t.Fatalf("store was mutated: %q", got)
				}
			})

			t.Run("CAS冲突回读", func(t *testing.T) {
				server, calls := startEndpoint(t, http.StatusOK,
					testCase.successBody(testCase.wireToken("refreshed"), contractNow))
				refresher, err := testCase.newRefresher(server.URL, func() time.Time { return contractNow })
				if err != nil {
					t.Fatalf("newRefresher() error = %v", err)
				}
				credential := newCredential(t, testCase.providerID,
					testCase.payload(testCase.storeToken("old"), contractNow.Add(-time.Minute)))
				store, accountRef := seedStore(t, testCase.providerID, credential, contractNow.Add(-time.Hour))
				other := newCredential(t, testCase.providerID,
					testCase.payload(testCase.storeToken("other"), contractNow.Add(2*time.Hour)))
				otherSnapshot, err := accountapp.NewCredentialSnapshot(
					accountRef, testCase.providerID, other, contractNow.Add(time.Second),
				)
				if err != nil {
					t.Fatalf("NewCredentialSnapshot(other) error = %v", err)
				}
				store.conflict = true
				store.conflictWith = otherSnapshot

				result, err := newResolver(t, store, refresher).Resolve(context.Background(), accountRef)
				if err != nil {
					t.Fatalf("Resolve() error = %v", err)
				}
				if result.Refreshed() {
					t.Fatal("conflict must not report a local refresh")
				}
				if calls() != 1 || store.writeCount() != 1 {
					t.Fatalf("calls = %d, writes = %d", calls(), store.writeCount())
				}
				if got := testCase.accessTokenOf(t, result.Credential()); got != testCase.storeToken("other") {
					t.Fatalf("access token = %q", got)
				}
			})
		})
	}
}
