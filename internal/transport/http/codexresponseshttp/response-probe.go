package codexresponseshttp

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"net/http"

	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/internal/adapters/attemptfailure"
	codexfailure "github.com/madou1217/ai_home/internal/adapters/codex/upstreamfailure"
	sharedsse "github.com/madou1217/ai_home/internal/adapters/sse"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

type replayBody struct {
	io.Reader
	io.Closer
}

func (handler *Handler) probeResponse(upstream *http.Response, stream bool) inferencegateway.AttemptFailure {
	mediaType, _, _ := mime.ParseMediaType(upstream.Header.Get("Content-Type"))
	streaming := mediaType == "text/event-stream" || (mediaType == "" && stream)
	limit := int64(1024 * 1024)
	if streaming {
		limit = 64 * 1024
	}
	body := upstream.Body
	var prefix bytes.Buffer
	source := io.TeeReader(io.LimitReader(body, limit+1), &prefix)
	defer func() {
		upstream.Body = replayBody{Reader: io.MultiReader(bytes.NewReader(prefix.Bytes()), body), Closer: body}
	}()
	if !streaming {
		payload, err := io.ReadAll(source)
		if err != nil || int64(len(payload)) > limit {
			return inferencegateway.AttemptFailure{}
		}
		observed := *upstream
		observed.Body = io.NopCloser(bytes.NewReader(payload))
		classification, err := codexfailure.ObserveHTTP(&observed, handler.Clock())
		if err != nil {
			return inferencegateway.AttemptFailure{}
		}
		failure, _ := attemptfailure.New(classification)
		return failure
	}
	reader, err := sharedsse.NewReader(source)
	if err != nil {
		return inferencegateway.AttemptFailure{}
	}
	for count := 0; count <= 16; count++ {
		event, err := reader.Next()
		if err != nil || int64(prefix.Len()) > limit {
			return inferencegateway.AttemptFailure{}
		}
		classification, failed, err := codexfailure.ObserveSSE(sharedfailure.SSEInput{
			EventType: event.Type(), Data: bytes.NewReader(event.Data()), Header: upstream.Header, ObservedAt: handler.Clock(),
		})
		if failed && err == nil {
			failure, _ := attemptfailure.New(classification)
			return failure
		}
		if !isResponsePreamble(event) {
			return inferencegateway.AttemptFailure{}
		}
	}
	return inferencegateway.AttemptFailure{}
}

func isResponsePreamble(event sharedsse.Event) bool {
	var envelope struct {
		Type     string `json:"type"`
		Response *struct {
			Output json.RawMessage `json:"output"`
		} `json:"response"`
	}
	if json.Unmarshal(event.Data(), &envelope) != nil {
		return false
	}
	if envelope.Type == "" {
		envelope.Type = event.Type()
	}
	switch envelope.Type {
	case "response.created", "response.in_progress", "response.queued":
		if envelope.Response == nil || len(envelope.Response.Output) == 0 || bytes.Equal(envelope.Response.Output, []byte("null")) {
			return true
		}
		var output []json.RawMessage
		return json.Unmarshal(envelope.Response.Output, &output) == nil && len(output) == 0
	default:
		return false
	}
}
