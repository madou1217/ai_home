package serverprobe

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	maxReadyzBytes = 64 * 1024
	// DrainPath 是重启前关闭新推理入口、等待存量流收尾的本机控制端点。
	DrainPath = "/v1/management/webui/server/drain"
)

// ActiveInference 读取本地 aih-server 当前仍在生成的推理流数量。
//
// 该探针只用于重启前保护：读不到、旧版本没有字段或请求失败都返回 0，
// 保持原有生命周期的兼容行为；只有服务端明确报告大于 0 时才阻止重启。
// BeginDrain closes the server's inference admission gate and returns the
// number of inference streams already running.
func BeginDrain(ctx context.Context, port int, managementKey string) (int, error) {
	return drain(ctx, port, managementKey, "begin")
}

// CancelDrain reopens inference admission after an abandoned restart.
func CancelDrain(ctx context.Context, port int, managementKey string) error {
	_, err := drain(ctx, port, managementKey, "cancel")
	return err
}

func drain(ctx context.Context, port int, managementKey string, action string) (int, error) {
	if port <= 0 || port > 65535 {
		return 0, fmt.Errorf("invalid server port")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	client := &http.Client{Timeout: 3 * time.Second}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		fmt.Sprintf("http://127.0.0.1:%d%s?action=%s", port, DrainPath, action),
		nil,
	)
	if err != nil {
		return 0, err
	}
	if key := strings.TrimSpace(managementKey); key != "" {
		request.Header.Set("Authorization", "Bearer "+key)
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return 0, fmt.Errorf("drain request failed: HTTP %d", response.StatusCode)
	}
	var payload struct {
		OK              bool `json:"ok"`
		ActiveInference int  `json:"active_inference"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, maxReadyzBytes)).Decode(&payload) != nil || !payload.OK {
		return 0, fmt.Errorf("drain response invalid")
	}
	return payload.ActiveInference, nil
}

func ActiveInference(ctx context.Context, port int) int {
	if port <= 0 || port > 65535 {
		return 0
	}
	if ctx == nil {
		ctx = context.Background()
	}
	client := &http.Client{Timeout: 2 * time.Second}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		fmt.Sprintf("http://127.0.0.1:%d/readyz", port),
		nil,
	)
	if err != nil {
		return 0
	}
	response, err := client.Do(request)
	if err != nil {
		return 0
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return 0
	}
	var payload struct {
		ActiveInference int `json:"active_inference"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, maxReadyzBytes)).Decode(&payload) != nil {
		return 0
	}
	return payload.ActiveInference
}
