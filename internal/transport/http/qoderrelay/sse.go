// Package qoderrelay 实现 Qoder HTTP 推理通道的协议层。
//
// 本文件只负责 SSE 信封拆包：上游把标准 OpenAI chunk 包在
// {"headers":…,"body":"<chunk JSON>","statusCodeValue":200,…} 里，
// 这里把它还原成下游可直接消费的标准 OpenAI SSE。
package qoderrelay

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
)

const (
	// maxSSEDataBytes 是单条 SSE data 的上限（多行 data 按拼接后计算）。
	maxSSEDataBytes = 4 << 20
	// maxSSELineBytes 给 data 字段前缀与行尾留出余量。
	maxSSELineBytes = maxSSEDataBytes + 8

	// upstreamErrorCode 是信封未给出具体 code 时的兜底错误码（对齐 Node 侧）。
	upstreamErrorCode = "qoder_http_upstream_error"
)

var (
	errStreamTooLarge = fmt.Errorf("qoderrelay: sse data exceeds %d bytes", maxSSEDataBytes)
	errInvalidStream  = errors.New("qoderrelay: invalid upstream sse stream")
)

// StreamError 是信封里携带的上游错误。
type StreamError struct {
	StatusCode int
	Code       string
	Message    string
}

func (e *StreamError) Error() string {
	if e == nil {
		return "qoderrelay: <nil> stream error"
	}
	detail := e.Message
	if detail == "" {
		detail = "upstream error"
	}
	prefix := "qoderrelay: "
	if e.StatusCode != 0 && e.Code != "" {
		return fmt.Sprintf("%sstatus=%d, code=%s: %s", prefix, e.StatusCode, e.Code, detail)
	}
	if e.StatusCode != 0 {
		return fmt.Sprintf("%sstatus=%d: %s", prefix, e.StatusCode, detail)
	}
	if e.Code != "" {
		return prefix + "code=" + e.Code + ": " + detail
	}
	return prefix + detail
}

// TransformSSE 从 upstream 逐行读取 SSE，把解包后的内容写到 writer。
// model 用于对齐每个 chunk 的 model 字段（空则不改）。
// 返回 error 表示上游错误或流格式非法。
//
// 写出粒度是单个 SSE 事件：每写出一条立即 Flush（writer 实现 http.Flusher 时），
// 不会缓冲整条流。遇到 [DONE] 后停止读取。
func TransformSSE(ctx context.Context, upstream io.Reader, writer io.Writer, model string) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	var flusher http.Flusher
	if f, ok := writer.(http.Flusher); ok {
		flusher = f
	}

	stop := make(chan struct{})
	defer close(stop)
	// 读取方通常没有读超时；上下文取消时主动关闭上游，让阻塞中的 Read 立刻返回。
	if closer, ok := upstream.(io.Closer); ok && ctx.Done() != nil {
		go func() {
			select {
			case <-ctx.Done():
				_ = closer.Close()
			case <-stop:
			}
		}()
	}

	reader := newSSELineReader(upstream)
	var data []byte
	hasData := false

	for {
		if err := ctx.Err(); err != nil {
			return err
		}

		line, err := reader.readLine()
		if err != nil {
			if errors.Is(err, io.EOF) {
				if ctxErr := ctx.Err(); ctxErr != nil {
					return ctxErr
				}
				if hasData {
					_, err := transformAndWrite(ctx, writer, flusher, data, model)
					return err
				}
				return nil
			}
			if ctxErr := ctx.Err(); ctxErr != nil {
				return ctxErr
			}
			return err
		}

		if line == "" {
			if !hasData {
				continue
			}
			done, err := transformAndWrite(ctx, writer, flusher, data, model)
			if err != nil {
				return err
			}
			if done {
				return nil
			}
			data = data[:0]
			hasData = false
			continue
		}

		if strings.HasPrefix(line, ":") {
			continue // SSE 注释 / keepalive
		}
		if !strings.HasPrefix(line, "data:") {
			continue // event: / id: / retry: 不参与下游输出
		}

		value := line[len("data:"):]
		if strings.HasPrefix(value, " ") {
			value = value[1:] // 仅去掉一个前导空格，与 SSE 规范一致
		}

		if hasData {
			if len(data)+1+len(value) > maxSSEDataBytes {
				return errStreamTooLarge
			}
			data = append(data, '\n')
		} else if len(value) > maxSSEDataBytes {
			return errStreamTooLarge
		}
		data = append(data, value...)
		hasData = true
	}
}

// transformAndWrite 处理一个完整事件；返回 done 表示已透传 [DONE]。
func transformAndWrite(ctx context.Context, writer io.Writer, flusher http.Flusher, data []byte, model string) (bool, error) {
	payload, done, err := transformData(data, model)
	if err != nil {
		return false, err
	}
	if payload == nil {
		return done, nil
	}
	if err := writeSSEData(ctx, writer, flusher, payload); err != nil {
		return false, err
	}
	return done, nil
}

// transformData 把一个 SSE data 载荷还原成下游 data 内容。
// 返回 nil payload 表示该帧应被丢弃（keepalive / timing 等）。
func transformData(data []byte, model string) (payload []byte, done bool, err error) {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return nil, false, nil
	}
	if bytes.Equal(trimmed, []byte("[DONE]")) {
		return []byte("[DONE]"), true, nil
	}

	fields, isObject := decodeJSONObject(trimmed)
	if !isObject {
		// 非 JSON 的 data 按普通 SSE 原样透传（兼容上游直接返回明文 chunk）。
		return data, false, nil
	}

	status, hasStatus := envelopeStatus(fields)
	if hasStatus && !isSuccessStatus(status) {
		return nil, false, envelopeStreamError(status, fields, data)
	}
	if raw, ok := fields["error"]; ok && !isJSONNull(raw) {
		return nil, false, newStreamError(status, raw)
	}

	if bodyRaw, ok := fields["body"]; ok {
		if inner, ok := jsonString(bodyRaw); ok {
			innerTrimmed := strings.TrimSpace(inner)
			if innerTrimmed == "" {
				return nil, false, nil
			}
			if innerTrimmed == "[DONE]" {
				return []byte("[DONE]"), true, nil
			}
			chunk := []byte(inner)
			if !json.Valid(chunk) {
				return nil, false, fmt.Errorf("%w: envelope body is not valid JSON", errInvalidStream)
			}
			return processChunk(chunk, model, status)
		}
		// body 存在但不是字符串：没有可拆的内层，按普通帧透传。
		return data, false, nil
	}

	if hasStatus || hasTimingFields(fields) {
		// 只有信封元数据（usage timing / 状态帧），下游不需要。
		return nil, false, nil
	}

	return processChunk(trimmed, model, status)
}

// processChunk 校验内层 chunk，并在 model 不一致时对齐（对齐 Node alignQoderChunkModel）。
func processChunk(raw []byte, model string, status int) ([]byte, bool, error) {
	fields, isObject := decodeJSONObject(raw)
	if !isObject {
		// 合法 JSON 但不是对象：没有 error/model 可处理，原样写回。
		return raw, false, nil
	}
	if rawErr, ok := fields["error"]; ok && !isJSONNull(rawErr) {
		return nil, false, newStreamError(status, rawErr)
	}

	if model == "" {
		return raw, false, nil
	}
	rawModel, ok := fields["model"]
	if !ok {
		return raw, false, nil
	}
	var upstreamModel string
	if err := json.Unmarshal(rawModel, &upstreamModel); err != nil {
		return raw, false, nil
	}
	if upstreamModel == "" || upstreamModel == model {
		return raw, false, nil
	}

	encoded, err := json.Marshal(model)
	if err != nil {
		return nil, false, err
	}
	fields["model"] = encoded
	aligned, err := marshalNoEscape(fields)
	if err != nil {
		return nil, false, fmt.Errorf("%w: encode chunk: %v", errInvalidStream, err)
	}
	return aligned, false, nil
}

func writeSSEData(ctx context.Context, writer io.Writer, flusher http.Flusher, payload []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	frame := make([]byte, 0, len(payload)+8)
	frame = append(frame, "data: "...)
	frame = append(frame, payload...)
	frame = append(frame, '\n', '\n')
	if err := writeFull(writer, frame); err != nil {
		return err
	}
	if flusher != nil {
		flusher.Flush()
	}
	return nil
}

func writeFull(writer io.Writer, payload []byte) error {
	for len(payload) > 0 {
		n, err := writer.Write(payload)
		if err != nil {
			return err
		}
		if n <= 0 {
			return io.ErrShortWrite
		}
		payload = payload[n:]
	}
	return nil
}

// ---------------------------------------------------------------------------
// SSE 行读取
// ---------------------------------------------------------------------------

type sseLineReader struct {
	reader *bufio.Reader
}

func newSSELineReader(upstream io.Reader) *sseLineReader {
	return &sseLineReader{reader: bufio.NewReaderSize(upstream, 64*1024)}
}

// readLine 返回去掉行尾（\n 或 \r\n）的一行；EOF 时返回 io.EOF。
// 单行超过 maxSSELineBytes 直接报错，避免上游异常时无限吃内存。
func (r *sseLineReader) readLine() (string, error) {
	var line []byte
	for {
		fragment, err := r.reader.ReadSlice('\n')
		if len(fragment) > 0 {
			if len(line)+len(fragment) > maxSSELineBytes {
				return "", errStreamTooLarge
			}
			line = append(line, fragment...)
		}
		switch {
		case err == nil:
			return trimLineEnding(string(line)), nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		case errors.Is(err, io.EOF):
			if len(line) == 0 {
				return "", io.EOF
			}
			return trimLineEnding(string(line)), nil
		default:
			return "", err
		}
	}
}

func trimLineEnding(line string) string {
	line = strings.TrimSuffix(line, "\n")
	return strings.TrimSuffix(line, "\r")
}

// ---------------------------------------------------------------------------
// 信封 / 错误解析
// ---------------------------------------------------------------------------

func decodeJSONObject(raw []byte) (map[string]json.RawMessage, bool) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return nil, false
	}
	return fields, true
}

func jsonString(raw json.RawMessage) (string, bool) {
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

func isJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// envelopeStatus 取信封状态码：statusCodeValue 优先，statusCode 兜底；
// 任一字段非 2xx 即视为失败。
func envelopeStatus(fields map[string]json.RawMessage) (int, bool) {
	status, hasStatus := 0, false
	for _, key := range []string{"statusCodeValue", "statusCode"} {
		raw, ok := fields[key]
		if !ok {
			continue
		}
		value, ok := decodeStatus(raw)
		if !ok {
			continue
		}
		if !isSuccessStatus(value) {
			return value, true
		}
		if !hasStatus {
			status, hasStatus = value, true
		}
	}
	return status, hasStatus
}

func decodeStatus(raw json.RawMessage) (int, bool) {
	var number json.Number
	if err := json.Unmarshal(raw, &number); err == nil {
		if value, err := number.Int64(); err == nil {
			return int(value), true
		}
		if value, err := number.Float64(); err == nil {
			return int(value), true
		}
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		if value, err := strconv.Atoi(strings.TrimSpace(text)); err == nil {
			return value, true
		}
	}
	return 0, false
}

func isSuccessStatus(status int) bool {
	return status >= 200 && status <= 299
}

func hasTimingFields(fields map[string]json.RawMessage) bool {
	for _, key := range []string{"firstTokenDuration", "totalDuration", "serverDuration"} {
		if _, ok := fields[key]; ok {
			return true
		}
	}
	return false
}

// envelopeStreamError 从失败信封提取错误：优先取 body 作为细节。
func envelopeStreamError(status int, fields map[string]json.RawMessage, fallback []byte) *StreamError {
	raw := json.RawMessage(fallback)
	if body, ok := fields["body"]; ok && !isJSONNull(body) {
		raw = body
	}
	return newStreamError(status, raw)
}

func newStreamError(status int, raw json.RawMessage) *StreamError {
	code, message := extractError(raw, 0)
	if code == "" {
		code = upstreamErrorCode
	}
	return &StreamError{StatusCode: status, Code: code, Message: message}
}

// extractError 兼容三种上游错误形状：字符串 / {code,message} / {error:{...}}。
func extractError(raw json.RawMessage, depth int) (code, message string) {
	if depth > 4 || len(raw) == 0 || isJSONNull(raw) {
		return "", ""
	}

	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		trimmed := strings.TrimSpace(text)
		if trimmed != "" && json.Valid([]byte(trimmed)) {
			if nestedCode, nestedMessage := extractError(json.RawMessage(trimmed), depth+1); nestedCode != "" || nestedMessage != "" {
				return nestedCode, nestedMessage
			}
		}
		return "", text
	}

	fields, ok := decodeJSONObject(raw)
	if !ok {
		return "", string(raw)
	}
	if inner, ok := fields["error"]; ok && !isJSONNull(inner) {
		innerCode, innerMessage := extractError(inner, depth+1)
		if innerCode == "" {
			innerCode = rawStringField(fields, "code")
		}
		if innerMessage == "" {
			innerMessage = rawStringField(fields, "message")
			if innerMessage == "" {
				innerMessage = rawStringField(fields, "detail")
			}
		}
		if innerCode != "" || innerMessage != "" {
			return innerCode, innerMessage
		}
	}

	code = rawStringField(fields, "code")
	message = rawStringField(fields, "message")
	if message == "" {
		message = rawStringField(fields, "detail")
	}
	if code != "" || message != "" {
		return code, message
	}
	return "", string(raw)
}

func rawStringField(fields map[string]json.RawMessage, key string) string {
	raw, ok := fields[key]
	if !ok || isJSONNull(raw) {
		return ""
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text
	}
	var number json.Number
	if err := json.Unmarshal(raw, &number); err == nil {
		return number.String()
	}
	return ""
}

func marshalNoEscape(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
}
