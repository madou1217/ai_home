package aihserver

import (
	"context"
	"net/http"
	"path/filepath"

	"github.com/madou1217/ai_home/internal/adapters/clientversion"
	"github.com/madou1217/ai_home/internal/adapters/codex/codexidentity"
)

// clientVersionsFile 保存从真实客户端学到的版本号（不含完整 User-Agent）。
const clientVersionsFile = "client-versions.json"

// newCodexClientVersions 创建并启动 Codex 客户端版本解析器。
//
// 网关模拟 Codex 客户端的请求（推理、模型目录、用量、WS 兜底）都从这里取版本，
// 版本随本机 CLI 自动更新与经过网关的真实客户端上涨，不再写死，见 clientversion 包。
func newCodexClientVersions(
	ctx context.Context,
	aiHomeDir string,
) (*clientversion.Resolver, error) {
	learned := clientversion.NewLearnedStore(filepath.Join(aiHomeDir, "run", clientVersionsFile))
	resolver, err := codexidentity.NewResolver(learned)
	if err != nil {
		return nil, err
	}
	resolver.Start(ctx)
	return resolver, nil
}

// requestAuthorizer 是学习前复核客户端凭据的最小端口。
type requestAuthorizer interface {
	Authorized(request *http.Request) bool
}

// observeCodexClientVersion 从已鉴权的真实 Codex 客户端学习版本。
//
// relay 部署时服务器上往往没有 Codex CLI，经过网关的客户端就是最新版本的来源。
// 只信任持有 Client Key 且 Originator 为 codex_*、User-Agent 以其开头的请求：未鉴权
// 请求伪造的版本号不能抬高网关自报的身份。
func observeCodexClientVersion(
	resolver *clientversion.Resolver,
	authorizer requestAuthorizer,
) func(*http.Request) {
	return func(request *http.Request) {
		version, ok := codexidentity.VersionFromClientHeaders(request.Header)
		if !ok || authorizer == nil || !authorizer.Authorized(request) {
			return
		}
		resolver.Observe(version)
	}
}
