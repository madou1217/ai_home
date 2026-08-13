package responses

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	runtimeprobe "github.com/madou1217/ai_home/internal/testsupport/accountruntime"
	"github.com/madou1217/ai_home/internal/testsupport/realcredential"
)

const (
	realCodexFailureEnv        = "AIH_REAL_CODEX_FAILURE"
	realCodexFailureFileEnv    = "AIH_REAL_CODEX_FAILURE_CREDENTIAL_FILE"
	realCodexFailureModelEnv   = "AIH_REAL_CODEX_FAILURE_MODEL"
	realCodexFailureSiblingEnv = "AIH_REAL_CODEX_FAILURE_SIBLING_MODEL"
)

// TestLiveCodexFailureUpdatesProductionRuntime 从私有临时文件读取同一正式账号
// 身份与凭据，发出一个真实请求，并验证 Adapter 分类实际写入生产内存运行态。
func TestLiveCodexFailureUpdatesProductionRuntime(t *testing.T) {
	if strings.TrimSpace(os.Getenv(realCodexFailureEnv)) != "1" {
		t.Skip("设置 " + realCodexFailureEnv + "=1 后才允许真实 Codex failure 请求")
	}
	model, sibling := requireRealFailureModels(
		t,
		realCodexFailureModelEnv,
		realCodexFailureSiblingEnv,
	)
	accountRef, credential, accountModels, err := realcredential.DecodeCodexAccountFile(
		strings.TrimSpace(os.Getenv(realCodexFailureFileEnv)),
	)
	if err != nil {
		t.Fatalf("解码真实 Codex failure 凭据失败: %v", err)
	}
	if !realcredential.ContainsModels(accountModels, model, sibling) {
		t.Fatal("真实 failure 模型不属于该正式账号的远端目录快照")
	}
	runtime, err := runtimeprobe.New(time.Now)
	if err != nil {
		t.Fatalf("创建真实 Codex failure 运行态失败: %v", err)
	}
	coordinator, transport := newRealCodexCoordinatorComponents(
		t,
		credential,
		model,
		accountRef,
		runtime,
		runtime,
	)

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	events := make([]inference.StreamEvent, 0, 8)
	executeErr := coordinator.Execute(ctx, newRealCodexRequest(t), func(event inference.StreamEvent) error {
		events = append(events, event)
		return nil
	})
	assertRealCodexFailureRuntime(
		t,
		executeErr,
		events,
		transport,
		runtime,
		accountRef,
		model,
		sibling,
	)
}

func assertRealCodexFailureRuntime(
	t *testing.T,
	executeErr error,
	events []inference.StreamEvent,
	transport *realCodexTransportDiagnostic,
	runtime *runtimeprobe.Runtime,
	accountRef accountcore.AccountRef,
	model string,
	sibling string,
) {
	t.Helper()
	if executeErr != nil {
		t.Fatalf("真实 Codex failure Execute() error = %v", executeErr)
	}
	failures := runtime.Failures()
	if runtime.SuccessCount() != 0 || len(failures) != 1 || len(events) == 0 ||
		events[len(events)-1].Kind() != inference.EventResponseFailed {
		t.Fatalf(
			"未捕获真实 Codex failure: http_status=%d successes=%d failures=%d events=%v",
			transport.statusCode,
			runtime.SuccessCount(),
			len(failures),
			eventKindsForAdapter(events),
		)
	}
	observation := failures[0]
	if observation.Route().AccountRef() != accountRef ||
		observation.Route().ModelID().String() != model {
		t.Fatalf(
			"真实 Codex failure 写入身份 account_match=%t model=%s, want %s",
			observation.Route().AccountRef() == accountRef,
			observation.Route().ModelID(),
			model,
		)
	}
	targetStatus := assertRealFailureEligibility(t, runtime, observation, model, true)
	siblingStatus := assertRealFailureEligibility(t, runtime, observation, sibling, false)
	directive := observation.BlockDirective()
	t.Logf(
		"real_codex_failure endpoint=%s http_status=%d account_match=true model=%s sibling_model=%s failure_kind=%s retry_after=%s block_scope=%s recovery_trigger=%s target_eligibility=%s sibling_eligibility=%s events=%v",
		transport.endpoint,
		transport.statusCode,
		model,
		sibling,
		observation.Kind(),
		observation.RetryAfter(),
		directive.Scope(),
		directive.RecoveryTrigger(),
		targetStatus,
		siblingStatus,
		eventKindsForAdapter(events),
	)
}

func requireRealFailureModels(t *testing.T, modelEnv string, siblingEnv string) (string, string) {
	t.Helper()
	model := strings.TrimSpace(os.Getenv(modelEnv))
	sibling := strings.TrimSpace(os.Getenv(siblingEnv))
	if model == "" || sibling == "" || model == sibling {
		t.Fatalf("%s 和 %s 必须指定两个不同的账号真实模型", modelEnv, siblingEnv)
	}
	return model, sibling
}

func assertRealFailureEligibility(
	t *testing.T,
	runtime *runtimeprobe.Runtime,
	observation runtimeprobe.FailureObservation,
	model string,
	targetModel bool,
) runtimecore.EligibilityStatus {
	t.Helper()
	route, err := runtimecore.NewModelRoute(observation.Route().AccountRef(), model)
	if err != nil {
		t.Fatalf("创建真实 failure 资格键失败: %v", err)
	}
	eligibility, err := runtime.CheckEligibility(context.Background(), route)
	if err != nil {
		t.Fatalf("读取真实 failure 资格失败: %v", err)
	}
	want, err := runtimeprobe.ExpectedEligibility(observation, targetModel)
	if err != nil || eligibility.Status() != want {
		t.Fatalf(
			"真实 failure 资格模型=%s got=%s want=%s error=%v",
			model,
			eligibility.Status(),
			want,
			err,
		)
	}
	return eligibility.Status()
}
