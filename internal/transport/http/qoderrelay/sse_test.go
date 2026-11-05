package qoderrelay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

func runTransform(t *testing.T, input, model string) (string, error) {
	t.Helper()
	var output bytes.Buffer
	err := TransformSSE(context.Background(), strings.NewReader(input), &output, model)
	return output.String(), err
}

func envelopeFrame(t *testing.T, fields map[string]any) string {
	t.Helper()
	raw, err := json.Marshal(fields)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	return "data: " + string(raw) + "\n\n"
}

func TestTransformSSEEnvelope(t *testing.T) {
	inner := `{"id":"chatcmpl-1","object":"chat.completion.chunk","model":"qwen3","choices":[{"index":0,"delta":{"content":"hi"}}]}`
	input := "event: message\nid: 42\n" + envelopeFrame(t, map[string]any{
		"headers":         map[string]string{"x-test": "1"},
		"body":            inner,
		"statusCodeValue": 200,
		"statusCode":      200,
	})

	got, err := runTransform(t, input, "")
	if err != nil {
		t.Fatalf("TransformSSE: %v", err)
	}
	want := "data: " + inner + "\n\n"
	if got != want {
		t.Fatalf("output mismatch\n got: %q\nwant: %q", got, want)
	}
}

func TestTransformSSEPlainChunk(t *testing.T) {
	chunk := `{"id":"chatcmpl-2","model":"plain","choices":[{"index":0,"delta":{"content":"yo"}}]}`
	got, err := runTransform(t, "data: "+chunk+"\n\n", "")
	if err != nil {
		t.Fatalf("TransformSSE: %v", err)
	}
	want := "data: " + chunk + "\n\n"
	if got != want {
		t.Fatalf("output mismatch\n got: %q\nwant: %q", got, want)
	}
}

func TestTransformSSEMultiLineData(t *testing.T) {
	input := "data: {\"id\":\"chatcmpl-3\",\ndata: \"model\":\"multi\",\"choices\":[]}\n\n"
	got, err := runTransform(t, input, "")
	if err != nil {
		t.Fatalf("TransformSSE: %v", err)
	}
	want := "data: {\"id\":\"chatcmpl-3\",\n\"model\":\"multi\",\"choices\":[]}\n\n"
	if got != want {
		t.Fatalf("output mismatch\n got: %q\nwant: %q", got, want)
	}
}

func TestTransformSSEDone(t *testing.T) {
	cases := []struct {
		name  string
		input string
	}{
		{name: "plain", input: "data: [DONE]\n\ndata: {\"id\":\"late\"}\n\n"},
		{name: "envelope", input: envelopeFrame(t, map[string]any{
			"body":            "[DONE]",
			"statusCodeValue": 200,
		}) + "data: {\"id\":\"late\"}\n\n"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := runTransform(t, testCase.input, "")
			if err != nil {
				t.Fatalf("TransformSSE: %v", err)
			}
			if got != "data: [DONE]\n\n" {
				t.Fatalf("output mismatch: got %q", got)
			}
		})
	}
}

func TestTransformSSEErrorEnvelope(t *testing.T) {
	cases := []struct {
		name        string
		input       string
		wantStatus  int
		wantCode    string
		wantMessage string
	}{
		{
			name: "status with structured body",
			input: envelopeFrame(t, map[string]any{
				"body":            `{"error":{"code":"RESOURCE_LIMIT","message":"queue full"}}`,
				"statusCodeValue": 529,
			}),
			wantStatus:  529,
			wantCode:    "RESOURCE_LIMIT",
			wantMessage: "queue full",
		},
		{
			name: "statusCode fallback with text body",
			input: envelopeFrame(t, map[string]any{
				"body":       "bad gateway",
				"statusCode": 502,
			}),
			wantStatus:  502,
			wantCode:    upstreamErrorCode,
			wantMessage: "bad gateway",
		},
		{
			name: "error field on 200 envelope",
			input: envelopeFrame(t, map[string]any{
				"statusCodeValue": 200,
				"error":           map[string]string{"code": "AUTH", "message": "denied"},
			}),
			wantStatus:  200,
			wantCode:    "AUTH",
			wantMessage: "denied",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := runTransform(t, testCase.input, "")
			if err == nil {
				t.Fatal("expected error, got nil")
			}
			var streamErr *StreamError
			if !errors.As(err, &streamErr) {
				t.Fatalf("expected *StreamError, got %T: %v", err, err)
			}
			if streamErr.StatusCode != testCase.wantStatus {
				t.Fatalf("status = %d, want %d", streamErr.StatusCode, testCase.wantStatus)
			}
			if streamErr.Code != testCase.wantCode {
				t.Fatalf("code = %q, want %q", streamErr.Code, testCase.wantCode)
			}
			if streamErr.Message != testCase.wantMessage {
				t.Fatalf("message = %q, want %q", streamErr.Message, testCase.wantMessage)
			}
		})
	}
}

func TestTransformSSEInvalidInnerBody(t *testing.T) {
	input := envelopeFrame(t, map[string]any{
		"body":            "not json",
		"statusCodeValue": 200,
	})
	_, err := runTransform(t, input, "")
	if !errors.Is(err, errInvalidStream) {
		t.Fatalf("expected errInvalidStream, got %v", err)
	}
}

func TestTransformSSEModelAlignment(t *testing.T) {
	inner := `{"id":"chatcmpl-4","object":"chat.completion.chunk","model":"upstream-model","choices":[{"index":0,"delta":{"content":"a<b"}}]}`
	got, err := runTransform(t, envelopeFrame(t, map[string]any{
		"body":            inner,
		"statusCodeValue": 200,
	}), "client-model")
	if err != nil {
		t.Fatalf("TransformSSE: %v", err)
	}
	if !strings.HasPrefix(got, "data: ") || !strings.HasSuffix(got, "\n\n") {
		t.Fatalf("unexpected frame shape: %q", got)
	}
	if strings.Contains(got, "upstream-model") {
		t.Fatalf("model was not rewritten: %q", got)
	}
	if !strings.Contains(got, "a<b") {
		t.Fatalf("content was HTML-escaped: %q", got)
	}

	var chunk map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSuffix(strings.TrimPrefix(got, "data: "), "\n\n")), &chunk); err != nil {
		t.Fatalf("decode output chunk: %v", err)
	}
	if chunk["model"] != "client-model" {
		t.Fatalf("model = %v, want client-model", chunk["model"])
	}
	if chunk["id"] != "chatcmpl-4" {
		t.Fatalf("id = %v, want chatcmpl-4", chunk["id"])
	}
}

func TestTransformSSEDropsTimingFrame(t *testing.T) {
	input := envelopeFrame(t, map[string]any{
		"firstTokenDuration": 792,
		"totalDuration":      2079,
		"serverDuration":     59,
	})
	got, err := runTransform(t, input, "")
	if err != nil {
		t.Fatalf("TransformSSE: %v", err)
	}
	if got != "" {
		t.Fatalf("timing frame leaked downstream: %q", got)
	}
}

func TestTransformSSESizeLimit(t *testing.T) {
	t.Run("single frame", func(t *testing.T) {
		input := "data: " + strings.Repeat("a", maxSSEDataBytes+1) + "\n\n"
		_, err := runTransform(t, input, "")
		if !errors.Is(err, errStreamTooLarge) {
			t.Fatalf("expected errStreamTooLarge, got %v", err)
		}
	})

	t.Run("multi-line total", func(t *testing.T) {
		half := strings.Repeat("a", maxSSEDataBytes/2+1)
		input := "data: " + half + "\ndata: " + half + "\n\n"
		_, err := runTransform(t, input, "")
		if !errors.Is(err, errStreamTooLarge) {
			t.Fatalf("expected errStreamTooLarge, got %v", err)
		}
	})
}

func TestTransformSSEPartialTrailingEvent(t *testing.T) {
	chunk := `{"id":"eof","choices":[]}`
	got, err := runTransform(t, "data: "+chunk, "")
	if err != nil {
		t.Fatalf("TransformSSE: %v", err)
	}
	if got != "data: "+chunk+"\n\n" {
		t.Fatalf("output mismatch: %q", got)
	}
}

func TestTransformSSEPreCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	var output bytes.Buffer
	err := TransformSSE(ctx, strings.NewReader("data: {\"id\":\"1\"}\n\n"), &output, "")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
	if output.Len() != 0 {
		t.Fatalf("expected no output, got %q", output.String())
	}
}

func TestTransformSSECancelMidStream(t *testing.T) {
	upstream := &blockingReadCloser{
		pending: []byte("data: {\"id\":\"1\",\"choices\":[]}\n\n"),
		closed:  make(chan struct{}),
	}
	writer := &flushRecorder{wrote: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		errCh <- TransformSSE(ctx, upstream, writer, "")
	}()

	select {
	case <-writer.wrote:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for first event")
	}
	cancel()

	select {
	case err := <-errCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected context.Canceled, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("TransformSSE did not return after cancellation")
	}

	if got := writer.String(); got != "data: {\"id\":\"1\",\"choices\":[]}\n\n" {
		t.Fatalf("unexpected output: %q", got)
	}
}

func TestTransformSSEFlushesEachEvent(t *testing.T) {
	writer := &flushRecorder{wrote: make(chan struct{})}
	input := "data: {\"id\":\"1\",\"choices\":[]}\n\ndata: {\"id\":\"2\",\"choices\":[]}\n\n"
	if err := TransformSSE(context.Background(), strings.NewReader(input), writer, ""); err != nil {
		t.Fatalf("TransformSSE: %v", err)
	}
	if writer.flushes != 2 {
		t.Fatalf("flushes = %d, want 2", writer.flushes)
	}
}

type flushRecorder struct {
	bytes.Buffer
	flushes int
	wrote   chan struct{}
	once    sync.Once
}

func (w *flushRecorder) Write(p []byte) (int, error) {
	n, err := w.Buffer.Write(p)
	w.once.Do(func() { close(w.wrote) })
	return n, err
}

func (w *flushRecorder) Flush() {
	w.flushes++
}

type blockingReadCloser struct {
	pending []byte
	closed  chan struct{}
	once    sync.Once
}

func (r *blockingReadCloser) Read(p []byte) (int, error) {
	if len(r.pending) > 0 {
		n := copy(p, r.pending)
		r.pending = r.pending[n:]
		return n, nil
	}
	<-r.closed
	return 0, io.ErrClosedPipe
}

func (r *blockingReadCloser) Close() error {
	r.once.Do(func() { close(r.closed) })
	return nil
}
