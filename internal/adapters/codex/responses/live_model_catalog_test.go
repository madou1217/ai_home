package responses

import (
	"context"
	"net/http"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
)

var (
	// errInvalidRealCodexModels 保留真实验收测试的稳定错误断言。
	errInvalidRealCodexModels = ErrInvalidModelCatalog
	// errRealCodexModelUnavailable 表示目标模型不在当前账号远端目录中。
	errRealCodexModelUnavailable = errModelUnavailable
)

// realCodexModelCatalog 复用生产账号模型目录，不维护第二套测试协议。
type realCodexModelCatalog = modelCatalog

// fetchRealCodexModelCatalog 使用生产请求和解码路径执行真实目录预检。
func fetchRealCodexModelCatalog(
	ctx context.Context,
	client *http.Client,
	credential accountapp.Credential,
) (realCodexModelCatalog, error) {
	auth, err := projectAuth(credential)
	if err != nil {
		return realCodexModelCatalog{}, err
	}
	return fetchModelCatalog(ctx, client, auth)
}

// buildRealCodexModelsRequest 让合同测试直接覆盖生产请求构造器。
func buildRealCodexModelsRequest(
	ctx context.Context,
	auth authProjection,
) (*http.Request, error) {
	return buildModelsRequest(ctx, auth)
}

// classifyRealCodexModelsMediaType 让安全诊断测试覆盖生产分类器。
func classifyRealCodexModelsMediaType(raw string) string {
	return classifyModelsMediaType(raw)
}

// decodeRealCodexModelCatalog 让严格形状测试覆盖生产目录解码器。
func decodeRealCodexModelCatalog(
	payload []byte,
	authKind codexauth.AuthKind,
) (realCodexModelCatalog, error) {
	return decodeModelCatalog(payload, authKind)
}
