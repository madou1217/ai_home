package codexresponseshttp

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

const capacityEvent = "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"Selected model is at capacity. Please try a different model.\"}}}\r\n\r\n"

func TestPrecommitCapacityRetriesSameRequestOnAnotherAccount(testContext *testing.T) {
	for _, sample := range []struct {
		name, mediaType, failure, success string
	}{
		{name: "sse", mediaType: "text/event-stream", failure: "data: {\"type\":\"response.created\",\"response\":{\"id\":\"failed-attempt\",\"output\":[]}}\r\n\r\n" + capacityEvent, success: completedEvent},
		{name: "json", mediaType: "application/json", failure: `{"status":"failed","error":{"code":"model_at_capacity","message":"private capacity detail"}}`, success: `{ "status":"completed", "future":9007199254740993 }`},
	} {
		testContext.Run(sample.name, func(testCase *testing.T) {
			payload := `{ "model":"gpt-native", "stream":true, "store":false, "input":[], "service_tier":"priority", "future":9007199254740993 }`
			var accounts []string
			upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				body, _ := io.ReadAll(request.Body)
				if string(body) != payload {
					testCase.Errorf("retry changed the model, tier or request bytes: %s", body)
				}
				accounts = append(accounts, request.Header.Get("Authorization"))
				response.Header().Set("Content-Type", sample.mediaType)
				if len(accounts) == 1 {
					response.Header().Set("X-Request-Id", "failed-request")
					_, _ = io.WriteString(response, sample.failure)
					return
				}
				response.Header().Set("X-Request-Id", "successful-request")
				_, _ = io.WriteString(response, sample.success)
			}))
			defer upstream.Close()
			handler, recorder, source := fixture(testCase, upstream.URL, 2)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, nativeRequestFor([]byte(payload)))
			if len(accounts) != 2 || accounts[0] == accounts[1] || response.Code != 200 || response.Body.String() != sample.success {
				testCase.Fatalf("accounts=%v status=%d body=%q", accounts, response.Code, response.Body.String())
			}
			if response.Header().Get("X-Request-Id") != "successful-request" || response.Header().Get(inferenceapi.ServedAccountRefHeader) != string(source.selections[1].AccountRef) {
				testCase.Fatal("failed attempt headers escaped to the client")
			}
			if len(recorder.failures) != 1 || recorder.failures[0].RuntimeKind() != runtimecore.FailureModelOverloaded || len(recorder.successes) != 1 {
				testCase.Fatalf("failures=%d successes=%d", len(recorder.failures), len(recorder.successes))
			}
		})
	}
}

func TestPrecommitCapacityExhaustionPreservesLastErrorOnce(testContext *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls++
		response.Header().Set("Content-Type", "text/event-stream")
		response.Header().Set("X-Request-Id", request.Header.Get("Authorization"))
		_, _ = io.WriteString(response, capacityEvent)
	}))
	defer upstream.Close()
	handler, recorder, source := fixture(testContext, upstream.URL, 2)
	var reports []FailureReport
	handler.FailureLog = func(report FailureReport) { reports = append(reports, report) }
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, nativeRequestFor([]byte(`{"model":"gpt-native","stream":true}`)))
	if calls != 2 || response.Code != 200 || response.Body.String() != capacityEvent || response.Header().Get(inferenceapi.ServedAccountRefHeader) != string(source.selections[1].AccountRef) {
		testContext.Fatalf("calls=%d status=%d body=%q", calls, response.Code, response.Body.String())
	}
	if len(recorder.failures) != 2 || len(recorder.successes) != 0 {
		testContext.Fatalf("failures=%d successes=%d", len(recorder.failures), len(recorder.successes))
	}
	if len(reports) != 1 || len(reports[0].Attempts) != 2 || reports[0].Attempts[0].Kind != string(runtimecore.FailureModelOverloaded) {
		testContext.Fatalf("failure report=%+v", reports)
	}
}

func TestCapacityAfterSemanticOutputDoesNotReplay(testContext *testing.T) {
	for _, first := range []string{
		`{"type":"response.output_text.delta","delta":"already visible"}`,
		`{"type":"response.output_item.added","item":{"type":"function_call","call_id":"already delivered"}}`,
		`{"type":"response.created","response":{"output":[{"type":"message"}]}}`,
	} {
		testContext.Run(first, func(testCase *testing.T) {
			calls := 0
			body := "data: " + first + "\r\n\r\n" + capacityEvent
			upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				calls++
				response.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(response, body)
			}))
			defer upstream.Close()
			handler, recorder, _ := fixture(testCase, upstream.URL, 2)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, nativeRequestFor([]byte(`{"model":"gpt-native","stream":true}`)))
			if calls != 1 || response.Body.String() != body || len(recorder.failures) != 1 || recorder.failures[0].RuntimeKind() != runtimecore.FailureModelOverloaded {
				testCase.Fatalf("calls=%d failures=%d body=%q", calls, len(recorder.failures), response.Body.String())
			}
		})
	}
}

func TestNonRetryablePrecommitErrorDoesNotRotateAccounts(testContext *testing.T) {
	calls := 0
	body := "data: {\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"invalid input\"}}\r\n\r\n"
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls++
		response.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(response, body)
	}))
	defer upstream.Close()
	handler, recorder, _ := fixture(testContext, upstream.URL, 2)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, nativeRequestFor([]byte(`{"model":"gpt-native","stream":true}`)))
	if calls != 1 || response.Body.String() != body || strings.Count(response.Body.String(), "invalid input") != 1 || len(recorder.failures) != 1 {
		testContext.Fatalf("calls=%d failures=%d body=%q", calls, len(recorder.failures), response.Body.String())
	}
}
