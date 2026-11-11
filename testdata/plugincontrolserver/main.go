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
	"github.com/madou1217/ai_home/internal/adapters/plugincontrolclient"
	adapterplugins "github.com/madou1217/ai_home/internal/adapters/pluginruntime"
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
	dependencies := plugincontrolapi.Dependencies{
		Authorizer: staticAuthorizer{key: key},
		Installer:  installer,
		Committer:  store,
	}
	// P2：可选接上 Node 内部发布协议，跑 enable/disable 的端到端。
	if nodeURL := os.Getenv("AIH_PLUGIN_TEST_NODE_URL"); nodeURL != "" {
		client, clientErr := plugincontrolclient.New(plugincontrolclient.Options{
			BaseURL:       nodeURL,
			ManagementKey: func() string { return key },
		})
		if clientErr != nil {
			fmt.Fprintln(os.Stderr, "node client:", clientErr)
			os.Exit(2)
		}
		operator, operatorErr := plugincontrol.NewInstanceOperator(store, store, client)
		if operatorErr != nil {
			fmt.Fprintln(os.Stderr, "operator:", operatorErr)
			os.Exit(2)
		}
		dependencies.Operator = operator
	}
	handler, err := plugincontrolapi.NewHandler(dependencies)
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
	// 投影与清单共用同一份注册表：Node 推送投影 → Go 探活宿主确认 → 清单读回运行态。
	// 端到端必须走真实宿主（unix socket + ping），不能用空注册表假装 projected。
	registry := appplugins.NewRegistry()
	invoker := adapterplugins.NewHostInvoker(registry)
	projection, err := pluginapi.NewProjectionHandler(staticAuthorizer{key: key}, registry, invoker, nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "projection:", err)
		os.Exit(2)
	}
	inventory, err := pluginapi.NewInventoryHandler(staticAuthorizer{key: key}, reader, registry)
	if err != nil {
		fmt.Fprintln(os.Stderr, "inventory:", err)
		os.Exit(2)
	}
	mux := http.NewServeMux()
	mux.Handle(plugincontrolapi.InstallPath, handler)
	mux.Handle(plugincontrolapi.UninstallPath, handler)
	mux.Handle(plugincontrolapi.StatePath, handler)
	if os.Getenv("AIH_PLUGIN_TEST_NODE_URL") != "" {
		mux.Handle("POST "+plugincontrolapi.InstancesPath+"/{instanceId}/enable", handler)
		mux.Handle("POST "+plugincontrolapi.InstancesPath+"/{instanceId}/disable", handler)
	}
	mux.Handle(pluginapi.InventoryPath, inventory)
	mux.Handle(pluginapi.ProjectionPath, projection)
	fmt.Printf("LISTEN=%s\n", listener.Addr().String())
	os.Stdout.Sync()
	if err := http.Serve(listener, mux); err != nil {
		fmt.Fprintln(os.Stderr, "serve:", err)
		os.Exit(2)
	}
}
