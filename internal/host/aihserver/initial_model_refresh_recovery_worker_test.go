package aihserver

import (
	"bytes"
	"context"
	"errors"
	"log"
	"strings"
	"testing"
	"time"
)

// TestInitialModelRefreshRecoveryWorkerCancelsAndWaits 验证 Server 关闭时恢复扫描
// 先观察取消并退出，避免随后关闭协调器或 SQLite 时仍在访问它们。
func TestInitialModelRefreshRecoveryWorkerCancelsAndWaits(t *testing.T) {
	t.Parallel()

	recovery := &blockingInitialModelRefreshRecovery{
		started: make(chan struct{}),
		stopped: make(chan struct{}),
	}
	worker, err := startInitialModelRefreshRecoveryWorker(
		context.Background(),
		recovery,
		nil,
	)
	if err != nil {
		t.Fatalf("startInitialModelRefreshRecoveryWorker() error = %v", err)
	}
	select {
	case <-recovery.started:
	case <-time.After(time.Second):
		t.Fatal("恢复 worker 未启动")
	}
	if err := worker.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	select {
	case <-recovery.stopped:
	default:
		t.Fatal("Close() 返回时恢复扫描仍未退出")
	}
	if err := worker.Close(); err != nil {
		t.Fatalf("Close(second) error = %v", err)
	}
}

// TestInitialModelRefreshRecoveryWorkerLogsFailures 验证非取消错误进入现有
// ErrorLog，且日志只包含低敏恢复上下文。
func TestInitialModelRefreshRecoveryWorkerLogsFailures(t *testing.T) {
	t.Parallel()

	var output bytes.Buffer
	recoveryErr := errors.New("synthetic recovery query failure")
	recovery := &failingInitialModelRefreshRecovery{
		err:  recoveryErr,
		done: make(chan struct{}),
	}
	worker, err := startInitialModelRefreshRecoveryWorker(
		context.Background(),
		recovery,
		log.New(&output, "", 0),
	)
	if err != nil {
		t.Fatalf("startInitialModelRefreshRecoveryWorker() error = %v", err)
	}
	select {
	case <-recovery.done:
	case <-time.After(time.Second):
		t.Fatal("恢复失败没有返回")
	}
	if err := worker.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	logOutput := output.String()
	if !strings.Contains(logOutput, "账号首次模型刷新启动恢复失败") ||
		!strings.Contains(logOutput, recoveryErr.Error()) {
		t.Fatalf("ErrorLog = %q", logOutput)
	}
}

type blockingInitialModelRefreshRecovery struct {
	started chan struct{}
	stopped chan struct{}
}

func (recovery *blockingInitialModelRefreshRecovery) Recover(
	ctx context.Context,
) error {
	close(recovery.started)
	<-ctx.Done()
	close(recovery.stopped)
	return ctx.Err()
}

type failingInitialModelRefreshRecovery struct {
	err  error
	done chan struct{}
}

func (recovery *failingInitialModelRefreshRecovery) Recover(context.Context) error {
	close(recovery.done)
	return recovery.err
}
