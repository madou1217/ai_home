package serverprobe

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const maxReadyzBytes = 64 * 1024

// ActiveInference 读取本地 aih-server 当前仍在生成的推理流数量。
//
// 该探针只用于重启前保护：读不到、旧版本没有字段或请求失败都返回 0，
// 保持原有生命周期的兼容行为；只有服务端明确报告大于 0 时才阻止重启。
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
