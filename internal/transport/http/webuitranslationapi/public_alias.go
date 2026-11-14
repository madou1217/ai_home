package webuitranslationapi

import (
	"net/http"

	"github.com/madou1217/ai_home/internal/transport/http/webuipublicalias"
)

// PublicPath 是浏览器使用的 WebUI 数据面前缀（与 Node 旧路径逐字一致）。
const PublicPath = "/v0/webui/translation"

// NewPublicAlias 把浏览器前缀重写到管理前缀，复用同一处理器与鉴权。
func NewPublicAlias(handler http.Handler) http.Handler {
	return webuipublicalias.Rewrite(PublicPath, Path, handler)
}
