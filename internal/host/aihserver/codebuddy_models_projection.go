package aihserver

import (
	"net/http"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/codebuddymodels"
)

// newCodeBuddyModelsProjection 创建 CodeBuddy 网关档的 models.json 维护器。
//
// 投影根固定在 <aiHome>/run/codebuddy-gateway：与 `aih codebuddy relay` 启动策略
// 使用同一个目录，服务端刷新和前台启动竞争同一把文件锁。
func newCodeBuddyModelsProjection(options Options) *codebuddymodels.Manager {
	if strings.TrimSpace(options.AIHomeDir) == "" {
		return nil
	}
	logf := func(string, ...any) {}
	if options.ErrorLog != nil {
		logf = options.ErrorLog.Printf
	}
	manager := codebuddymodels.New(codebuddymodels.Options{
		RootDir: filepath.Join(options.AIHomeDir, "run", "codebuddy-gateway"),
		Logf:    logf,
	})
	if strings.TrimSpace(options.SelfBaseURL) != "" && options.ClientKey != nil {
		manager.SetConnection(options.SelfBaseURL, options.ClientKey())
	}
	return manager
}

// withCodeBuddyModelsTrigger 在账号/模型配置写入后投递一次防抖刷新。
//
// 放在 HTTP 边界而不是逐个 Handler 里：账号新增、导入、删除、启停、模型开关、
// 别名与路由权重分属多个包，逐个接线迟早漏一条；这里只认「会改变模型目录的
// 写请求」，读请求与推理请求不触发。
func withCodeBuddyModelsTrigger(next http.Handler, trigger func()) http.Handler {
	if next == nil || trigger == nil {
		return next
	}
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		next.ServeHTTP(response, request)
		if isCodeBuddyModelsConfigMutation(request) {
			trigger()
		}
	})
}

func isCodeBuddyModelsConfigMutation(request *http.Request) bool {
	if request == nil {
		return false
	}
	switch request.Method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return false
	}
	path := strings.ToLower(request.URL.Path)
	return strings.Contains(path, "account") ||
		strings.Contains(path, "model") ||
		strings.Contains(path, "provider")
}
