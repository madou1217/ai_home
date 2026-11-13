package webuichatapi

import (
	"io"
	"net/http"

	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

// transformStream 把「非 OpenAI 协议的上游」接成一条 OpenAI SSE 读端。
//
// 有些 Provider 的上游不是 OpenAI 合同（kiro 是 AWS event-stream、qoder 是压缩帧），
// 它们在 relaycore 里通过 ResponseTransformer 把原生流翻译成 OpenAI SSE。relaycore 的
// 推理入口直接把 ResponseWriter 交给转换器；本切片要先预读首块、再逐事件回写 turn
// 事件，不能把客户端 Writer 直接交出去，否则转换失败时已经提交了 200 头。
//
// 因此用 io.Pipe 做一层适配：转换器写出的 SSE 字节进入管道读端，本切片照常按
// OpenAI SSE 解析。管道是同步的，转换与下发保持同样的背压，不会把整段回答先攒在内存里。
func transformStream(provider relaycore.Provider, upstream *http.Response) (io.ReadCloser, bool) {
	transformer, ok := provider.(relaycore.ResponseTransformer)
	if !ok || upstream == nil || upstream.Body == nil {
		return nil, false
	}
	reader, writer := io.Pipe()
	go func() {
		_, err := transformer.TransformResponse(&pipeResponseWriter{writer: writer}, upstream, true)
		if err != nil {
			_ = writer.CloseWithError(err)
			return
		}
		_ = writer.Close()
	}()
	return reader, true
}

// pipeResponseWriter 只接住转换器写出的字节与状态码；响应头由本切片自己决定。
type pipeResponseWriter struct {
	writer io.Writer
	header http.Header
}

func (writer *pipeResponseWriter) Header() http.Header {
	if writer.header == nil {
		writer.header = make(http.Header)
	}
	return writer.header
}

func (*pipeResponseWriter) WriteHeader(int) {}

func (writer *pipeResponseWriter) Write(payload []byte) (int, error) {
	return writer.writer.Write(payload)
}

// Flush 是空实现：管道本身同步传递，转换器调用 Flush 不需要额外动作。
func (*pipeResponseWriter) Flush() {}
