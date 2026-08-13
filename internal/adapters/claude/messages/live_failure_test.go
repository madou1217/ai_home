package messages

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
	runtimeprobe "github.com/madou1217/ai_home/internal/testsupport/accountruntime"
	"github.com/madou1217/ai_home/internal/testsupport/realcredential"
)

const (
	realClaudeFailureEnv        = "AIH_REAL_CLAUDE_FAILURE"
	realClaudeFailureFileEnv    = "AIH_REAL_CLAUDE_FAILURE_CREDENTIAL_FILE"
	realClaudeFailureModelEnv   = "AIH_REAL_CLAUDE_FAILURE_MODEL"
	realClaudeFailureSiblingEnv = "AIH_REAL_CLAUDE_FAILURE_SIBLING_MODEL"
)

// TestLiveClaudeFailureUpdatesProductionRuntime 从私有临时文件读取同一正式账号
// 身份与 auth-token，发出一个真实请求，并验证分类实际写入生产内存运行态。
func TestLiveClaudeFailureUpdatesProductionRuntime(t *testing.T) {
	if strings.TrimSpace(os.Getenv(realClaudeFailureEnv)) != "1" {
		t.Skip("设置 " + realClaudeFailureEnv + "=1 后才允许真实 Claude failure 请求")
	}
	model, sibling := requireRealClaudeFailureModels(t)
	accountRef, credential, accountModels, err := realcredential.DecodeClaudeAccountFile(
		strings.TrimSpace(os.Getenv(realClaudeFailureFileEnv)),
	)
	if err != nil {
		t.Fatalf("解码真实 Claude failure 凭据失败: %v", err)
	}
	if !realcredential.ContainsModels(accountModels, model, sibling) {
		t.Fatal("真实 failure 模型不属于该正式账号的远端目录快照")
	}
	runtime, err := runtimeprobe.New(time.Now)
	if err != nil {
		t.Fatalf("创建真实 Claude failure 运行态失败: %v", err)
	}
	coordinator, transport := newRealClaudeCoordinatorComponents(
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
	executeErr := coordinator.Execute(ctx, newRealClaudeRequest(t, model), func(event inference.StreamEvent) error {
		events = append(events, event)
		return nil
	})
	if executeErr != nil {
		t.Fatalf("真实 Claude failure Execute() error = %v", executeErr)
	}
	failures := runtime.Failures()
	if runtime.SuccessCount() != 0 || len(failures) != 1 || len(events) == 0 ||
		events[len(events)-1].Kind() != inference.EventResponseFailed {
		t.Fatalf(
			"未捕获真实 Claude failure: http_status=%d successes=%d failures=%d events=%s",
			transport.statusCode,
			runtime.SuccessCount(),
			len(failures),
			eventKinds(events),
		)
	}
	observation := failures[0]
	if observation.Route().AccountRef() != accountRef ||
		observation.Route().ModelID().String() != model {
		t.Fatalf(
			"真实 Claude failure 写入身份 account_match=%t model=%s, want %s",
			observation.Route().AccountRef() == accountRef,
			observation.Route().ModelID(),
			model,
		)
	}
	targetStatus := assertClaudeFailureEligibility(t, runtime, observation, model, true)
	siblingStatus := assertClaudeFailureEligibility(t, runtime, observation, sibling, false)
	directive := observation.BlockDirective()
	t.Logf(
		"real_claude_failure http_status=%d endpoint=%s account_match=true model=%s sibling_model=%s failure_kind=%s retry_after=%s block_scope=%s recovery_trigger=%s target_eligibility=%s sibling_eligibility=%s events=%s fingerprint=%s",
		transport.statusCode,
		transport.endpoint,
		model,
		sibling,
		observation.Kind(),
		observation.RetryAfter(),
		directive.Scope(),
		directive.RecoveryTrigger(),
		targetStatus,
		siblingStatus,
		eventKinds(events),
		strings.Join(transport.fingerprint(), "|"),
	)
}

func requireRealClaudeFailureModels(t *testing.T) (string, string) {
	t.Helper()
	model := strings.TrimSpace(os.Getenv(realClaudeFailureModelEnv))
	sibling := strings.TrimSpace(os.Getenv(realClaudeFailureSiblingEnv))
	if model == "" || sibling == "" || model == sibling {
		t.Fatalf(
			"%s 和 %s 必须指定两个不同的账号真实模型",
			realClaudeFailureModelEnv,
			realClaudeFailureSiblingEnv,
		)
	}
	return model, sibling
}

func assertClaudeFailureEligibility(
	t *testing.T,
	runtime *runtimeprobe.Runtime,
	observation runtimeprobe.FailureObservation,
	model string,
	targetModel bool,
) runtimecore.EligibilityStatus {
	t.Helper()
	route, err := runtimecore.NewModelRoute(observation.Route().AccountRef(), model)
	if err != nil {
		t.Fatalf("创建真实 Claude failure 资格键失败: %v", err)
	}
	eligibility, err := runtime.CheckEligibility(context.Background(), route)
	if err != nil {
		t.Fatalf("读取真实 Claude failure 资格失败: %v", err)
	}
	want, err := runtimeprobe.ExpectedEligibility(observation, targetModel)
	if err != nil || eligibility.Status() != want {
		t.Fatalf(
			"真实 Claude failure 资格模型=%s got=%s want=%s error=%v",
			model,
			eligibility.Status(),
			want,
			err,
		)
	}
	return eligibility.Status()
}
