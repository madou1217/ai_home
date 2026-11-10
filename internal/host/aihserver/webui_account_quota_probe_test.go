package aihserver

import (
	"context"
	"errors"
	"testing"
	"time"

	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountrefreshusageapi"
)

const (
	quotaProbeTestProvider    = "codex"
	quotaProbeTestAccountRef  = "acct_0123456789abcdef0123"
	quotaProbeOtherAccountRef = "acct_ffffffffffffffffffff"
)

var (
	quotaProbeTestCapturedAt = time.UnixMilli(1_700_000_000_000).UTC()
	quotaProbeTestResetAt    = time.UnixMilli(1_700_003_600_000).UTC()
)

// fakeQuotaUsage 是 usageQuotaRefresher 的测试替身。
type fakeQuotaUsage struct {
	result   usageapp.ReadResult
	err      error
	called   int
	received accountcore.AccountRef
}

func (fake *fakeQuotaUsage) RefreshUsage(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (usageapp.ReadResult, error) {
	fake.called++
	fake.received = accountRef
	if fake.err != nil {
		return usageapp.ReadResult{}, fake.err
	}
	return fake.result, nil
}

// newQuotaProbeTestResult 构造一份已校验的额度读取结果。
//
// 夹具包含一个带剩余比例的账号级窗口和一个未知比例的 Credits 条目，覆盖
// RemainingPct 的已知/未知两种投影。
func newQuotaProbeTestResult(
	t *testing.T,
	providerID string,
	accountRef accountcore.AccountRef,
) usageapp.ReadResult {
	t.Helper()
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: accountRef,
		ProviderID: providerID,
		Source:     "codex_http",
		PlanType:   "plus",
		CapturedAt: quotaProbeTestCapturedAt,
		Entries: []usagecore.EntryInput{
			{
				LimitID:              "codex",
				LimitName:            "Codex",
				Bucket:               "primary",
				Kind:                 usagecore.KindWindow,
				Scope:                usagecore.ScopeAccount,
				HasRemaining:         true,
				RemainingBasisPoints: 7350,
				WindowSeconds:        18_000,
				ResetAt:              quotaProbeTestResetAt,
				Availability:         usagecore.AvailabilityAvailable,
			},
			{
				Bucket:       "credits",
				Kind:         usagecore.KindCredits,
				Scope:        usagecore.ScopeAccount,
				HasRemaining: false,
				Availability: usagecore.AvailabilityDisabled,
			},
		},
	})
	if err != nil {
		t.Fatalf("构造额度快照失败: %v", err)
	}
	result, err := usageapp.NewReadResult(snapshot, false)
	if err != nil {
		t.Fatalf("构造额度读取结果失败: %v", err)
	}
	return result
}

func TestWebUIQuotaProbeMapsSnapshot(t *testing.T) {
	usage := &fakeQuotaUsage{
		result: newQuotaProbeTestResult(t, quotaProbeTestProvider, quotaProbeTestAccountRef),
	}
	probe := webuiQuotaProbe{usage: usage}

	snapshot, err := probe.ProbeQuota(
		context.Background(),
		quotaProbeTestProvider,
		quotaProbeTestAccountRef,
	)
	if err != nil {
		t.Fatalf("ProbeQuota 返回错误: %v", err)
	}
	if usage.received != accountcore.AccountRef(quotaProbeTestAccountRef) {
		t.Fatalf("RefreshUsage 收到的账号引用 = %q", usage.received)
	}
	if snapshot.Provider != quotaProbeTestProvider ||
		snapshot.AccountRef != quotaProbeTestAccountRef {
		t.Fatalf("快照身份 = %s/%s", snapshot.Provider, snapshot.AccountRef)
	}
	if snapshot.PlanType != "plus" || snapshot.Source != "codex_http" {
		t.Fatalf("套餐或来源 = %q/%q", snapshot.PlanType, snapshot.Source)
	}
	if !snapshot.CapturedAt.Equal(quotaProbeTestCapturedAt) {
		t.Fatalf("采集时间 = %v", snapshot.CapturedAt)
	}
	if len(snapshot.Windows) != 2 {
		t.Fatalf("窗口数 = %d", len(snapshot.Windows))
	}

	windows := make(map[string]webuiaccountrefreshusageapi.Window, len(snapshot.Windows))
	for _, window := range snapshot.Windows {
		windows[window.Bucket] = window
	}

	primary, found := windows["primary"]
	if !found {
		t.Fatal("缺少 primary 窗口")
	}
	if primary.LimitID != "codex" || primary.LimitName != "Codex" {
		t.Fatalf("额度组 = %q/%q", primary.LimitID, primary.LimitName)
	}
	if primary.Kind != "window" || primary.Scope != "account" || primary.ScopeKey != "" {
		t.Fatalf("窗口维度 = %q/%q/%q", primary.Kind, primary.Scope, primary.ScopeKey)
	}
	if primary.WindowSeconds != 18_000 {
		t.Fatalf("窗口长度 = %d", primary.WindowSeconds)
	}
	if !primary.ResetAt.Equal(quotaProbeTestResetAt) {
		t.Fatalf("恢复时间 = %v", primary.ResetAt)
	}
	if primary.Availability != "available" {
		t.Fatalf("可用性 = %q", primary.Availability)
	}
	// 7350 基点按 Node 口径还原为 73.5%。
	if primary.RemainingPct == nil || *primary.RemainingPct != 73.5 {
		t.Fatalf("剩余比例 = %v", primary.RemainingPct)
	}

	credits, found := windows["credits"]
	if !found {
		t.Fatal("缺少 credits 窗口")
	}
	if credits.Kind != "credits" || credits.Availability != "disabled" {
		t.Fatalf("Credits 维度 = %q/%q", credits.Kind, credits.Availability)
	}
	if credits.RemainingPct != nil {
		t.Fatalf("未知剩余比例应为 nil，实际 %v", *credits.RemainingPct)
	}
	if !credits.ResetAt.IsZero() {
		t.Fatalf("零值恢复时间应保留零值，实际 %v", credits.ResetAt)
	}
}

func TestWebUIQuotaProbeRejectsInvalidAccountRef(t *testing.T) {
	usage := &fakeQuotaUsage{}
	probe := webuiQuotaProbe{usage: usage}

	_, err := probe.ProbeQuota(context.Background(), quotaProbeTestProvider, "not-an-account-ref")
	if !errors.Is(err, accountcore.ErrInvalidAccountRef) {
		t.Fatalf("错误 = %v", err)
	}
	if usage.called != 0 {
		t.Fatalf("账号引用无效时不应调用 RefreshUsage，实际调用 %d 次", usage.called)
	}
}

func TestWebUIQuotaProbePropagatesUpstreamError(t *testing.T) {
	upstreamErr := errors.New("Provider 额度接口不可用")
	probe := webuiQuotaProbe{usage: &fakeQuotaUsage{err: upstreamErr}}

	_, err := probe.ProbeQuota(
		context.Background(),
		quotaProbeTestProvider,
		quotaProbeTestAccountRef,
	)
	if !errors.Is(err, upstreamErr) {
		t.Fatalf("错误 = %v", err)
	}
}

func TestWebUIQuotaProbeRejectsIdentityMismatch(t *testing.T) {
	cases := []struct {
		name       string
		providerID string
		accountRef accountcore.AccountRef
	}{
		{
			name:       "账号不一致",
			providerID: quotaProbeTestProvider,
			accountRef: quotaProbeOtherAccountRef,
		},
		{
			name:       "Provider 不一致",
			providerID: "claude",
			accountRef: quotaProbeTestAccountRef,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			usage := &fakeQuotaUsage{
				result: newQuotaProbeTestResult(t, testCase.providerID, testCase.accountRef),
			}
			probe := webuiQuotaProbe{usage: usage}

			_, err := probe.ProbeQuota(
				context.Background(),
				quotaProbeTestProvider,
				quotaProbeTestAccountRef,
			)
			if !errors.Is(err, webuiaccountrefreshusageapi.ErrInvalidSnapshot) {
				t.Fatalf("错误 = %v", err)
			}
		})
	}
}
