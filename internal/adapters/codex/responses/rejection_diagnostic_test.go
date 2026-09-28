package responses

import (
	"bytes"
	"io"
	"net/http"
	"strings"
	"testing"
)

// TestReportRejectionExtractsLowSensitivityFields 验证只提取 type/code/param/截断 message，
// 认证与限流错误不报告，且错误体仍可被分类器重读。
func TestReportRejectionExtractsLowSensitivityFields(t *testing.T) {
	t.Parallel()

	var seen []UpstreamRejection
	adapter := &Adapter{rejections: func(rejection UpstreamRejection) { seen = append(seen, rejection) }}
	body := `{"error":{"type":"invalid_request_error","code":"invalid_value","param":"input[7].encrypted_content","message":"` +
		strings.Repeat("x", 400) + `"}}`
	response := &http.Response{StatusCode: http.StatusBadRequest, Body: io.NopCloser(strings.NewReader(body))}
	payload := bufferRejectionBody(response)
	adapter.reportRejection("gpt-6-astra", response.StatusCode, payload)
	replayed, _ := io.ReadAll(response.Body)
	if !bytes.Equal(replayed, []byte(body)) {
		t.Fatal("classifier cannot re-read the buffered body")
	}
	if len(seen) != 1 ||
		seen[0].Param != "input[7].encrypted_content" ||
		seen[0].Code != "invalid_value" ||
		len([]rune(seen[0].Message)) != maxRejectionMessageRunes+1 {
		t.Fatalf("rejection = %#v", seen)
	}
	for _, status := range []int{http.StatusUnauthorized, http.StatusTooManyRequests, http.StatusBadGateway} {
		adapter.reportRejection("gpt-6-astra", status, []byte(body))
	}
	if len(seen) != 1 {
		t.Fatalf("auth/rate-limit/5xx were reported: %#v", seen)
	}
}
