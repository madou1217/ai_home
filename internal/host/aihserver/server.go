package aihserver

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/desktoptranslation"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

const (
	readHeaderTimeout = 5 * time.Second
	readTimeout       = 30 * time.Second
	// writeTimeout 只是标准库层面的写兜底，且是「读完请求头起算」的绝对截止时间。
	// 长推理流的真实边界由 inferenceapi.StreamDeadline 的空闲刷新 + 总时长策略施加
	// （见 G3），因此这里必须不小于该总时长，否则流仍会被 Server 先切断。
	writeTimeout   = inferenceapi.StreamTotalTimeout
	idleTimeout    = 60 * time.Second
	maxHeaderBytes = 64 * 1024
)

// Server 持有 HTTP、后台 worker 和唯一账号数据库生命周期。
type Server struct {
	httpServer         *http.Server
	streams            *streamShutdown
	resources          []io.Closer
	desktopTranslation *desktoptranslation.Service
	closeOnce          sync.Once
	closeErr           error
}

// Serve 在调用方拥有的 Listener 上提供服务，关闭属于正常退出。
func (server *Server) Serve(listener net.Listener) error {
	if server == nil || server.httpServer == nil || listener == nil {
		return ErrInvalidOptions
	}
	startDesktopOnListener(context.Background(), server.desktopTranslation, "http://"+listener.Addr().String())
	err := server.httpServer.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// Shutdown 停止接收新连接，并等待当前 HTTP 请求在上下文内完成。
func (server *Server) Shutdown(ctx context.Context) error {
	if server == nil || server.httpServer == nil {
		return ErrInvalidOptions
	}
	// SSE handlers can stay blocked until the next event/heartbeat. Cancel
	// only those request contexts before asking net/http to drain; ordinary
	// in-flight HTTP requests continue to finish within the shutdown budget.
	server.streams.cancelAll()
	return server.httpServer.Shutdown(ctx)
}

// Close joins the original resource sequence once. The first uncertain
// close stops dependency release; retained roots remain on this exact Server.
// A caller must retain process lifetime on error (the production run does so).
// This is not proof of all independent writer populations or a handoff grant.
func (server *Server) Close() error {
	if server == nil {
		return nil
	}
	server.closeOnce.Do(func() {
		server.streams.cancelAll()
		if server.httpServer != nil {
			if err := server.httpServer.Close(); err != nil {
				server.closeErr = err
				return
			}
		}
		for _, resource := range server.resources {
			if resource == nil {
				continue
			}
			if err := resource.Close(); err != nil {
				server.closeErr = err
				return // never close the following store/lease after an unknown join
			}
		}
		server.resources = nil
	})
	return server.closeErr
}

// newServer 创建使用生产超时和头部上限的标准库 HTTP Server。
func newServer(
	handler http.Handler,
	resources []io.Closer,
	options Options,
) *Server {
	streams := newStreamShutdown()
	return &Server{
		httpServer: &http.Server{
			Handler:           withAccessLog(streams.wrap(handler), options.ErrorLog),
			ReadHeaderTimeout: readHeaderTimeout,
			ReadTimeout:       readTimeout,
			WriteTimeout:      writeTimeout,
			IdleTimeout:       idleTimeout,
			MaxHeaderBytes:    maxHeaderBytes,
			ErrorLog:          options.ErrorLog,
		},
		streams:   streams,
		resources: append([]io.Closer(nil), resources...),
	}
}
