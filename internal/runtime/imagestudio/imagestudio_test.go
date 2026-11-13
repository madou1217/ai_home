package imagestudio

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/images"
	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/modelsdev"
)

// 1x1 PNG pixel (valid header + CRC)
var tinyPNG = func() []byte {
	raw, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=")
	return raw
}()

func TestStoreCRUDRecoveryAndAssetCleanup(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "app-state.db")
	nowTick := time.UnixMilli(1700000000000)

	store, err := NewStore(StoreOptions{
		DatabasePath: dbPath,
		Now: func() time.Time {
			nowTick = nowTick.Add(10 * time.Millisecond)
			return nowTick
		},
	})
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	sess, err := store.CreateSession(ctx, "")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if sess.Title != DefaultSessionTitle || sess.Version != StoreVersion {
		t.Fatalf("unexpected default session: %+v", sess)
	}

	// 开始一个 running 修订 -> 重建 Store 后应自动恢复为 failed / image_studio_run_interrupted (503)
	_, rev, err := store.BeginRevision(ctx, sess.ID, BeginRevisionInput{
		Mode:     "generation",
		Provider: "codex",
		Model:    "gpt-image-2",
		Prompt:   "draw a cat",
	})
	if err != nil {
		t.Fatalf("BeginRevision: %v", err)
	}

	// 运行中删除会话应返回 409
	if _, delErr := store.DeleteSession(ctx, sess.ID); delErr == nil {
		t.Fatalf("expected 409 deleting running session")
	} else {
		var se *Error
		if !errors.As(delErr, &se) || se.StatusCode != 409 || se.Code != "image_session_running" {
			t.Fatalf("unexpected running delete error: %v", delErr)
		}
	}

	// 模拟重启恢复
	reopened, err := NewStore(StoreOptions{DatabasePath: dbPath})
	if err != nil {
		t.Fatalf("reopen NewStore: %v", err)
	}
	recoveredSess, err := reopened.GetSession(ctx, sess.ID)
	if err != nil {
		t.Fatalf("GetSession after recovery: %v", err)
	}
	if len(recoveredSess.Revisions) != 1 ||
		recoveredSess.Revisions[0].ID != rev.ID ||
		recoveredSess.Revisions[0].Status != "failed" ||
		recoveredSess.Revisions[0].Error == nil ||
		recoveredSess.Revisions[0].Error.Code != "image_studio_run_interrupted" ||
		recoveredSess.Revisions[0].Error.StatusCode != 503 {
		t.Fatalf("expected recovered interrupted revision, got %+v", recoveredSess.Revisions)
	}

	// 完成新修订 -> 读取资产 -> 列出摘要 -> 重命名 -> 删除并级联清理资产
	_, rev2, err := reopened.BeginRevision(ctx, sess.ID, BeginRevisionInput{
		Mode:     "generation",
		Provider: "codex",
		Model:    "gpt-image-2",
		Prompt:   "draw a dog",
	})
	if err != nil {
		t.Fatalf("second BeginRevision: %v", err)
	}
	completed, _, err := reopened.CompleteRevision(ctx, sess.ID, rev2.ID, "acct_00000000000000000001", []StoredImage{
		{MIME: "image/png", Bytes: tinyPNG, RevisedPrompt: "a cute dog"},
	})
	if err != nil {
		t.Fatalf("CompleteRevision: %v", err)
	}
	if len(completed.Assets) != 1 {
		t.Fatalf("expected 1 asset, got %d", len(completed.Assets))
	}
	assetID := completed.Assets[0].ID

	assetMeta, rawBytes, err := reopened.ReadAsset(ctx, sess.ID, assetID)
	if err != nil || !bytes.Equal(rawBytes, tinyPNG) || assetMeta.RevisedPrompt != "a cute dog" {
		t.Fatalf("ReadAsset failed: meta=%+v len=%d err=%v", assetMeta, len(rawBytes), err)
	}

	summaries, err := reopened.ListSessions(ctx)
	if err != nil || len(summaries) != 1 || summaries[0].PreviewAssetID != assetID || summaries[0].Title != "draw a cat" {
		t.Fatalf("ListSessions unexpected: %+v err=%v", summaries, err)
	}

	renamed, err := reopened.RenameSession(ctx, sess.ID, "My Gallery")
	if err != nil || renamed.Title != "My Gallery" {
		t.Fatalf("RenameSession unexpected: %+v err=%v", renamed, err)
	}

	if _, err := reopened.DeleteSession(ctx, sess.ID); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	if _, _, readErr := reopened.ReadAsset(ctx, sess.ID, assetID); readErr == nil {
		t.Fatalf("expected asset to be deleted with session")
	}
}

type stubStudioOverviews struct{ items []accountapp.AccountOverview }

func (s stubStudioOverviews) ListAccountOverviews(_ context.Context) ([]accountapp.AccountOverview, error) {
	return s.items, nil
}

type stubStudioModels struct{ cat accountapp.AccountModelCatalog }

func (s stubStudioModels) ListAllAccountModels(_ context.Context) (accountapp.AccountModelCatalog, error) {
	return s.cat, nil
}

type stubStudioElig struct{ blocked bool }

func (s stubStudioElig) CheckEligibility(_ context.Context, _ runtimecore.ModelRoute) (runtimecore.Eligibility, error) {
	if s.blocked {
		return runtimecore.QuotaBlockedEligibility(), nil
	}
	return runtimecore.AvailableEligibility(), nil
}

type stubImageAccountSource struct {
	account images.Account
}

func (s stubImageAccountSource) Candidates(_ context.Context, _ string, _ string, exclude []string) ([]images.Account, error) {
	for _, e := range exclude {
		if e == s.account.AccountRef {
			return nil, errors.New("exhausted")
		}
	}
	return []images.Account{s.account}, nil
}

type stubUsageRecorder struct {
	calls int
}

func (r *stubUsageRecorder) RecordImageUsage(_ context.Context, _ string, _ string, _ inference.Usage, _ time.Time) {
	r.calls++
}

type stubOutcomes struct {
	successes int
	failures  int
}

func (o *stubOutcomes) RecordImageSuccess(_ context.Context, _ string, _ string, _ time.Time) {
	o.successes++
}
func (o *stubOutcomes) RecordImageFailure(_ context.Context, _ string, _ string, _ error) {
	o.failures++
}

func mustStudioAccountOverview(t *testing.T, cat *providers.Catalog, providerID string, subject string, cliID int64) (accountcore.Account, accountapp.AccountOverview) {
	t.Helper()
	now := time.Unix(1700000000, 0).UTC()
	ident, err := accountcore.NewNativeSubjectIdentity(providerID, subject)
	if err != nil {
		t.Fatalf("NewNativeSubjectIdentity: %v", err)
	}
	aliasID, _ := accountcore.NewCLIAccountID(cliID)
	acc, err := accountcore.NewAccount(cat, accountcore.NewAccountInput{
		Identity:     ident,
		CLIAccountID: aliasID,
		CreatedAt:    now,
	})
	if err != nil {
		t.Fatalf("NewAccount: %v", err)
	}
	ov, err := accountapp.NewAccountOverview(accountapp.AccountOverviewInput{
		Account:       acc,
		HasCredential: true,
		AuthKind:      "api_key",
		AuthMode:      "api_key",
	})
	if err != nil {
		t.Fatalf("NewAccountOverview: %v", err)
	}
	return acc, ov
}

func TestServiceCatalogAndExecuteRunAndEdit(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "app-state.db")
	store, err := NewStore(StoreOptions{DatabasePath: dbPath})
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	cat, _ := providers.NewCatalog(providers.BuiltinManifest())
	modalities, _ := modelsdev.New()
	now := time.Unix(1700000000, 0).UTC()
	// 用一个 api-key 账号走 PassthroughStrategy 指向本地 httptest 上游，完成真端到端生成+编辑闭环
	acc, ov := mustStudioAccountOverview(t, cat, "kimi", "studio-relay-1", 10)
	m, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        acc.Ref(),
		ModelID:           "gpt-image-1",
		UpstreamAvailable: true,
		ManualPolicy:      accountapp.ModelPolicyInherit,
		UpdatedAt:         now,
	})
	if err != nil {
		t.Fatalf("NewAccountModel: %v", err)
	}

	b64Tiny := base64.StdEncoding.EncodeToString(tinyPNG)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"created":1700000000,"data":[{"b64_json":"` + b64Tiny + `","revised_prompt":"refined"}],"usage":{"input_tokens":10,"output_tokens":20,"total_tokens":30}}`))
	}))
	defer upstream.Close()

	usageRec := &stubUsageRecorder{}
	outcomes := &stubOutcomes{}
	svc, err := NewService(ServiceDependencies{
		Store: store,
		Catalog: CatalogDependencies{
			Accounts: stubStudioOverviews{items: []accountapp.AccountOverview{ov}},
			AccountModels: stubStudioModels{cat: accountapp.AccountModelCatalog{
				Sets: []accountapp.AccountModelSet{
					{AccountRef: acc.Ref(), ProviderID: "kimi", Models: []accountapp.AccountModel{m}},
				},
			}},
			Runtime:    stubStudioElig{},
			Providers:  cat,
			Modalities: modalities,
		},
		Registry: images.NewRegistry("", "", images.NewFetcher(upstream.Client())),
		Accounts: stubImageAccountSource{account: images.Account{
			Provider:   "kimi",
			AccountRef: acc.Ref().String(),
			APIKey:     "relay-key",
			BaseURL:    upstream.URL,
			APIKeyMode: true,
		}},
		HTTP:     upstream.Client(),
		Usage:    usageRec,
		Outcomes: outcomes,
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	models, defKey, err := svc.ListModels(ctx, "")
	if err != nil || len(models) != 1 || defKey != "kimi:gpt-image-1" || models[0].AvailableAccountCount != 1 {
		t.Fatalf("ListModels unexpected: models=%+v defKey=%q err=%v", models, defKey, err)
	}

	sess, err := store.CreateSession(ctx, "")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// 1. 生成运行
	genRes, err := svc.ExecuteRun(ctx, sess.ID, RunRequest{
		ModelKey: defKey,
		Mode:     "generation",
		Prompt:   "a neon city",
	})
	if err != nil {
		t.Fatalf("ExecuteRun generation: %v", err)
	}
	if len(genRes.Session.Assets) != 1 || genRes.Session.Revisions[0].Status != "succeeded" || usageRec.calls != 1 || outcomes.successes != 1 {
		t.Fatalf("generation result unexpected: sess=%+v usage=%d outcomes=%+v", genRes.Session, usageRec.calls, outcomes)
	}
	firstAssetID := genRes.Session.Assets[0].ID

	// 2. 基于产出的资产进行 edit 运行
	editRes, err := svc.ExecuteRun(ctx, sess.ID, RunRequest{
		ModelKey:         defKey,
		Mode:             "edit",
		Prompt:           "add rain",
		ParentRevisionID: genRes.RevisionID,
		Sources:          []RunSourceInput{{AssetID: firstAssetID}},
		HasSources:       true,
	})
	if err != nil {
		t.Fatalf("ExecuteRun edit: %v", err)
	}
	if len(editRes.Session.Revisions) != 2 || len(editRes.Session.Assets) != 2 || editRes.Session.Revisions[1].Status != "succeeded" {
		t.Fatalf("edit result unexpected: %+v", editRes.Session)
	}

	// 3. generation 模式误传源图 -> 400 image_input_requires_edit
	_, badErr := svc.ExecuteRun(ctx, sess.ID, RunRequest{
		ModelKey:      defKey,
		Mode:          "generation",
		Prompt:        "should fail",
		SourceAssetID: firstAssetID,
	})
	var se *Error
	if !errors.As(badErr, &se) || se.StatusCode != 400 || se.Code != "image_input_requires_edit" {
		t.Fatalf("expected 400 image_input_requires_edit, got %v", badErr)
	}

	// 4. 远端私有地址回取拦阻 (MaterializeOutputs SSRF guard)
	privateSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(tinyPNG)
	}))
	defer privateSrv.Close()
	_, fetchErr := MaterializeOutputs(ctx, images.Execution{
		Result: images.Result{Images: []images.GeneratedImage{{URL: privateSrv.URL + "/pic.png"}}},
	}, images.NewFetcher(nil), 5*time.Second)
	var fetchSE *Error
	if !errors.As(fetchErr, &fetchSE) || fetchSE.Code != "image_asset_url_blocked" {
		t.Fatalf("expected private URL SSRF block image_asset_url_blocked, got %v", fetchErr)
	}
}
