package providercli

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
)

const maxProviderRequestBody = 128 << 20

var hopByHopHeaders = map[string]struct{}{
	"Connection":          {},
	"Keep-Alive":          {},
	"Proxy-Authenticate":  {},
	"Proxy-Authorization": {},
	"Te":                  {},
	"Trailer":             {},
	"Transfer-Encoding":   {},
	"Upgrade":             {},
}

// readReplayableBody 为最多一次 OAuth 刷新重试保存请求正文。
func readReplayableBody(request *http.Request) ([]byte, error) {
	if request.Body == nil {
		return nil, nil
	}
	defer request.Body.Close()
	body, err := io.ReadAll(io.LimitReader(request.Body, maxProviderRequestBody+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxProviderRequestBody {
		return nil, errors.New("Provider 请求正文超过本地代理上限")
	}
	return body, nil
}

// newForwardRequest 复制业务请求并移除逐跳头，目标始终来自受信规划结果。
func newForwardRequest(
	ctx context.Context,
	incoming *http.Request,
	target *url.URL,
	body []byte,
) (*http.Request, error) {
	forwardURL := *target
	forwardURL.Path = joinURLPath(target.Path, incoming.URL.Path)
	forwardURL.RawQuery = incoming.URL.RawQuery
	request, err := http.NewRequestWithContext(
		ctx,
		incoming.Method,
		forwardURL.String(),
		bytes.NewReader(body),
	)
	if err != nil {
		return nil, err
	}
	copyHeaders(request.Header, incoming.Header)
	removeHopByHopHeaders(request.Header)
	request.Host = target.Host
	return request, nil
}

// joinURLPath 只连接已校验根路径和入站路径，不重新解释目标主机。
func joinURLPath(base string, request string) string {
	return strings.TrimSuffix(base, "/") + "/" + strings.TrimPrefix(request, "/")
}

// copyHeaders 深复制全部 Header 值，避免共享底层切片。
func copyHeaders(destination http.Header, source http.Header) {
	for name, values := range source {
		for _, value := range values {
			destination.Add(name, value)
		}
	}
}

// removeHopByHopHeaders 删除 RFC 7230 不允许代理逐跳转发的 Header。
func removeHopByHopHeaders(header http.Header) {
	for _, value := range header.Values("Connection") {
		for _, name := range strings.Split(value, ",") {
			header.Del(strings.TrimSpace(name))
		}
	}
	for name := range hopByHopHeaders {
		header.Del(name)
	}
}

// writeForwardResponse 保留上游状态、头和 SSE flush 语义。
func writeForwardResponse(writer http.ResponseWriter, response *http.Response) {
	defer response.Body.Close()
	removeHopByHopHeaders(response.Header)
	copyHeaders(writer.Header(), response.Header)
	writer.WriteHeader(response.StatusCode)
	buffer := make([]byte, 32<<10)
	for {
		read, readErr := response.Body.Read(buffer)
		if read > 0 {
			_, _ = writer.Write(buffer[:read])
			if flusher, ok := writer.(http.Flusher); ok {
				flusher.Flush()
			}
		}
		if readErr != nil {
			return
		}
	}
}

// writeProxyError 返回不包含目标地址、Token 或内部错误的稳定 JSON。
func writeProxyError(writer http.ResponseWriter, status int, message string) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_, _ = io.WriteString(writer, `{"error":{"type":"aih_proxy_error","message":"`+message+`"}}`)
}
