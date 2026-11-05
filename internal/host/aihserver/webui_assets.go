package aihserver

import (
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/webuiassets"
)

// newWebUIHandler 构造 /ui 静态资源托管；目录为空表示不由 Go 托管。
//
// 目录只来自命令行 --web-dir，不读 AIH_* 环境变量：静态根是部署参数，
// 不该隐式依赖进程环境（过渡期 Node 宿主仍可自己服务 /ui）。
func newWebUIHandler(webDir string) (http.Handler, error) {
	trimmed := strings.TrimSpace(webDir)
	if trimmed == "" {
		return nil, nil
	}
	info, err := os.Stat(trimmed)
	if err != nil || !info.IsDir() {
		return nil, fmt.Errorf("Web UI 目录不可用: %s", trimmed)
	}
	return webuiassets.NewHandler(os.DirFS(trimmed))
}
