package webuiaccountliveapi

import (
	"net/http"

	"github.com/madou1217/ai_home/internal/transport/http/webuipublicalias"
)

// PublicAccountsPath 是浏览器读取账号列表的路径（无查询参数）。
//
// 浏览器只调用 /webui/accounts 拿全量列表；带 provider/ref 过滤的调用是 Node
// 内部行为，不在公开契约里。
const PublicAccountsPath = "/v0/webui/accounts"

// NewPublicLiveAlias 把浏览器列表路径重写到管理面的实时列表端点。
//
// 必须重写到 LivePath 而不是前缀：handler 按完整路径分派，重写到
// /v1/management/webui/accounts 会落进 watch（SSE）分支。
func NewPublicLiveAlias(handler http.Handler) http.Handler {
	return webuipublicalias.Rewrite(PublicAccountsPath, LivePath, handler)
}
