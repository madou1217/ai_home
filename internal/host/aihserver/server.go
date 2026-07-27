package aihserver

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"time"
)

const (
	readHeaderTimeout = 5 * time.Second
	readTimeout       = 30 * time.Second
	writeTimeout      = 30 * time.Second
	idleTimeout       = 60 * time.Second
	maxHeaderBytes    = 64 * 1024
)

// Server 持有 HTTP 生命周期和唯一账号数据库连接池。
type Server struct {
	httpServer *http.Server
	store      io.Closer
}

// Serve 在调用方拥有的 Listener 上提供服务，关闭属于正常退出。
func (server *Server) Serve(listener net.Listener) error {
	if server == nil || server.httpServer == nil || listener == nil {
		return ErrInvalidOptions
	}
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
	return server.httpServer.Shutdown(ctx)
}

// Close 强制关闭 HTTP 连接并释放 SQLite 连接池。
func (server *Server) Close() error {
	if server == nil {
		return nil
	}
	var httpErr error
	if server.httpServer != nil {
		httpErr = server.httpServer.Close()
	}
	var storeErr error
	if server.store != nil {
		storeErr = server.store.Close()
	}
	return errors.Join(httpErr, storeErr)
}

// newServer 创建使用生产超时和头部上限的标准库 HTTP Server。
func newServer(handler http.Handler, store io.Closer, options Options) *Server {
	return &Server{
		httpServer: &http.Server{
			Handler:           handler,
			ReadHeaderTimeout: readHeaderTimeout,
			ReadTimeout:       readTimeout,
			WriteTimeout:      writeTimeout,
			IdleTimeout:       idleTimeout,
			MaxHeaderBytes:    maxHeaderBytes,
			ErrorLog:          options.ErrorLog,
		},
		store: store,
	}
}
