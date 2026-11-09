// 仅用于 Node 端到端测试的独立 Go 进程：暴露插件安装/卸载管理接口，
// 使用真实的 artifact 校验、签名信任根、维护租约与 app-state.db 写事务。
// testdata 目录不会被 go build ./... 编译。
package main

import (
	"fmt"
	"net"
	"net/http"
	"os"

	"github.com/madou1217/ai_home/application/plugincontrol"
	appplugins "github.com/madou1217/ai_home/application/pluginruntime"
	"github.com/madou1217/ai_home/internal/adapters/pluginartifact"
	pluginstatereader "github.com/madou1217/ai_home/internal/adapters/plugincontrol"
	"github.com/madou1217/ai_home/internal/adapters/pluginstatestore"
	"github.com/madou1217/ai_home/internal/transport/http/pluginapi"
	"github.com/madou1217/ai_home/internal/transport/http/plugincontrolapi"
)

type staticAuthorizer struct{ key string }

func (authorizer staticAuthorizer) Authorized(request *http.Request) bool {
	return request.Header.Get("Authorization") == "Bearer "+authorizer.key
}

func main() {
	key := os.Getenv("AIH_PLUGIN_TEST_KEY")
	home := os.Getenv("AIH_PLUGIN_TEST_HOME")
	if key == "" || home == "" {
		fmt.Fprintln(os.Stderr, "AIH_PLUGIN_TEST_KEY and AIH_PLUGIN_TEST_HOME required")
		os.Exit(2)
	}
	acceptor, err := pluginartifact.NewAcceptor(home)
	if err != nil {
		fmt.Fprintln(os.Stderr, "acceptor:", err)
		os.Exit(2)
	}
	store, err := pluginstatestore.NewStore(home)
	if err != nil {
		fmt.Fprintln(os.Stderr, "store:", err)
		os.Exit(2)
	}
	installer, err := plugincontrol.NewInstaller(home, acceptor, store)
	if err != nil {
		fmt.Fprintln(os.Stderr, "installer:", err)
		os.Exit(2)
	}
	handler, err := plugincontrolapi.NewHandler(plugincontrolapi.Dependencies{
		Authorizer: staticAuthorizer{key: key},
		Installer:  installer,
		Committer:  store,
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
	// 只读清单也挂上：端到端要验证「Go 写入 → Node 列表路由读回」。
	reader, err := pluginstatereader.NewReader(home)
	if err != nil {
		fmt.Fprintln(os.Stderr, "reader:", err)
		os.Exit(2)
	}
	registry := appplugins.NewRegistry()
	inventory, err := pluginapi.NewInventoryHandler(staticAuthorizer{key: key}, reader, registry)
	if err != nil {
		fmt.Fprintln(os.Stderr, "inventory:", err)
		os.Exit(2)
	}
	mux := http.NewServeMux()
	mux.Handle(plugincontrolapi.InstallPath, handler)
	mux.Handle(plugincontrolapi.UninstallPath, handler)
	mux.Handle(plugincontrolapi.StatePath, handler)
	mux.Handle(pluginapi.InventoryPath, inventory)
	fmt.Printf("LISTEN=%s\n", listener.Addr().String())
	os.Stdout.Sync()
	if err := http.Serve(listener, mux); err != nil {
		fmt.Fprintln(os.Stderr, "serve:", err)
		os.Exit(2)
	}
}
