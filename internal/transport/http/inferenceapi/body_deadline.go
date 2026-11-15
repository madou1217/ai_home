package inferenceapi

import (
	"errors"
	"io"
	"net"
	"net/http"
	"time"
)

const (
	// RequestBodyIdleTimeout bounds a stalled upload, not the duration of a
	// progressing long-session request. The host's default ReadTimeout is absolute.
	RequestBodyIdleTimeout = 30 * time.Second
	// RequestBodyTotalTimeout keeps even a continuously progressing upload bounded.
	RequestBodyTotalTimeout = 5 * time.Minute
)

// ErrRequestBodyTimeout distinguishes an incomplete upload from malformed JSON.
var ErrRequestBodyTimeout = errors.New("inference request body upload timed out")

// ReadRequestBody applies idle and total upload deadlines while retaining a
// strict byte limit. It must only run after ingress authentication succeeds.
func ReadRequestBody(response http.ResponseWriter, body io.Reader, maxBytes int64) (payload []byte, err error) {
	if response == nil || body == nil || maxBytes < 1 {
		return nil, ErrInvalidRequestBody
	}
	controller := http.NewResponseController(response)
	defer func() {
		deadline := time.Time{}
		if err != nil {
			// net/http may drain an incomplete body before delivering the error.
			// Never remove its read bound on failure, including near EOF/chunked.
			deadline = time.Now()
			response.Header().Set("Connection", "close")
		}
		_ = controller.SetReadDeadline(deadline)
	}()
	reader := &requestBodyDeadlineReader{
		source:        body,
		controller:    controller,
		totalDeadline: time.Now().Add(RequestBodyTotalTimeout),
	}
	payload, err = io.ReadAll(io.LimitReader(reader, maxBytes+1))
	if int64(len(payload)) > maxBytes {
		return nil, ErrRequestTooLarge
	}
	if err != nil {
		var timeout net.Error
		if errors.As(err, &timeout) && timeout.Timeout() {
			return nil, ErrRequestBodyTimeout
		}
		return nil, ErrInvalidRequestBody
	}
	return payload, nil
}

type requestBodyDeadlineReader struct {
	source        io.Reader
	controller    *http.ResponseController
	totalDeadline time.Time
}

func (reader *requestBodyDeadlineReader) Read(destination []byte) (int, error) {
	deadline := time.Now().Add(RequestBodyIdleTimeout)
	if reader.totalDeadline.Before(deadline) {
		deadline = reader.totalDeadline
	}
	if err := reader.controller.SetReadDeadline(deadline); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return 0, err
	}
	return reader.source.Read(destination)
}
