package codeassist

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/agyoauth"
	runtimeinmemory "github.com/madou1217/ai_home/internal/adapters/accountruntime/inmemory"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	_ "modernc.org/sqlite"
)

const (
	realAgySmokeEnv        = "AIH_REAL_AGY_SMOKE"
	realAgyNodeDBEnv       = "AIH_REAL_AGY_NODE_DB"
	realAgyAccountRefEnv   = "AIH_REAL_AGY_ACCOUNT_REF"
	realAgyModel           = "claude-opus-4-6-thinking"
	realAgyExpected        = "GO_AGY_OK"
	realAgyRequestTimeout  = 30 * time.Second
	realAgyHTTPTimeout     = 25 * time.Second
	realAgyMaxNetworkCalls = 5
)

// TestLiveAgyCanonicalSmoke 只在显式授权下从 Node DB 只读一个指定 AGY 账号，
// 将其注册到临时 Go DB，并走凭据过期刷新、征召、Code Assist 和 Canonical 解码。
// 凭据从不进入参数、日志或仓库文件。
func TestLiveAgyCanonicalSmoke(t *testing.T) {
	if os.Getenv(realAgySmokeEnv) != "1" {
		t.Skip("set AIH_REAL_AGY_SMOKE=1 after explicit upstream authorization")
	}
	nodeDB := strings.TrimSpace(os.Getenv(realAgyNodeDBEnv))
	selectedRef, err := accountcore.ParseAccountRef(
		strings.TrimSpace(os.Getenv(realAgyAccountRefEnv)),
	)
	if nodeDB == "" || err != nil {
		t.Fatal("live AGY smoke requires a Node DB path and one canonical AccountRef")
	}
	auth := loadLiveAgyCredential(t, nodeDB, selectedRef)
	derivedRef, err := accountcore.DeriveAccountRef(auth)
	if err != nil || derivedRef != selectedRef {
		t.Fatalf("selected account identity mismatch: derived=%s selected=%s", derivedRef, selectedRef)
	}

	ctx, cancel := context.WithTimeout(context.Background(), realAgyRequestTimeout)
	defer cancel()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
		AIHomeDir: t.TempDir(),
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("sqliteaccount.Open() error = %v", err)
	}
	defer store.Close()
	registrar, err := accountapp.NewRegistrar(catalog, store, time.Now)
	if err != nil {
		t.Fatalf("accountapp.NewRegistrar() error = %v", err)
	}
	account, err := registrar.Register(ctx, auth, nil)
	if err != nil {
		t.Fatalf("Registrar.Register() error = %v", err)
	}
	client := &liveAgyBoundedClient{client: &http.Client{Timeout: realAgyHTTPTimeout}}
	refreshStrategy, err := agyoauth.New(client)
	if err != nil {
		t.Fatalf("agyoauth.New() error = %v", err)
	}
	credentials, err := accountcredentials.NewResolver(accountcredentials.Dependencies{
		Store:      store,
		Strategies: []accountcredentials.RefreshStrategy{refreshStrategy},
		Clock:      time.Now,
	})
	if err != nil {
		t.Fatalf("accountcredentials.NewResolver() error = %v", err)
	}
	binding, err := credentials.ResolveCredentialBinding(ctx, account.Ref())
	if err != nil {
		t.Fatalf("ResolveCredentialBinding() error = %v", err)
	}
	modelSource, err := NewModelCatalogSource(client)
	if err != nil {
		t.Fatalf("NewModelCatalogSource() error = %v", err)
	}
	discoveredModels, err := modelSource.DiscoverModels(ctx, binding.Credential())
	if err != nil {
		t.Fatalf(
			"DiscoverModels() error = %v; statuses=%v shape=%s",
			err,
			client.Statuses(),
			client.CatalogShape(),
		)
	}
	modelIDs := make([]runtimecore.ModelID, 0, len(discoveredModels))
	foundTarget := false
	for _, discoveredModel := range discoveredModels {
		modelID, modelErr := runtimecore.NewModelID(discoveredModel)
		if modelErr != nil {
			t.Fatalf("runtimecore.NewModelID(%q) error = %v", discoveredModel, modelErr)
		}
		modelIDs = append(modelIDs, modelID)
		foundTarget = foundTarget || discoveredModel == realAgyModel
	}
	if !foundTarget {
		t.Fatalf("live AGY catalog omitted target model %s", realAgyModel)
	}
	if _, err := store.ReplaceDiscoveredModels(
		ctx,
		account.Ref(),
		modelIDs,
		time.UnixMilli(time.Now().UnixMilli()).UTC(),
	); err != nil {
		t.Fatalf("ReplaceDiscoveredModels() error = %v", err)
	}
	modelID, err := runtimecore.NewModelID(realAgyModel)
	if err != nil {
		t.Fatalf("runtimecore.NewModelID() error = %v", err)
	}
	runtime, err := runtimeinmemory.New(time.Now)
	if err != nil {
		t.Fatalf("runtimeinmemory.New() error = %v", err)
	}
	recruiter, err := accountrouting.NewRecruiter(accountrouting.Dependencies{
		Candidates:  store,
		Runtime:     runtime,
		Credentials: credentials,
	})
	if err != nil {
		t.Fatalf("accountrouting.NewRecruiter() error = %v", err)
	}
	adapter, err := NewAdapter(client, time.Now)
	if err != nil {
		t.Fatalf("codeassist.NewAdapter() error = %v", err)
	}
	route, err := adapter.BuildRoute(modelID)
	if err != nil {
		t.Fatalf("BuildRoute() error = %v", err)
	}
	upstreams, err := inferencegateway.NewUpstreamRegistry(adapter)
	if err != nil {
		t.Fatalf("NewUpstreamRegistry() error = %v", err)
	}
	coordinator, err := inferencegateway.NewCoordinator(inferencegateway.Dependencies{
		Catalog:                catalog,
		Routes:                 liveAgyRouteResolver{route: route},
		Recruiter:              recruiter,
		Upstreams:              upstreams,
		Attempts:               runtime,
		CredentialObservations: credentials,
		Clock:                  time.Now,
		ModelRefreshes:         liveAgyNoopRefreshScheduler{},
		UpstreamAttemptLimit:   1,
	})
	if err != nil {
		t.Fatalf("inferencegateway.NewCoordinator() error = %v", err)
	}
	text, _ := inference.NewTextContent("Reply with exactly GO_AGY_OK and nothing else.")
	message, _ := inference.NewMessage(inference.RoleUser, text)
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol:  inference.ClientProtocolAnthropicMessages,
		Model:           realAgyModel,
		Messages:        []inference.Message{message},
		Stream:          true,
		MaxOutputTokens: 16,
	})
	if err != nil {
		t.Fatalf("inference.NewRequest() error = %v", err)
	}
	var answer strings.Builder
	var completed bool
	var failure inference.ResponseFailure
	eventKinds := make([]inference.EventKind, 0, 8)
	if err := coordinator.Execute(ctx, request, func(event inference.StreamEvent) error {
		eventKinds = append(eventKinds, event.Kind())
		switch typed := event.(type) {
		case inference.TextDeltaEvent:
			answer.WriteString(typed.Delta())
		case inference.ResponseCompletedEvent:
			completed = true
		case inference.ResponseFailedEvent:
			failure = typed.Failure()
		}
		return nil
	}); err != nil {
		t.Fatalf("Coordinator.Execute() error = %v", err)
	}
	counts := client.Counts()
	if strings.TrimSpace(answer.String()) != realAgyExpected || !completed {
		t.Fatalf(
			"answer=%q completed=%t failure=%s/%q events=%v calls=%#v statuses=%v, want %q",
			answer.String(),
			completed,
			failure.Code(),
			failure.SafeMessage(),
			eventKinds,
			counts,
			client.Statuses(),
			realAgyExpected,
		)
	}
	if counts.oauth > 1 || counts.load != 2 || counts.catalog != 1 ||
		counts.stream != 1 || counts.total != 4+counts.oauth {
		t.Fatalf(
			"network call counts = %#v, want oauth=0..1 load=2 catalog=1 stream=1 total=4+oauth",
			counts,
		)
	}
	t.Logf(
		"live AGY smoke passed account=%s model=%s discovered=%d calls=%d answer=%s",
		selectedRef,
		realAgyModel,
		len(discoveredModels),
		counts.total,
		realAgyExpected,
	)
}

type liveAgyNativeCredential struct {
	Email      string `json:"email"`
	OAuthToken struct {
		Token struct {
			AccessToken  string `json:"access_token"`
			TokenType    string `json:"token_type"`
			RefreshToken string `json:"refresh_token"`
			Expiry       string `json:"expiry"`
		} `json:"token"`
		AuthMethod  string `json:"auth_method"`
		LastRefresh string `json:"last_refresh"`
	} `json:"oauthToken"`
}

func loadLiveAgyCredential(
	t testing.TB,
	databasePath string,
	accountRef accountcore.AccountRef,
) *agy.OAuthAuth {
	t.Helper()
	absolute, err := filepath.Abs(databasePath)
	if err != nil {
		t.Fatalf("invalid Node DB path: %v", err)
	}
	databaseURL := &url.URL{Scheme: "file", Path: filepath.ToSlash(absolute)}
	query := databaseURL.Query()
	query.Set("mode", "ro")
	databaseURL.RawQuery = query.Encode()
	database, err := sql.Open("sqlite", databaseURL.String())
	if err != nil {
		t.Fatalf("open Node DB error = %v", err)
	}
	defer database.Close()
	var payload string
	err = database.QueryRow(
		`SELECT native_auth_json FROM account_credentials WHERE account_ref = ?`,
		accountRef.String(),
	).Scan(&payload)
	if err != nil {
		t.Fatalf("read selected AGY credential error = %v", err)
	}
	decoder := json.NewDecoder(strings.NewReader(payload))
	decoder.DisallowUnknownFields()
	var document liveAgyNativeCredential
	if err := decoder.Decode(&document); err != nil {
		t.Fatalf("decode selected AGY credential error = %v", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		t.Fatal("selected AGY credential contains trailing JSON")
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, document.OAuthToken.Token.Expiry)
	if err != nil {
		t.Fatalf("parse AGY expiry error = %v", err)
	}
	refreshedAt, err := time.Parse(time.RFC3339Nano, document.OAuthToken.LastRefresh)
	if err != nil {
		t.Fatalf("parse AGY last refresh error = %v", err)
	}
	auth, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         document.Email,
		AccessToken:   document.OAuthToken.Token.AccessToken,
		RefreshToken:  document.OAuthToken.Token.RefreshToken,
		ExpiresAtMS:   expiresAt.UnixMilli(),
		RefreshedAtMS: refreshedAt.UnixMilli(),
		TokenType:     document.OAuthToken.Token.TokenType,
		AuthMethod:    agy.AuthMethod(document.OAuthToken.AuthMethod),
	})
	if err != nil {
		t.Fatalf("construct selected AGY credential error = %v", err)
	}
	return auth
}

type liveAgyCallCounts struct {
	total   int
	oauth   int
	load    int
	catalog int
	stream  int
}

type liveAgyBoundedClient struct {
	mu           sync.Mutex
	client       *http.Client
	counts       liveAgyCallCounts
	statuses     []int
	catalogShape string
}

func (client *liveAgyBoundedClient) Do(request *http.Request) (*http.Response, error) {
	if client == nil || client.client == nil || request == nil || request.URL == nil {
		return nil, errors.New("invalid live AGY request")
	}
	kind := ""
	switch {
	case request.URL.Scheme == "https" && request.URL.Host == "oauth2.googleapis.com" && request.URL.Path == "/token":
		kind = "oauth"
	case request.URL.Scheme == "https" && request.URL.Host == "daily-cloudcode-pa.googleapis.com" && strings.HasSuffix(request.URL.Path, ":loadCodeAssist"):
		kind = "load"
	case request.URL.Scheme == "https" && request.URL.Host == "daily-cloudcode-pa.googleapis.com" && strings.HasSuffix(request.URL.Path, ":fetchAvailableModels"):
		kind = "catalog"
	case request.URL.Scheme == "https" && request.URL.Host == "daily-cloudcode-pa.googleapis.com" && strings.HasSuffix(request.URL.Path, ":streamGenerateContent"):
		kind = "stream"
	default:
		return nil, errors.New("live AGY request target rejected")
	}
	beta := strings.TrimSpace(request.Header.Get("anthropic-beta"))
	if kind == "stream" && beta != "claude-code-20250219" {
		return nil, errors.New("live AGY Claude inference omitted beta header")
	}
	if (kind == "load" || kind == "catalog") && beta != "" {
		return nil, errors.New("live AGY discovery leaked Claude beta header")
	}
	client.mu.Lock()
	if client.counts.total >= realAgyMaxNetworkCalls {
		client.mu.Unlock()
		return nil, errors.New("live AGY network budget exhausted")
	}
	client.counts.total++
	switch kind {
	case "oauth":
		client.counts.oauth++
	case "load":
		client.counts.load++
	case "catalog":
		client.counts.catalog++
	case "stream":
		client.counts.stream++
	}
	client.mu.Unlock()
	response, err := client.client.Do(request)
	if kind == "catalog" && response != nil && response.Body != nil {
		payload, readErr := io.ReadAll(io.LimitReader(response.Body, maxModelCatalogBytes+1))
		_ = response.Body.Close()
		response.Body = io.NopCloser(strings.NewReader(string(payload)))
		if readErr == nil && len(payload) <= maxModelCatalogBytes {
			client.mu.Lock()
			client.catalogShape = summarizeLiveCatalogShape(payload)
			client.mu.Unlock()
		}
	}
	if response != nil {
		client.mu.Lock()
		client.statuses = append(client.statuses, response.StatusCode)
		client.mu.Unlock()
	}
	return response, err
}

func summarizeLiveCatalogShape(payload []byte) string {
	var document map[string]json.RawMessage
	if err := json.Unmarshal(payload, &document); err != nil {
		return "invalid_json"
	}
	topLevel := make([]string, 0, len(document))
	for key := range document {
		topLevel = append(topLevel, key)
	}
	sort.Strings(topLevel)
	modelFields := make(map[string]struct{})
	var models map[string]map[string]json.RawMessage
	if err := json.Unmarshal(document["models"], &models); err == nil {
		for _, detail := range models {
			for key := range detail {
				modelFields[key] = struct{}{}
			}
		}
	}
	detailKeys := make([]string, 0, len(modelFields))
	for key := range modelFields {
		detailKeys = append(detailKeys, key)
	}
	sort.Strings(detailKeys)
	return fmt.Sprintf("top=%v detail=%v", topLevel, detailKeys)
}

func (client *liveAgyBoundedClient) Statuses() []int {
	client.mu.Lock()
	defer client.mu.Unlock()
	return append([]int(nil), client.statuses...)
}

func (client *liveAgyBoundedClient) Counts() liveAgyCallCounts {
	client.mu.Lock()
	defer client.mu.Unlock()
	return client.counts
}

func (client *liveAgyBoundedClient) CatalogShape() string {
	client.mu.Lock()
	defer client.mu.Unlock()
	return client.catalogShape
}

type liveAgyRouteResolver struct{ route inferencegateway.Route }

func (resolver liveAgyRouteResolver) Resolve(
	context.Context,
	inference.Request,
) (inferencegateway.RoutePlan, error) {
	return inferencegateway.NewRoutePlan(resolver.route)
}

type liveAgyNoopRefreshScheduler struct{}

func (liveAgyNoopRefreshScheduler) ScheduleModelRefresh(
	context.Context,
	accountcore.AccountRef,
	string,
) error {
	return nil
}
