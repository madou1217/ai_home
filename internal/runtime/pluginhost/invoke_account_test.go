package pluginhost

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/pluginerr"
	"github.com/madou1217/ai_home/internal/runtime/pricingcatalog"
)

type rawPayloadHostClient struct {
	*fakeHostClient
	payloadHook func(gen int64, cid string, val any) (json.RawMessage, []byte, error)
}

func (c *rawPayloadHostClient) InvokeRaw(
	ctx context.Context,
	generation int64,
	contributionID string,
	value any,
	timeout time.Duration,
) (json.RawMessage, []byte, error) {
	if c.payloadHook != nil {
		return c.payloadHook(generation, contributionID, value)
	}
	raw, err := c.fakeHostClient.Invoke(ctx, generation, contributionID, value, timeout)
	return raw, nil, err
}

type stubProjectionRegistrar struct {
	result ProjectionRegisterResult
	err    error
	last   ProjectionRegisterRequest
}

func (r *stubProjectionRegistrar) RegisterProjection(_ context.Context, req ProjectionRegisterRequest) (ProjectionRegisterResult, error) {
	r.last = req
	return r.result, r.err
}

type staticStateReader struct {
	doc map[string]any
}

func (r staticStateReader) ReadRawControlState(_ context.Context) ([]byte, error) {
	return json.Marshal(r.doc)
}

func newTestPluginService(t *testing.T, aiHomeDir string, hostClient HostClient, plugins []PluginSpec) *Service {
	t.Helper()
	pStore, err := pricingcatalog.NewStore(aiHomeDir)
	if err != nil {
		t.Fatalf("NewStore 失败: %v", err)
	}
	pSvc, err := pricingcatalog.NewService(pricingcatalog.ServiceDependencies{
		Store:            pStore,
		CommunitySources: []pricingcatalog.CommunitySource{},
	})
	if err != nil {
		t.Fatalf("NewService(pricing) 失败: %v", err)
	}
	svc, err := NewService(ServiceOptions{
		AIHomeDir:      aiHomeDir,
		HostVersion:    "1.0.0",
		PricingService: pSvc,
		StateReader: staticStateReader{doc: map[string]any{
			"schemaVersion": 1,
			"revision":      2,
			"installed":     []any{},
			"instances":     []any{},
		}},
		SupervisorFactory: func(seq int64) (HostClient, error) {
			return hostClient, nil
		},
	})
	if err != nil {
		t.Fatalf("NewService 失败: %v", err)
	}
	t.Cleanup(func() { _ = svc.Close() })
	if len(plugins) > 0 {
		if _, err := svc.Runtime().Publish(context.Background(), plugins, nil); err != nil {
			t.Fatalf("Publish 失败: %v", err)
		}
	}
	return svc
}

func TestInvokeContributionAndQuotePricing(t *testing.T) {
	home := t.TempDir()
	host := &rawPayloadHostClient{
		fakeHostClient: &fakeHostClient{},
		payloadHook: func(_ int64, cid string, val any) (json.RawMessage, []byte, error) {
			switch cid {
			case "echo.contrib":
				return json.RawMessage(`{"echo":true}`), []byte{1, 2, 3, 4, 5}, nil
			case "quote.ok":
				return json.RawMessage(`{"quotes":[{"provider":"openai","model":"gpt-5","input":3.0,"output":12.0,"source":{"id":"plugin-q","kind":"official"}}]}`), nil, nil
			case "quote.fail":
				return nil, nil, pluginerr.New("quote_timeout", "报价超时")
			default:
				return nil, nil, pluginerr.New("plugin_contribution_unknown", "未知贡献项")
			}
		},
	}
	plugins := []PluginSpec{{
		InstanceID: "inst-q",
		PluginID:   "plug-q",
		Version:    "1.0.0",
		EntryPath:  "/tmp/q.mjs",
		Manifest: map[string]any{
			"pluginId": "plug-q",
			"contributes": []any{
				map[string]any{"id": "echo.contrib", "capability": "observe", "order": 1},
				map[string]any{"id": "quote.ok", "capability": PricingQuoteCapability, "order": 1, "failurePolicy": "delegate"},
				map[string]any{"id": "quote.fail", "capability": PricingQuoteCapability, "order": 2, "failurePolicy": "delegate"},
			},
		},
	}}
	svc := newTestPluginService(t, home, host, plugins)

	if _, err := svc.InvokeContribution(context.Background(), "", nil, time.Second); errorCode(err) != "plugin_contribution_required" {
		t.Fatalf("空 contributionId 错误码不符: %v", err)
	}
	res, err := svc.InvokeContribution(context.Background(), "echo.contrib", map[string]any{"k": "v"}, time.Second)
	if err != nil {
		t.Fatalf("InvokeContribution 失败: %v", err)
	}
	if res.PayloadBytes != 5 || string(res.Value) != `{"echo":true}` {
		t.Fatalf("InvokeContribution 结果不符: %+v", res)
	}

	if _, err := svc.QuotePricing(context.Background(), PricingQuoteRequest{Provider: "", Model: "gpt-5"}); errorCode(err) != "invalid_payload" {
		t.Fatalf("缺少 provider 应拒绝: %v", err)
	}
	merged, err := svc.QuotePricing(context.Background(), PricingQuoteRequest{
		Provider: "OPENAI",
		Model:    "gpt-5",
	})
	if err != nil {
		t.Fatalf("QuotePricing 失败: %v", err)
	}
	if merged.Contributions != 2 || merged.Quote.Input == nil || *merged.Quote.Input != 3.0 {
		t.Fatalf("QuotePricing 合并结果异常: %+v", merged)
	}

	// 未发布代次时必须显式返回 plugin_runtime_inactive。
	emptySvc := newTestPluginService(t, t.TempDir(), &fakeHostClient{}, nil)
	if _, err := emptySvc.InvokeContribution(context.Background(), "echo.contrib", nil, time.Second); errorCode(err) != "plugin_runtime_inactive" {
		t.Fatalf("未激活时 Invoke 应返回 plugin_runtime_inactive，实际 %v", err)
	}
	if _, err := emptySvc.QuotePricing(context.Background(), PricingQuoteRequest{Provider: "openai", Model: "gpt-5"}); errorCode(err) != "plugin_runtime_inactive" {
		t.Fatalf("未激活时 Quote 应返回 plugin_runtime_inactive，实际 %v", err)
	}
}

func TestAccountPluginLifecycleAndAudit(t *testing.T) {
	home := t.TempDir()
	badRefreshHost := false
	host := &fakeHostClient{
		invHook: func(_ int64, cid string, val any) (json.RawMessage, error) {
			body, _ := val.(map[string]any)
			switch cid {
			case "src.one":
				switch body["kind"] {
				case "list":
					return json.RawMessage(`{"sources":[{"id":"local-direct","kind":"local","authMode":"oauth","clientDependent":false,"directImport":true},{"id":"needs-login","kind":"remote","authMode":"oauth","clientDependent":false,"directImport":false,"loginContribution":"login.one"}]}`), nil
				case "import":
					return json.RawMessage(`{"files":[{"path":".codex/auth.json","content":"{\"token\":\"fresh\"}"}]}`), nil
				}
			case "src.dup":
				return json.RawMessage(`{"sources":[{"id":"local-direct","kind":"local","authMode":"oauth","clientDependent":false}]}`), nil
			case "refresh.one":
				switch body["kind"] {
				case "match":
					return json.RawMessage(`{"handles":true}`), nil
				case "refresh":
					if badRefreshHost {
						runtimeDir, _ := body["runtimeDir"].(string)
						_ = os.WriteFile(filepath.Join(runtimeDir, ".codex", "auth.json"), []byte(`{"token":"raced"}`), 0o600)
					}
					return json.RawMessage(`{"handled":true,"rotated":true,"credential":{"accessToken":"new-tok"}}`), nil
				}
			case "mat.one":
				switch body["kind"] {
				case "match":
					return json.RawMessage(`{"handles":true}`), nil
				case "materialize":
					return json.RawMessage(`{"handled":true,"files":[{"path":".codex/auth.json","content":"{\"token\":\"mat\"}"}],"removed":[".codex/stale.json"]}`), nil
				}
			}
			return nil, errors.New("unexpected invoke")
		},
	}
	plugins := []PluginSpec{
		{
			InstanceID: "inst-acc",
			PluginID:   "plug-acc",
			Version:    "1.0.0",
			EntryPath:  "/tmp/acc.mjs",
			Manifest: map[string]any{
				"pluginId": "plug-acc",
				"contributes": []any{
					map[string]any{"id": "src.one", "capability": AccountSourceCapability, "order": 1},
					map[string]any{"id": "src.dup", "capability": AccountSourceCapability, "order": 2},
					map[string]any{"id": "login.one", "capability": AccountLoginCapability, "order": 1},
					map[string]any{"id": "refresh.one", "capability": AccountRefreshCapability, "order": 1},
					map[string]any{"id": "mat.one", "capability": AccountMaterializeCapability, "order": 1},
				},
			},
		},
	}
	svc := newTestPluginService(t, home, host, plugins)

	// 1. ListAccountSources + 重复 sourceId 告警 + loginAvailable 校验
	listed, err := svc.ListAccountSources(context.Background(), "codex", AccountListOptions{})
	if err != nil {
		t.Fatalf("ListAccountSources 失败: %v", err)
	}
	if len(listed.Sources) != 2 || len(listed.Warnings) != 1 || listed.Warnings[0].Code != "account_source_duplicate" {
		t.Fatalf("ListAccountSources 结果异常: %+v", listed)
	}
	if !listed.Sources[0].LoginAvailable || !listed.Sources[1].LoginAvailable {
		t.Fatalf("期望 loginAvailable=true，实际 %+v", listed.Sources)
	}

	// 2. ImportAccountSource: directImport=false 拒绝
	blocked, err := svc.ImportAccountSource(context.Background(), AccountImportRequest{
		Provider: "codex",
		SourceID: "needs-login",
	}, &stubProjectionRegistrar{})
	if err != nil || blocked.OK || blocked.Code != "auth_source_requires_login_job" {
		t.Fatalf("非 directImport 应拒绝: %+v err=%v", blocked, err)
	}

	// 3. ImportAccountSource: 墓碑阻断复活
	tombstoneRes, err := svc.ImportAccountSource(context.Background(), AccountImportRequest{
		Provider: "codex",
		SourceID: "local-direct",
	}, &stubProjectionRegistrar{result: ProjectionRegisterResult{Registered: false, Reason: "account_deleted_by_user"}})
	if err != nil || tombstoneRes.OK || tombstoneRes.Code != "account_deleted_by_user" {
		t.Fatalf("墓碑应返回 account_deleted_by_user: %+v err=%v", tombstoneRes, err)
	}

	// 4. ImportAccountSource 成功写投影文件 + 登记 + 审计
	reg := &stubProjectionRegistrar{result: ProjectionRegisterResult{Registered: true, Provider: "codex", AccountRef: "acct_123", CLIAccountID: "42"}}
	impRes, err := svc.ImportAccountSource(context.Background(), AccountImportRequest{
		Provider: "codex",
		SourceID: "local-direct",
	}, reg)
	if err != nil || !impRes.OK || impRes.AccountRef != "acct_123" || !reg.last.RespectDeletion {
		t.Fatalf("ImportAccountSource 成功结果不符: %+v reg=%+v err=%v", impRes, reg.last, err)
	}
	if _, statErr := os.Stat(filepath.Join(impRes.RuntimeDir, ".codex", "auth.json")); statErr != nil {
		t.Fatalf("导入后投影文件应存在: %v", statErr)
	}

	// 5. RefreshAccount CAS 冲突检测 + 正常刷新写回与物化
	badRefreshHost = true
	conflictRes, err := svc.RefreshAccount(context.Background(), AccountRefreshRequest{
		Provider:   "codex",
		AccountRef: "acct_123",
		RuntimeDir: impRes.RuntimeDir,
	}, reg)
	if err != nil || conflictRes.Handled || conflictRes.Reason != "account_refresh_conflict" {
		t.Fatalf("CAS 冲突未拦截: %+v err=%v", conflictRes, err)
	}

	badRefreshHost = false
	refRes, err := svc.RefreshAccount(context.Background(), AccountRefreshRequest{
		Provider:   "codex",
		AccountRef: "acct_123",
		RuntimeDir: impRes.RuntimeDir,
	}, reg)
	if err != nil || !refRes.Handled || !refRes.Rotated || len(refRes.Files) != 1 {
		t.Fatalf("RefreshAccount 正常路径异常: %+v err=%v", refRes, err)
	}

	// 6. MaterializeAccount 路径越界拒绝 & 正常物化+清理旧文件
	if _, err := svc.MaterializeAccount(context.Background(), AccountMaterializeRequest{
		Provider:   "codex",
		RuntimeDir: "/tmp/outside-aih-home",
	}); errorCode(err) != "account_plugin_runtime_dir_outside_home" {
		t.Fatalf("越界 runtimeDir 应拒绝: %v", err)
	}
	stalePath := filepath.Join(impRes.RuntimeDir, ".codex", "stale.json")
	if err := os.WriteFile(stalePath, []byte("stale"), 0o600); err != nil {
		t.Fatalf("写 stale.json 失败: %v", err)
	}
	matRes, err := svc.MaterializeAccount(context.Background(), AccountMaterializeRequest{
		Provider:   "codex",
		AccountRef: "acct_123",
		RuntimeDir: impRes.RuntimeDir,
	})
	if err != nil || !matRes.Handled || len(matRes.Removed) != 1 {
		t.Fatalf("MaterializeAccount 结果异常: %+v err=%v", matRes, err)
	}
	if _, statErr := os.Stat(stalePath); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("stale.json 应被移除: %v", statErr)
	}

	// 7. 验证审计日志已落盘并包含 account_import / account_refresh / account_materialize
	records := svc.AuditLog().Read(20)
	var events []string
	for _, r := range records {
		events = append(events, strings.TrimSpace(strAny(r["event"])))
	}
	joined := strings.Join(events, ",")
	if !strings.Contains(joined, "account_import") || !strings.Contains(joined, "account_refresh") || !strings.Contains(joined, "account_materialize") {
		t.Fatalf("审计日志缺少账号操作记录: %v", events)
	}
}

func TestDoctorSummaryDefaultsUnsignedSignature(t *testing.T) {
	home := t.TempDir()
	pluginDir := filepath.Join(home, "plugins", "extracted", "p1")
	if err := os.MkdirAll(pluginDir, 0o700); err != nil {
		t.Fatalf("创建插件目录失败: %v", err)
	}
	artifact := filepath.Join(home, "plugins", "p1.aih-plugin")
	if err := os.WriteFile(artifact, []byte("pkg"), 0o600); err != nil {
		t.Fatalf("写制品失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(pluginDir, "index.mjs"), []byte("export default {}"), 0o600); err != nil {
		t.Fatalf("写入口失败: %v", err)
	}
	svc, err := NewService(ServiceOptions{
		AIHomeDir:   home,
		HostVersion: "1.0.0",
		StateReader: staticStateReader{doc: map[string]any{
			"schemaVersion": 1,
			"revision":      3,
			"installed": []any{
				map[string]any{
					"pluginId":  "p1",
					"version":   "1.0.0",
					"digest":    "sha256:123",
					"artifact":  artifact,
					"directory": pluginDir,
					"manifest": map[string]any{
						"schemaVersion": 1,
						"pluginId":      "p1",
						"version":       "1.0.0",
						"entry":         "index.mjs",
					},
				},
			},
			"instances": []any{},
		}},
	})
	if err != nil {
		t.Fatalf("NewService 失败: %v", err)
	}
	defer func() { _ = svc.Close() }()

	report := svc.Doctor(context.Background())
	if len(report.Installed) != 1 {
		t.Fatalf("期望 1 个已安装摘要，实际 %d", len(report.Installed))
	}
	sig, ok := report.Installed[0].Signature.(map[string]any)
	if !ok || sig["status"] != "unsigned" {
		t.Fatalf("未签名插件应默认 {status:unsigned}，实际 %#v", report.Installed[0].Signature)
	}
}

func strAny(v any) string {
	s, _ := v.(string)
	return s
}
