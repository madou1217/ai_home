package zcoderelay

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

// 上游的业务失败是 **HTTP 200 + JSON**（例如 {"code":1005,"msg":"exceed quota limit"}）。
// 不拦就会被当成模型答案交给客户端；Node 侧有 detectUpstreamBusinessFailure，Go 之前漏了。
const maxSniffBytes = 4096

// TransformResponse 拦截「200 + 业务错误体」，其余原样透传。
func (provider *Provider) TransformResponse(
	response http.ResponseWriter,
	upstream *http.Response,
	streaming bool,
) (bool, error) {
	if upstream == nil || upstream.Body == nil {
		return false, nil
	}
	reader := bufio.NewReaderSize(upstream.Body, maxSniffBytes)
	prefix, _ := reader.Peek(maxSniffBytes)
	if failure, ok := detectBusinessFailure(prefix); ok {
		response.Header().Set("Content-Type", "application/json")
		response.Header().Set("Cache-Control", "no-store")
		status := http.StatusBadGateway
		if failure.Quota {
			status = http.StatusTooManyRequests
		}
		response.WriteHeader(status)
		payload, _ := json.Marshal(map[string]any{
			"error": map[string]any{
				"message": failure.Message,
				"type":    "zcode_business_error",
				"code":    failure.Code,
			},
		})
		_, err := response.Write(payload)
		return true, err
	}
	// 不是业务错误：原样交付（bufio 会重放已 Peek 的字节）。
	response.WriteHeader(upstream.StatusCode)
	_, err := ioCopy(response, reader)
	return true, err
}

type businessFailure struct {
	Code    string
	Message string
	Quota   bool
}

// detectBusinessFailure 只认「JSON 对象 + 数字 code + 字符串 msg，且没有 chat 结果字段」。
func detectBusinessFailure(prefix []byte) (businessFailure, bool) {
	trimmed := strings.TrimSpace(string(prefix))
	if !strings.HasPrefix(trimmed, "{") {
		return businessFailure{}, false
	}
	var document map[string]any
	if err := json.Unmarshal([]byte(trimmed), &document); err != nil {
		// 流式正文被截断时解析失败：不判定为业务错误（交给正常交付）。
		return businessFailure{}, false
	}
	if _, ok := document["choices"]; ok {
		return businessFailure{}, false
	}
	if _, ok := document["content"]; ok {
		return businessFailure{}, false
	}
	code, ok := document["code"]
	if !ok {
		return businessFailure{}, false
	}
	message := ""
	if text, ok := document["msg"].(string); ok {
		message = strings.TrimSpace(text)
	} else if text, ok := document["message"].(string); ok {
		message = strings.TrimSpace(text)
	}
	if message == "" {
		return businessFailure{}, false
	}
	codeText := fmt.Sprint(code)
	quota := codeText == "1005" || strings.Contains(strings.ToLower(message), "quota") || strings.Contains(strings.ToLower(message), "limit")
	return businessFailure{Code: codeText, Message: message, Quota: quota}, true
}

func ioCopy(destination http.ResponseWriter, source *bufio.Reader) (int64, error) {
	buffer := make([]byte, 32*1024)
	var written int64
	for {
		read, readErr := source.Read(buffer)
		if read > 0 {
			n, writeErr := destination.Write(buffer[:read])
			written += int64(n)
			if writeErr != nil {
				return written, writeErr
			}
			if flusher, ok := destination.(http.Flusher); ok {
				flusher.Flush()
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				return written, nil
			}
			return written, readErr
		}
	}
}

var _ relaycore.ResponseTransformer = (*Provider)(nil)
