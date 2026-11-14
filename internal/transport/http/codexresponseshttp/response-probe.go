package codexresponseshttp

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"sync"
	"time"

	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/internal/adapters/attemptfailure"
	codexfailure "github.com/madou1217/ai_home/internal/adapters/codex/upstreamfailure"
	sharedsse "github.com/madou1217/ai_home/internal/adapters/sse"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
	"github.com/madou1217/ai_home/internal/adapters/upstreamfailure/configured"
)

// nativeProbeWindow 是流式响应在写响应头之前允许等待首个正文事件的时长。
//
// 上游会先发 response.created 之类的首帧，然后进入长时间推理；这段时间客户端
// 收不到任何字节，中间层按「源站无响应」计时。窗口到期后不再等正文，直接提交
// 当前账号并开始交付（含心跳），把 TTFB 静默压到窗口内。
const nativeProbeWindow = 2 * time.Second

// errProbeTimeout 是 probe 窗口到期的内部哨兵，不会出现在交付路径上。
var errProbeTimeout = errors.New("probe window elapsed")

// probeResult 是流式响应的探测结果。
type probeResult struct {
	// failure 非零表示命中上游错误帧，需要按原流程换号或失败。
	failure inferencegateway.AttemptFailure
	// committed 表示窗口到期、正文尚未开始：调用方必须立即写响应头并提前交付。
	committed bool
}

// streamChunk 是泵交给消费者的一次读取结果。
type streamChunk struct {
	payload []byte
	err     error
}

// bodyPump 用一个 goroutine 独占读取上游 body，probe 与交付共享同一份字节流。
// 没有它，probe 超时后无法把「已读字节 + 剩余流」安全地交给交付路径。
type bodyPump struct {
	chunks chan streamChunk
	stop   chan struct{}
	once   sync.Once
}

func newBodyPump(source io.Reader) *bodyPump {
	pump := &bodyPump{chunks: make(chan streamChunk, 1), stop: make(chan struct{})}
	go func() {
		buffer := make([]byte, 32*1024)
		for {
			count, readErr := source.Read(buffer)
			chunk := streamChunk{err: readErr}
			if count > 0 {
				chunk.payload = append([]byte(nil), buffer[:count]...)
			}
			select {
			case pump.chunks <- chunk:
			case <-pump.stop:
				return
			}
			if readErr != nil {
				return
			}
		}
	}()
	return pump
}

// Close 让泵在下次发送时退出；底层 body 由调用方关闭以解除阻塞的 Read。
func (pump *bodyPump) Close() {
	if pump == nil {
		return
	}
	pump.once.Do(func() { close(pump.stop) })
}

// deadlineReader 把「窗口到期」变成一次可识别的读错误；超时后 pending 与泵队列
// 保持原样，因此同一 reader 可以继续交给交付路径使用。
type deadlineReader struct {
	pump     *bodyPump
	deadline <-chan time.Time
	pending  []byte
	err      error
}

func (reader *deadlineReader) Read(destination []byte) (int, error) {
	for {
		if len(reader.pending) > 0 {
			count := copy(destination, reader.pending)
			reader.pending = reader.pending[count:]
			return count, nil
		}
		if reader.err != nil {
			return 0, reader.err
		}
		select {
		case chunk := <-reader.pump.chunks:
			if len(chunk.payload) > 0 {
				reader.pending = chunk.payload
				reader.err = chunk.err
				continue
			}
			if chunk.err != nil {
				reader.err = chunk.err
				return 0, chunk.err
			}
		case <-reader.deadline:
			return 0, errProbeTimeout
		}
	}
}

// closerFunc 让 replayBody 能在关闭时同时停泵并关闭原始 body。
type closerFunc func() error

func (fn closerFunc) Close() error { return fn() }

// replayBody 把「已读前缀 + 剩余流」重新拼成可交付、可关闭的 body。
type replayBody struct {
	io.Reader
	io.Closer
}

// probeResponse 在写响应头前探测上游流。
//
// 非流式响应保持原样：读完、分类、回放。流式响应在 window 内读取前言事件，
// 一旦命中错误帧就返回失败（调用方仍可换号）；窗口到期则返回 committed，
// 调用方立即写 200 头并开始交付，probe 已消费的字节经 replayBody 原样回放。
func (handler *Handler) probeResponse(
	upstream *http.Response,
	stream bool,
	accountRef string,
	window time.Duration,
) probeResult {
	mediaType, _, _ := mime.ParseMediaType(upstream.Header.Get("Content-Type"))
	streaming := mediaType == "text/event-stream" || (mediaType == "" && stream)
	limit := int64(1024 * 1024)
	if streaming {
		limit = 64 * 1024
	}
	body := upstream.Body
	var prefix bytes.Buffer
	if !streaming {
		source := io.TeeReader(io.LimitReader(body, limit+1), &prefix)
		defer func() {
			upstream.Body = replayBody{Reader: io.MultiReader(bytes.NewReader(prefix.Bytes()), body), Closer: body}
		}()
		payload, err := io.ReadAll(source)
		if err != nil || int64(len(payload)) > limit {
			return probeResult{}
		}
		observed := *upstream
		observed.Body = io.NopCloser(bytes.NewReader(payload))
		classification, err := configured.ClassifyWithRules(
			handler.Rules,
			accountRef,
			observed.StatusCode,
			payload,
			func() (sharedfailure.Classification, error) {
				return codexfailure.ObserveHTTP(&observed, handler.Clock())
			},
		)
		if err != nil {
			return probeResult{}
		}
		failure, _ := attemptfailure.New(classification)
		return probeResult{failure: failure}
	}

	pump := newBodyPump(body)
	timer := time.NewTimer(window)
	probe := &deadlineReader{pump: pump, deadline: timer.C}
	source := io.TeeReader(io.LimitReader(probe, limit+1), &prefix)
	defer func() {
		timer.Stop()
		// 交接后不再有探测窗口：若定时器恰好在返回瞬间触发，残留的通道值会让
		// 交付路径读到一个伪造的超时错误，截断本来正常的流。
		probe.deadline = nil
		upstream.Body = replayBody{
			Reader: io.MultiReader(bytes.NewReader(prefix.Bytes()), probe),
			Closer: closerFunc(func() error {
				pump.Close()
				return body.Close()
			}),
		}
	}()
	reader, err := sharedsse.NewReader(source)
	if err != nil {
		return probeResult{}
	}
	for count := 0; count <= 16; count++ {
		event, err := reader.Next()
		if err != nil {
			if errors.Is(err, errProbeTimeout) {
				return probeResult{committed: true}
			}
			return probeResult{}
		}
		if int64(prefix.Len()) > limit {
			return probeResult{}
		}
		classification, failed, err := configured.ClassifySSEWithRules(
			handler.Rules,
			accountRef,
			http.StatusOK,
			event.Data(),
			func() (sharedfailure.Classification, bool, error) {
				return codexfailure.ObserveSSE(sharedfailure.SSEInput{
					EventType: event.Type(), Data: bytes.NewReader(event.Data()), Header: upstream.Header, ObservedAt: handler.Clock(),
				})
			},
		)
		if failed && err == nil {
			failure, _ := attemptfailure.New(classification)
			return probeResult{failure: failure}
		}
		if !isResponsePreamble(event) {
			return probeResult{}
		}
	}
	return probeResult{}
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
