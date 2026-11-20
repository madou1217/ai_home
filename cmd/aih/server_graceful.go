package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// requestServerShutdown 通过管理端点请求进程自己退出（Windows 上的 graceful-stop）。
//
// Windows 没有可用的 SIGTERM：服务管理器与 schtasks /End 都是 TerminateProcess，
// 进程内的收尾（在跑的推理流、用量账本）根本不会执行。管理端点是有序退出的唯一
// 入口：它先回 202，再异步触发 server.Shutdown。
func requestServerShutdown(ctx context.Context, port int, managementKey string) error {
	key := strings.TrimSpace(managementKey)
	if key == "" {
		return fmt.Errorf("management key 不可用，无法请求优雅退出")
	}
	endpoint := fmt.Sprintf("http://127.0.0.1:%d/v0/management/shutdown", port)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+key)
	client := &http.Client{Timeout: 10 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode != http.StatusAccepted && response.StatusCode != http.StatusOK {
		return fmt.Errorf("关闭端点返回 %d", response.StatusCode)
	}
	return nil
}

// waitServerStopped 等 /readyz 不再应答：进程已完成收尾（最长收尾窗口 30s）。
func waitServerStopped(ctx context.Context, port int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if !serverReady(ctx, port) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(200 * time.Millisecond):
		}
	}
}
