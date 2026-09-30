package codexresponseshttp

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

func TestSafetyInsideSuccessfulHTTPEnvelope(testContext *testing.T) {
	errorJSON := `{"error":{"code":"content_policy_violation","message":"private safety reason"}}`
	for _, sample := range []struct {
		name, mediaType, body string
	}{
		{name: "json", mediaType: "application/json", body: errorJSON},
		{name: "sse", mediaType: "text/event-stream", body: "data: {\"type\":\"response.created\",\"response\":{\"output\":[]}}\n\n" + "data: {\"type\":\"error\"," + errorJSON[1:] + "\n\n"},
	} {
		testContext.Run(sample.name, func(testCase *testing.T) {
			calls := 0
			upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				calls++
				response.Header().Set("Content-Type", sample.mediaType)
				_, _ = io.WriteString(response, sample.body)
			}))
			defer upstream.Close()
			handler, recorder, _ := fixture(testCase, upstream.URL, 2)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, nativeRequestFor([]byte(`{"model":"gpt-native","stream":true}`)))
			if response.Code != 403 || calls != 1 || strings.Contains(response.Body.String(), "private safety reason") || !strings.Contains(response.Body.String(), "upstream_safety_rejected") {
				testCase.Fatalf("status=%d calls=%d body=%s", response.Code, calls, response.Body.String())
			}
			if len(recorder.failures) != 1 || recorder.failures[0].RuntimeKind() != runtimecore.FailureSafetyRejected || len(recorder.successes) != 0 {
				testCase.Fatal("safety outcome was not recorded exactly once")
			}
		})
	}
}

func TestResponseProbePreservesBytesAndBoundsLookahead(testContext *testing.T) {
	preamble := "data: {\"type\":\"response.created\",\"response\":{\"output\":[]}}\r\n\r\n"
	safety := "data: {\"type\":\"error\",\"error\":{\"code\":\"content_policy_violation\"}}\r\n\r\n"
	for _, sample := range []struct {
		name, mediaType, body string
	}{
		{name: "json", mediaType: "application/json", body: `{ "status":"completed", "future":9007199254740993 }`},
		{name: "large-json", mediaType: "application/json", body: `{"status":"completed","future":"` + strings.Repeat("x", 2*1024*1024) + `"}`},
		{name: "unknown-event", mediaType: "text/event-stream", body: ": keepalive\r\nevent: future\r\ndata: {\"opaque\":9007199254740993}\r\n\r\n" + completedEvent},
		{name: "first-output-commits", mediaType: "text/event-stream", body: "data: {\"type\":\"response.output_text.delta\",\"delta\":\"answer\"}\r\n\r\n" + safety},
		{name: "populated-preamble-commits", mediaType: "text/event-stream", body: "data: {\"type\":\"response.created\",\"response\":{\"output\":[{}]}}\r\n\r\n" + safety},
		{name: "preamble-count-bound", mediaType: "text/event-stream", body: strings.Repeat(preamble, 17) + safety},
		{name: "preamble-byte-bound", mediaType: "text/event-stream", body: ":" + strings.Repeat("x", 70*1024) + "\r\n\r\n" + safety},
	} {
		testContext.Run(sample.name, func(testCase *testing.T) {
			handler, _, _ := fixture(testCase, "http://127.0.0.1:1/v1", 1)
			upstream := &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{sample.mediaType}}, Body: io.NopCloser(strings.NewReader(sample.body))}
			defer upstream.Body.Close()
			if failure := handler.probeResponse(upstream, true); failure.IsValid() {
				testCase.Fatal("probe crossed its commit boundary")
			}
			body, err := io.ReadAll(upstream.Body)
			if err != nil || string(body) != sample.body {
				testCase.Fatal("lookahead changed or lost response bytes")
			}
		})
	}
}
