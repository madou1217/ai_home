package aihserver

import (
	"bytes"
	"log"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/transport/http/codexresponseshttp"
)

func TestCodexResponsesFailureLogIsOneLowSensitivityLine(t *testing.T) {
	var output bytes.Buffer
	logFailure := newCodexResponsesFailureLogger(log.New(&output, "", 0))
	logFailure(codexresponseshttp.FailureReport{
		Model: "gpt-6.1-sol", Status: 502, Code: "upstream_temporarily_unavailable", Elapsed: 9895 * time.Millisecond,
		Attempts: []codexresponseshttp.AttemptReport{
			{AccountRef: "acct_a", Outcome: "transport", Kind: "upstream_unavailable", Code: "upstream_transport_failed", Detail: `Post "https://chatgpt.com/backend-api/codex/responses": EOF`, Elapsed: 4100 * time.Millisecond},
			{AccountRef: "acct_b", Outcome: "http_503", Kind: "upstream_overloaded", Elapsed: 5700 * time.Millisecond},
		},
	})
	line := strings.TrimSpace(output.String())
	want := `Codex Responses failed: status=502 code=upstream_temporarily_unavailable model=gpt-6.1-sol elapsed_ms=9895 attempts=[acct_a:transport kind=upstream_unavailable code=upstream_transport_failed detail="Post \"https://chatgpt.com/backend-api/codex/responses\": EOF" 4100ms; acct_b:http_503 kind=upstream_overloaded 5700ms]`
	if line != want {
		t.Fatalf("got  %s\nwant %s", line, want)
	}
	if newCodexResponsesFailureLogger(nil) != nil {
		t.Fatal("nil logger must disable the hook")
	}
}
