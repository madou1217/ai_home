package webuichatpasteapi

import (
	"net/http"

	"github.com/madou1217/ai_home/internal/transport/http/webuipublicalias"
)

// PublicPath 是浏览器使用的聊天粘贴设置入口（与 Node 旧路径逐字一致）。
const PublicPath = "/v0/webui/chat/paste-settings"

// NewPublicAlias 把浏览器前缀重写到管理前缀，复用同一处理器与鉴权。
func NewPublicAlias(handler http.Handler) http.Handler {
	return webuipublicalias.Rewrite(PublicPath, Path, handler)
}
