package codexresponseshttp

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 失败摘要：每个失败出口恰好一份，含各次尝试的账号与失败类别；成功不汇报；不含凭据与上游正文。

func withFailureLog(handler *Handler) *[]FailureReport {
	reports := &[]FailureReport{}
	handler.FailureLog = func(report FailureReport) { *reports = append(*reports, report) }
	return reports
}

func TestFailureReportListsEveryAttemptWhenAccountsAreExhausted(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(503)
		_, _ = io.WriteString(response, `{"error":{"message":"private upstream body","code":"server_is_overloaded"}}`)
	}))
	defer upstream.Close()
	handler, _, _ := fixture(t, upstream.URL, 2)
	reports := withFailureLog(handler)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, nativeRequestFor([]byte(`{"model":"gpt-native"}`)))
	if response.Code != 503 || len(*reports) != 1 {
		t.Fatalf("status=%d reports=%d", response.Code, len(*reports))
	}
	report := (*reports)[0]
	if report.Status != 503 || report.Code != "upstream_status" || report.Model != "gpt-native" || len(report.Attempts) != 2 {
		t.Fatalf("report=%+v", report)
	}
	for index, attempt := range report.Attempts {
		if attempt.AccountRef != fmt.Sprintf("acct_%020x", index+1) || attempt.Outcome != "http_503" || attempt.Kind == "" {
			t.Fatalf("attempt %d=%+v", index, attempt)
		}
	}
	if text := fmt.Sprintf("%+v", report); strings.Contains(text, "private upstream body") || strings.Contains(text, "synthetic-upstream") {
		t.Fatalf("report leaks upstream body or credential: %s", text)
	}
}

func TestFailureReportExplainsTransportFailuresBehindA502(t *testing.T) {
	closed := httptest.NewServer(http.NotFoundHandler())
	url := closed.URL
	closed.Close()
	handler, _, _ := fixture(t, url, 2)
	reports := withFailureLog(handler)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, nativeRequestFor([]byte(`{"model":"gpt-native"}`)))
	if response.Code != 502 || len(*reports) != 1 {
		t.Fatalf("status=%d reports=%d", response.Code, len(*reports))
	}
	report := (*reports)[0]
	if report.Status != 502 || report.Code != "upstream_temporarily_unavailable" || len(report.Attempts) != 2 {
		t.Fatalf("report=%+v", report)
	}
	for _, attempt := range report.Attempts {
		if attempt.Outcome != "transport" || attempt.Detail == "" || strings.ContainsAny(attempt.Detail, "\n\r") {
			t.Fatalf("attempt=%+v", attempt)
		}
		if strings.Contains(attempt.Detail, "synthetic-upstream") {
			t.Fatalf("detail leaks credential: %s", attempt.Detail)
		}
	}
}

func TestFailureReportCoversSafetyRejectionAndMissingAccounts(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.WriteHeader(400)
		_, _ = io.WriteString(response, `{"error":{"code":"content_policy_violation","message":"private safety reason"}}`)
	}))
	defer upstream.Close()
	handler, _, _ := fixture(t, upstream.URL, 2)
	reports := withFailureLog(handler)
	handler.ServeHTTP(httptest.NewRecorder(), nativeRequestFor([]byte(`{"model":"gpt-native"}`)))
	if len(*reports) != 1 || (*reports)[0].Status != 403 || (*reports)[0].Code != "upstream_safety_rejected" || len((*reports)[0].Attempts) != 1 {
		t.Fatalf("safety report=%+v", *reports)
	}

	empty, _, _ := fixture(t, upstream.URL, 0)
	emptyReports := withFailureLog(empty)
	empty.ServeHTTP(httptest.NewRecorder(), nativeRequestFor([]byte(`{"model":"gpt-native"}`)))
	if len(*emptyReports) != 1 || (*emptyReports)[0].Status != 503 || (*emptyReports)[0].Code != "no_available_account" || len((*emptyReports)[0].Attempts) != 0 {
		t.Fatalf("no-account report=%+v", *emptyReports)
	}
}

func TestSuccessfulResponsesAreNotReported(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(response, `{"id":"resp_1","object":"response","status":"completed","output":[]}`)
	}))
	defer upstream.Close()
	handler, _, _ := fixture(t, upstream.URL, 1)
	reports := withFailureLog(handler)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, nativeRequestFor([]byte(`{"model":"gpt-native"}`)))
	if response.Code != 200 || len(*reports) != 0 {
		t.Fatalf("status=%d reports=%+v", response.Code, *reports)
	}
}
