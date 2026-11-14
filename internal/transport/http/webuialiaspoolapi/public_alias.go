package webuialiaspoolapi

import (
	"net/http"

	"github.com/madou1217/ai_home/internal/transport/http/webuipublicalias"
)

// PublicAccountPrefix 是浏览器使用的账号数据面前缀。
//
// 别名池在管理面挂在 Path + "/{provider}/{accountRef}/alias-pool"；浏览器路径
// 只是前缀不同，重写一次即可复用同一处理器。
const PublicAccountPrefix = "/v0/webui/accounts"

// NewPublicAlias 把浏览器账号前缀重写到管理前缀。
func NewPublicAlias(handler http.Handler) http.Handler {
	return webuipublicalias.Rewrite(PublicAccountPrefix, Path, handler)
}
