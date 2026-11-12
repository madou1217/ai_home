// 仅用于 Node 端到端测试的独立 Go 管理进程：暴露 WebUI 终端 handler，
// 不加载 aihserver 的账号/数据库依赖。testdata 目录不会被 go build ./... 编译。
package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/pty"
	"github.com/madou1217/ai_home/internal/runtime/terminalsession"
	"github.com/madou1217/ai_home/internal/transport/http/webuiterminalapi"
)

type staticAuthorizer struct{ key string }

func (authorizer staticAuthorizer) Authorized(request *http.Request) bool {
	return request.Header.Get("Authorization") == "Bearer "+authorizer.key
}

func main() {
	key := os.Getenv("AIH_TERMINAL_TEST_KEY")
	if key == "" {
		fmt.Fprintln(os.Stderr, "AIH_TERMINAL_TEST_KEY required")
		os.Exit(2)
	}
	service := terminalsession.NewService(pty.NewStarter(), terminalsession.Options{
		IdleTimeout:   time.Minute,
		ExitRetention: 250 * time.Millisecond,
	})
	defer service.Shutdown()
	handler, err := webuiterminalapi.NewHandler(webuiterminalapi.Dependencies{
		Authorizer: staticAuthorizer{key: key},
		Sessions:   service,
		HomeDir:    os.TempDir(),
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "handler:", err)
		os.Exit(2)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintln(os.Stderr, "listen:", err)
		os.Exit(2)
	}
	fmt.Printf("LISTEN=%s\n", listener.Addr().String())
	os.Stdout.Sync()
	if err := http.Serve(listener, handler); err != nil {
		fmt.Fprintln(os.Stderr, "serve:", err)
		os.Exit(2)
	}
}
