package aihserver

import (
	"context"
	"errors"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/webuirestoreschedulingapi"
)

// restoreCapableRuntime 只实现「强制恢复调度」这一个可选能力。
//
// 其余方法由内嵌接口提供（测试里不会被调用），这样断言只反映能力集是否被装饰器保留。
type restoreCapableRuntime struct {
	serverAccountRuntime
	restored []accountcore.AccountRef
}

func (runtime *restoreCapableRuntime) RestoreScheduling(
	_ context.Context,
	accountRef accountcore.AccountRef,
) error {
	runtime.restored = append(runtime.restored, accountRef)
	return nil
}

// restoreIncapableRuntime 是真实运行态的最小替身：不提供 RestoreScheduling。
type restoreIncapableRuntime struct {
	serverAccountRuntime
}

// 装饰器只做记账，不得收窄内层运行态的能力集。
//
// 回归背景：outcomeRecordingRuntime 曾经只内嵌 serverAccountRuntime，于是
// webuiroutes 对 RuntimeRestorer 的类型断言必然失败，整个 Go Core 启动即退出
// （aih-server 启动失败: 创建强制恢复调度接口失败: 运行态不支持 RestoreScheduling）。
func TestOutcomeRecordingRuntimeKeepsRestoreScheduling(t *testing.T) {
	inner := &restoreCapableRuntime{}
	decorated := outcomeRecordingRuntime{serverAccountRuntime: inner}

	restorer, ok := any(decorated).(webuirestoreschedulingapi.RuntimeRestorer)
	if !ok {
		t.Fatal("装饰后的运行态必须保留 RestoreScheduling 能力")
	}
	accountRef := accountcore.AccountRef("acct_capability_probe")
	if err := restorer.RestoreScheduling(context.Background(), accountRef); err != nil {
		t.Fatalf("转发失败: %v", err)
	}
	if len(inner.restored) != 1 || inner.restored[0] != accountRef {
		t.Fatalf("调用未透传到内层运行态: %v", inner.restored)
	}
}

// 内层不支持时必须返回错误，而不是 panic 或静默成功。
func TestOutcomeRecordingRuntimeReportsMissingRestoreScheduling(t *testing.T) {
	decorated := outcomeRecordingRuntime{serverAccountRuntime: &restoreIncapableRuntime{}}
	err := decorated.RestoreScheduling(context.Background(), accountcore.AccountRef("acct_capability_probe"))
	if err == nil {
		t.Fatal("内层不支持时应当报错")
	}
	if !errors.Is(err, errRestoreSchedulingUnsupported) {
		t.Fatalf("错误应可识别，实际 %v", err)
	}
}
