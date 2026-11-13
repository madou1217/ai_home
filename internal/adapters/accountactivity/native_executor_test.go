package accountactivity

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

func writeInvalidURLBinding(t *testing.T, aiHomeDir, accountRef string) {
	t.Helper()
	dbPath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		t.Fatal(err)
	}
	// mode="url" with empty proxyUrl causes agyegress.Resolver to fail closed!
	if err := appstate.WriteKV(context.Background(), dbPath, "account:egress:"+accountRef, `{"mode":"url","proxyUrl":""}`, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
}

func TestNativeExecutor_DispatchErrorsAndEgressFailClosed(t *testing.T) {
	var nilExec *NativeExecutor
	if _, err := nilExec.Execute(context.Background(), ExecutionRequest{}); !errors.Is(err, ErrExecutorUnavailable) {
		t.Fatalf("nil Execute err = %v, want ErrExecutorUnavailable", err)
	}

	exec := NewNativeExecutor(NativeExecutorOptions{
		AIHomeDir: t.TempDir(),
		RecordLoader: func(ctx context.Context, provider, accountRef string) (AccountRecord, bool, error) {
			return AccountRecord{}, false, nil
		},
	})
	unknownRes, err := exec.Execute(context.Background(), ExecutionRequest{
		Provider:   "qoder",
		AccountRef: "acct_11111111111111111111",
		ActionID:   "unknown_action",
	})
	if err != nil || unknownRes["error"] != "activity_action_unknown:qoder:unknown_action" {
		t.Fatalf("unknown action res = %v err=%v", unknownRes, err)
	}

	missingRes, err := exec.Execute(context.Background(), ExecutionRequest{
		Provider:   "qoder",
		AccountRef: "acct_11111111111111111111",
		ActionID:   "daily_checkin",
	})
	if err != nil || missingRes["error"] != "account_not_found" {
		t.Fatalf("missing account res = %v err=%v", missingRes, err)
	}

	// Custom HTTPClientForAccount returning an error must fail closed without touching upstream.
	egressExec := NewNativeExecutor(NativeExecutorOptions{
		AIHomeDir: t.TempDir(),
		RecordLoader: func(ctx context.Context, provider, accountRef string) (AccountRecord, bool, error) {
			return AccountRecord{
				Provider:   provider,
				AccountRef: accountRef,
				Env:        map[string]string{"QODER_PERSONAL_ACCESS_TOKEN": "pat-123"},
				NativeAuth: map[string]any{"machineId": "m-1"},
			}, true, nil
		},
		QoderIdentityReader: func(provider, accountRef string) *QoderDeviceIdentity {
			return &QoderDeviceIdentity{MachineToken: "mt", MachineCode: "mc", MachineType: "macOS"}
		},
		HTTPClientForAccount: func(ctx context.Context, provider, accountRef string) (HTTPDoer, error) {
			return nil, errors.New("proxy_pool_empty")
		},
	})
	egressRes, err := egressExec.Execute(context.Background(), ExecutionRequest{
		Provider:   "qoder",
		AccountRef: "acct_11111111111111111111",
		ActionID:   "daily_checkin",
	})
	if err != nil || egressRes["error"] != "account_egress_unavailable:proxy_pool_empty" {
		t.Fatalf("egress fail-closed res = %v err=%v", egressRes, err)
	}

	// Real agyegress.Resolver with malformed binding fails closed too!
	aiHome := t.TempDir()
	const ref = "acct_22222222222222222222"
	writeInvalidURLBinding(t, aiHome, ref)
	realEgressExec := NewNativeExecutor(NativeExecutorOptions{
		AIHomeDir: aiHome,
		RecordLoader: func(ctx context.Context, provider, accountRef string) (AccountRecord, bool, error) {
			return AccountRecord{
				Provider:   provider,
				AccountRef: accountRef,
				Env:        map[string]string{"QODER_PERSONAL_ACCESS_TOKEN": "pat-123"},
				NativeAuth: map[string]any{"machineId": "m-1"},
			}, true, nil
		},
		QoderIdentityReader: func(provider, accountRef string) *QoderDeviceIdentity {
			return &QoderDeviceIdentity{MachineToken: "mt", MachineCode: "mc", MachineType: "macOS"}
		},
	})
	realRes, err := realEgressExec.Execute(context.Background(), ExecutionRequest{
		Provider:   "qoder",
		AccountRef: ref,
		ActionID:   "daily_checkin",
	})
	if err != nil || !strings.HasPrefix(textOf(realRes["error"]), "account_egress_unavailable:") {
		t.Fatalf("real agyegress fail-closed res = %v err=%v", realRes, err)
	}
}

func TestNativeExecutor_QoderDailyFlows(t *testing.T) {
	const ref = "acct_aaaaaaaaaaaaaaaaaaaa"
	var handlerFunc atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := handlerFunc.Load().(http.HandlerFunc)
		h(w, r)
	}))
	defer srv.Close()

	var claimedCallbackCount atomic.Int32
	baseRecord := AccountRecord{
		Provider:   "qoder",
		AccountRef: ref,
		Env:        map[string]string{"QODER_PERSONAL_ACCESS_TOKEN": "pat-qoder"},
		NativeAuth: map[string]any{"machineId": "machine-abc"},
	}
	exec := NewNativeExecutor(NativeExecutorOptions{
		BaseURLs: map[string]string{"qoder": srv.URL},
		RecordLoader: func(ctx context.Context, provider, accountRef string) (AccountRecord, bool, error) {
			return baseRecord, true, nil
		},
		QoderIdentityReader: func(provider, accountRef string) *QoderDeviceIdentity {
			return &QoderDeviceIdentity{MachineToken: "mt-1", MachineCode: "mc-1", MachineType: "macOS"}
		},
		HTTPClientForAccount: func(ctx context.Context, provider, accountRef string) (HTTPDoer, error) {
			return srv.Client(), nil
		},
		OnClaimed: func(ctx context.Context, provider, accountRef string, result map[string]any) {
			claimedCallbackCount.Add(1)
		},
	})

	// 1. 401 -> qoder_auth_invalid:401 + auth=true
	handlerFunc.Store(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"message":"unauthorized"}`))
	}))
	res, err := exec.Execute(context.Background(), ExecutionRequest{Provider: "qoder", AccountRef: ref, ActionID: "daily_checkin"})
	if err != nil || res["error"] != "qoder_auth_invalid:401" || res["auth"] != true {
		t.Fatalf("401 res = %v err=%v", res, err)
	}

	// 2. CLAIM_BENEFIT present, none CLAIMABLE -> already_claimed
	handlerFunc.Store(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"campaigns":[{"campaignId":"c1","actionType":"CLAIM_BENEFIT","claimStatus":"CLAIMED"}]}`))
	}))
	res, _ = exec.Execute(context.Background(), ExecutionRequest{Provider: "qoder", AccountRef: ref, ActionID: "daily_checkin"})
	if res["status"] != StatusAlreadyClaimed {
		t.Fatalf("already_claimed res = %v", res)
	}

	// 3. DryRun with CLAIMABLE -> dry_run & no POST
	var postCount atomic.Int32
	handlerFunc.Store(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			postCount.Add(1)
		}
		_, _ = w.Write([]byte(`{"campaigns":[{"campaignId":"c1","actionType":"CLAIM_BENEFIT","claimStatus":"CLAIMABLE","benefit":{"kind":"CREDITS","amount":50,"validity":{"days":7}}}]}`))
	}))
	res, _ = exec.Execute(context.Background(), ExecutionRequest{Provider: "qoder", AccountRef: ref, ActionID: "daily_checkin", DryRun: true})
	if res["status"] != StatusDryRun || postCount.Load() != 0 {
		t.Fatalf("dry_run res = %v postCount=%d", res, postCount.Load())
	}

	// 4. Full Claim: verifies headers, URL path escaping, partial claim aggregation
	handlerFunc.Store(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer pat-qoder" || r.Header.Get("Cosy-MachineToken") != "mt-1" {
			t.Errorf("unexpected headers: %v", r.Header)
		}
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`{"campaigns":[
				{"campaignId":"c/1","actionType":"CLAIM_BENEFIT","claimStatus":"CLAIMABLE","benefit":{"amount":30,"validity":{"days":7}}},
				{"campaignId":"c2","actionType":"CLAIM_BENEFIT","claimStatus":"CLAIMABLE","benefit":{"amount":20}}
			]}`))
			return
		}
		if strings.Contains(r.URL.EscapedPath(), "c%2F1/claim") {
			_, _ = w.Write([]byte(`{"success":true}`))
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"message":"upstream_fail"}`))
	}))
	res, _ = exec.Execute(context.Background(), ExecutionRequest{Provider: "qoder", AccountRef: ref, ActionID: "daily_checkin"})
	if res["status"] != StatusClaimed || toFloat64(res["credits"]) != 30 {
		t.Fatalf("claim res = %v", res)
	}
	if claimedCallbackCount.Load() != 4 {
		t.Fatalf("OnClaimed count = %d, want 4", claimedCallbackCount.Load())
	}
}

func TestNativeExecutor_WorkbuddyDailyFlows(t *testing.T) {
	const ref = "acct_bbbbbbbbbbbbbbbbbbbb"
	const uid = "u-wb-1"
	now := time.Now().UnixMilli()
	jwt := makeTestJWT(t, map[string]any{
		"iss": "https://copilot.tencent.com/auth/realms/copilot",
		"sub": uid,
		"iat": float64(now/1000 - 60),
		"exp": float64(now/1000 + 3600),
	})

	var handler atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.Load().(http.HandlerFunc)(w, r)
	}))
	defer srv.Close()

	exec := NewNativeExecutor(NativeExecutorOptions{
		AIHomeDir:   t.TempDir(),
		HostHomeDir: t.TempDir(),
		BaseURLs:    map[string]string{"workbuddycn": srv.URL},
		RecordLoader: func(ctx context.Context, provider, accountRef string) (AccountRecord, bool, error) {
			return AccountRecord{
				Provider:   provider,
				AccountRef: accountRef,
				NativeAuth: map[string]any{
					"credentials": map[string]any{
						"auth":    map[string]any{"accessToken": jwt, "refreshToken": "r1"},
						"account": map[string]any{"uid": uid, "enterpriseId": "ent-42"},
					},
				},
			}, true, nil
		},
		HTTPClientForAccount: func(ctx context.Context, provider, accountRef string) (HTTPDoer, error) {
			return srv.Client(), nil
		},
	})

	// 1. Inactive -> nothing_claimable
	handler.Store(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"code":0,"data":{"active":false}}`))
	}))
	res, _ := exec.Execute(context.Background(), ExecutionRequest{Provider: "workbuddycn", AccountRef: ref, ActionID: "daily_checkin"})
	if res["status"] != StatusNothingClaimable {
		t.Fatalf("inactive res = %v", res)
	}

	// 2. Today already checked in -> already_claimed
	handler.Store(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"code":0,"data":{"active":true,"today_checked_in":true,"streak_days":5}}`))
	}))
	res, _ = exec.Execute(context.Background(), ExecutionRequest{Provider: "workbuddycn", AccountRef: ref, ActionID: "daily_checkin"})
	if res["status"] != StatusAlreadyClaimed || toFloat64(res["streakDays"]) != 5 {
		t.Fatalf("todayCheckedIn res = %v", res)
	}

	// 3. DryRun -> dry_run
	handler.Store(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"code":0,"data":{"active":true,"today_checked_in":false,"daily_credit":80,"streak_days":2,"activity_name":"Daily"}}`))
	}))
	res, _ = exec.Execute(context.Background(), ExecutionRequest{Provider: "workbuddycn", AccountRef: ref, ActionID: "daily_checkin", DryRun: true})
	if res["status"] != StatusDryRun {
		t.Fatalf("dryRun res = %v", res)
	}

	// 4. Full Claim -> verifies enterprise/tenant headers + claimed credits
	handler.Store(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Enterprise-Id") != "ent-42" || r.Header.Get("X-Tenant-Id") != "ent-42" || r.Header.Get("X-User-Id") != uid {
			t.Errorf("missing enterprise headers: %v", r.Header)
		}
		if r.URL.Path == workbuddyCheckinStatusPath {
			_, _ = w.Write([]byte(`{"code":0,"data":{"active":true,"today_checked_in":false,"daily_credit":80,"streak_days":2}}`))
			return
		}
		_, _ = w.Write([]byte(`{"code":0,"data":{"credit":120,"streak_days":3,"is_streak_day":true}}`))
	}))
	res, _ = exec.Execute(context.Background(), ExecutionRequest{Provider: "workbuddycn", AccountRef: ref, ActionID: "daily_checkin"})
	if res["status"] != StatusClaimed || toFloat64(res["credits"]) != 120 || res["isStreakDay"] != true {
		t.Fatalf("claim res = %v", res)
	}

	// 5. Biz status 1001 & 1999
	handler.Store(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == workbuddyCheckinStatusPath {
			_, _ = w.Write([]byte(`{"code":0,"data":{"active":true,"today_checked_in":false}}`))
			return
		}
		_, _ = w.Write([]byte(`{"code":1001,"msg":"already done"}`))
	}))
	res, _ = exec.Execute(context.Background(), ExecutionRequest{Provider: "workbuddycn", AccountRef: ref, ActionID: "daily_checkin"})
	if res["status"] != StatusAlreadyClaimed || res["message"] != "already done" {
		t.Fatalf("biz 1001 res = %v", res)
	}
}

func TestNativeExecutor_ZcodePlanFlowsAndCaptchaRetry(t *testing.T) {
	const ref = "acct_cccccccccccccccccccc"
	var mode atomic.Value
	var captchaRequests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m := mode.Load().(string)
		switch r.URL.Path {
		case zcodePlanPreviewPath:
			switch m {
			case "preview_plans":
				_, _ = w.Write([]byte(`{"code":0,"data":{"plans":[
					{"plan_id":"zcode-v3-start-plan-1030-wk","name":"Weekend Build","priority":5,"entitlements":["a"]},
					{"plan_id":"start-top","name":"Start Plan","priority":20,"entitlements":["a","b"]}
				]}}`))
			case "marketing_touch", "balance_held", "slow_body":
				_, _ = w.Write([]byte(`{"code":0,"data":null}`))
			case "captcha_success", "captcha_reject", "already_claimed_msg", "plan_not_found":
				_, _ = w.Write([]byte(`{"code":0,"data":{"plans":[{"plan_id":"zcode-v3-start-plan-1102-wk","name":"Weekend Build","priority":10}]}}`))
			}
		case zcodeMarketingTouchPath:
			if m == "marketing_touch" {
				_, _ = w.Write([]byte(`{"code":0,"data":{"deliveries":[
					{"resource_position":"popup","campaign_id":"cmp-1","priority":15,"popup":{"buttons":[{"action":{"type":"claim_zcode_plan","args":{"plan_id":"mkt-weekend-1"}}}]}},
					{"resource_position":"popup","campaign_id":"cmp-dup","priority":99,"popup":{"buttons":[{"action":{"type":"claim_zcode_plan","args":{"plan_id":"mkt-dup"}}}]}}
				]}}`))
				return
			}
			_, _ = w.Write([]byte(`{"code":0,"data":{"deliveries":[]}}`))
		case zcodePlanBalancePath:
			if m == "balance_held" {
				_, _ = w.Write([]byte(`{"code":0,"data":{"plans":[{"plan_id":"held-1","name":"Weekend Build"}]}}`))
				return
			}
			_, _ = w.Write([]byte(`{"code":0,"data":{"plans":[]}}`))
		case zcodeClientConfigsPath:
			_, _ = w.Write([]byte(`{"code":0,"data":{"configs":{"captcha":{"enabled":true,"prefix":"pref-1","region":"cn","sceneId":"scene-1"}}}}`))
		case zcodePlanClaimPath:
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			switch m {
			case "preview_plans":
				if body["plan_id"] != "zcode-v3-start-plan-1030-wk" {
					t.Errorf("expected weekend_build plan weekend-low, got %v", body["plan_id"])
				}
				_, _ = w.Write([]byte(`{"code":0,"data":{"claimed":true}}`))
			case "marketing_touch":
				_, _ = w.Write([]byte(`{"code":200}`))
			case "captcha_success":
				if r.Header.Get("X-Aliyun-Captcha-Verify-Param") == "" {
					_, _ = w.Write([]byte(`{"code":3007,"message":"captcha required"}`))
					return
				}
				if r.Header.Get("X-Aliyun-Captcha-Verify-Param") != "solved-param-ok" || r.Header.Get("X-Aliyun-Captcha-Verify-Region") != "cn" {
					t.Errorf("unexpected captcha headers: %v", r.Header)
				}
				_, _ = w.Write([]byte(`{"code":0}`))
			case "captcha_reject":
				_, _ = w.Write([]byte(`{"code":3007,"message":"captcha bad"}`))
			case "already_claimed_msg":
				_, _ = w.Write([]byte(`{"code":1999,"message":"该活动奖励已领取"}`))
			case "plan_not_found":
				_, _ = w.Write([]byte(`{"code":1001,"message":"not found"}`))
			}
		}
	}))
	defer srv.Close()

	// 1. Static API key only -> not_applicable
	staticExec := NewNativeExecutor(NativeExecutorOptions{
		AIHomeDir:    t.TempDir(),
		ZcodeBaseURL: srv.URL,
		RecordLoader: func(ctx context.Context, provider, accountRef string) (AccountRecord, bool, error) {
			return AccountRecord{Provider: "zcode", AccountRef: accountRef, Env: map[string]string{"ZCODE_API_KEY": "sk-123"}}, true, nil
		},
	})
	res, err := staticExec.Execute(context.Background(), ExecutionRequest{Provider: "zcode", AccountRef: ref, ActionID: "trial_plan"})
	if err != nil || res["status"] != StatusNotApplicable {
		t.Fatalf("static key res = %v err=%v", res, err)
	}

	exec := NewNativeExecutor(NativeExecutorOptions{
		AIHomeDir:             t.TempDir(),
		HostHomeDir:           t.TempDir(),
		ZcodeBaseURL:          srv.URL,
		ZcodeAppVersion:       "3.17.0",
		DisableVersionRefresh: true,
		RecordLoader: func(ctx context.Context, provider, accountRef string) (AccountRecord, bool, error) {
			return AccountRecord{
				Provider:   "zcode",
				AccountRef: accountRef,
				NativeAuth: map[string]any{"zcodejwttoken": "jwt-zcode"},
			}, true, nil
		},
		HTTPClientForAccount: func(ctx context.Context, provider, accountRef string) (HTTPDoer, error) {
			return srv.Client(), nil
		},
		CaptchaSolver: func(ctx context.Context, req CaptchaSolveRequest) (string, error) {
			captchaRequests.Add(1)
			if req.SceneID != "scene-1" || req.Prefix != "pref-1" {
				t.Errorf("unexpected captcha req = %+v", req)
			}
			return "solved-param-ok", nil
		},
	})

	// 2. Preview plans + planKind filtering -> claims weekend-low
	mode.Store("preview_plans")
	res, _ = exec.Execute(context.Background(), ExecutionRequest{
		Provider:   "zcode",
		AccountRef: ref,
		ActionID:   "trial_plan",
		Params:     map[string]any{"planKind": "weekend_build"},
	})
	if res["status"] != StatusClaimed || res["planKind"] != "weekend_build" {
		t.Fatalf("preview weekend_build res = %v", res)
	}

	// 3. Marketing touch fallback & duplicate position guard
	mode.Store("marketing_touch")
	res, _ = exec.Execute(context.Background(), ExecutionRequest{Provider: "zcode", AccountRef: ref, ActionID: "trial_plan"})
	if res["status"] != StatusClaimed || res["discovery"] != "marketing_touch" {
		t.Fatalf("marketing touch res = %v", res)
	}

	// 4. Balance fallback -> already_claimed
	mode.Store("balance_held")
	res, _ = exec.Execute(context.Background(), ExecutionRequest{Provider: "zcode", AccountRef: ref, ActionID: "trial_plan"})
	if res["status"] != StatusAlreadyClaimed {
		t.Fatalf("balance held res = %v", res)
	}

	// 5. 3007 -> captcha solve -> retry claim success
	mode.Store("captcha_success")
	res, _ = exec.Execute(context.Background(), ExecutionRequest{Provider: "zcode", AccountRef: ref, ActionID: "trial_plan"})
	if res["status"] != StatusClaimed || res["captcha"] != "solved" || captchaRequests.Load() != 1 {
		t.Fatalf("captcha retry res = %v captchaCalls=%d", res, captchaRequests.Load())
	}

	// 6. 3007 rejected after retry -> zcode_captcha_rejected
	mode.Store("captcha_reject")
	res, _ = exec.Execute(context.Background(), ExecutionRequest{Provider: "zcode", AccountRef: ref, ActionID: "trial_plan"})
	if res["error"] != "zcode_captcha_rejected" {
		t.Fatalf("captcha reject res = %v", res)
	}

	// 7. Regex /已领取/ -> already_claimed with no error
	mode.Store("already_claimed_msg")
	res, _ = exec.Execute(context.Background(), ExecutionRequest{Provider: "zcode", AccountRef: ref, ActionID: "trial_plan"})
	if res["status"] != StatusAlreadyClaimed || res["error"] != nil {
		t.Fatalf("already claimed regex res = %v", res)
	}

	// 8. 1001 -> zcode_plan_not_found
	mode.Store("plan_not_found")
	res, _ = exec.Execute(context.Background(), ExecutionRequest{Provider: "zcode", AccountRef: ref, ActionID: "trial_plan"})
	if res["error"] != "zcode_plan_not_found" {
		t.Fatalf("plan not found res = %v", res)
	}
}

func TestFetchClaimJSON_ReadBodyTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"code":`))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		time.Sleep(1150 * time.Millisecond)
	}))
	defer srv.Close()

	resp := FetchClaimJSON(context.Background(), srv.Client(), http.MethodGet, srv.URL, nil, nil, 1*time.Second)
	if !strings.HasPrefix(resp.Error, "request_failed:fetch_body_timeout:") {
		t.Fatalf("FetchClaimJSON slow body Error = %q, want fetch_body_timeout", resp.Error)
	}
}

func TestService_WithNativeExecutor_RunForAccountAndProbe(t *testing.T) {
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	const ref = "acct_dddddddddddddddddddd"

	const zRef = "acct_eeeeeeeeeeeeeeeeeeee"
	aihDB := createTestAihDB(t, aiHome)
	if _, err := aihDB.Exec(`INSERT INTO accounts (account_ref, provider_id) VALUES (?, 'qoder'), (?, 'zcode')`, ref, zRef); err != nil {
		t.Fatal(err)
	}
	if _, err := aihDB.Exec(`INSERT INTO account_credentials (account_ref, credential_json) VALUES (?, ?), (?, ?)`,
		ref, `{"native_auth_json":{"machineId":"m-srv","userInfo":{"access_token":"tok-srv"}}}`,
		zRef, `{"native_auth_json":{"zcodejwttoken":"z-jwt-srv"}}`); err != nil {
		t.Fatal(err)
	}

	runtimeDir := ResolveAccountRuntimeDir(aiHome, "qoder", ref)
	if err := os.MkdirAll(runtimeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runtimeDir, "umid-cache.json"), []byte(`{"info":{"machineToken":"mt","machineCode":"mc","machineType":"macOS"}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case zcodePlanPreviewPath:
			_, _ = w.Write([]byte(`{"code":0,"data":{"plans":[{"plan_id":"zcode-v3-start-plan-1030-wk","name":"Weekend Build"}]}}`))
		case qoderCampaignsPath:
			_, _ = w.Write([]byte(`{"campaigns":[{"campaignId":"daily-1","actionType":"CLAIM_BENEFIT","claimStatus":"CLAIMABLE","benefit":{"amount":25}}]}`))
		default:
			_, _ = w.Write([]byte(`{"success":true}`))
		}
	}))
	defer srv.Close()

	lister, err := NewCredentialAccountLister(aiHome)
	if err != nil {
		t.Fatal(err)
	}
	exec := NewNativeExecutor(NativeExecutorOptions{
		AIHomeDir:   aiHome,
		HostHomeDir: hostHome,
		BaseURLs:    map[string]string{"qoder": srv.URL, "zcode": srv.URL},
		HTTPClientForAccount: func(ctx context.Context, provider, accountRef string) (HTTPDoer, error) {
			return srv.Client(), nil
		},
	})
	svc, err := NewService(ServiceDependencies{
		Catalog:  BuiltinCatalog(),
		Accounts: lister,
		Executor: exec,
		Jobs:     NewJobManager(nil, nil),
	})
	if err != nil {
		t.Fatal(err)
	}

	// qoder does not declare SupportsProbe; zcode trial_plan supports Probe.
	qProbe := svc.Probe(context.Background(), Selection{Providers: []string{"qoder"}, ActionID: "daily_checkin"})
	if qProbe.Status != 404 {
		t.Fatalf("qoder Probe status = %d, want 404", qProbe.Status)
	}
	zProbe := svc.Probe(context.Background(), Selection{Providers: []string{"zcode"}, ActionID: "trial_plan"})
	if zProbe.Status != 200 {
		t.Fatalf("zcode Probe status = %d payload=%v", zProbe.Status, zProbe.Payload)
	}
	runOut := svc.RunForAccount(context.Background(), "qoder", ref, "daily_checkin")
	if runOut.Status != 200 || runOut.Payload["status"] != StatusClaimed {
		t.Fatalf("RunForAccount = %+v", runOut)
	}
}
