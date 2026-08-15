package accountsapi

import (
	"context"
	"errors"
	"net/http"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

var (
	// errUnsupportedNativeProvider 表示导入请求超出当前 Codex、Claude 边界。
	errUnsupportedNativeProvider = errors.New("原生账号 Provider 不受支持")
	// errInvalidNativeArtifacts 表示 artifact 槽位或官方内容不满足导入合同。
	errInvalidNativeArtifacts = errors.New("原生账号 artifact 无效")
)

// handleNativeImport 只接受一个受鉴权的原生账号创建命令。
func (handler *Handler) handleNativeImport(
	response http.ResponseWriter,
	request *http.Request,
) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeMethodNotAllowed(response)
		return
	}
	if rejectUnexpectedQuery(response, request) {
		return
	}
	var input nativeImportRequest
	if err := decodeJSONRequestWithLimit(
		response,
		request,
		&input,
		maxNativeImportRequestBodyBytes,
	); err != nil {
		writeRequestDecodeError(response, err)
		return
	}
	credential, profile, err := handler.decodeNativeAccount(input)
	if err != nil {
		writeNativeImportInputError(response, err)
		return
	}
	overview, created, err := handler.importAccount(
		request.Context(),
		credential,
		profile,
	)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	writeJSON(
		response,
		accountImportStatus(created),
		accountResponse{Data: newAccountView(overview)},
	)
}

// decodeNativeAccount 校验 Provider 对应的唯一 artifact 组合后调用反腐端口。
func (handler *Handler) decodeNativeAccount(
	input nativeImportRequest,
) (accountapp.Credential, accountapp.PublicProfile, error) {
	if !handler.native.Supports(input.ProviderID) {
		return nil, nil, errUnsupportedNativeProvider
	}
	if len(input.Artifacts) == 0 {
		return nil, nil, errInvalidNativeArtifacts
	}
	credential, profile, err := handler.native.Decode(
		input.ProviderID,
		input.Artifacts,
	)
	if err != nil {
		return nil, nil, errInvalidNativeArtifacts
	}
	return credential, profile, nil
}

// importAccount 复用统一导入应用服务，并从数据库返回完整公开投影。
func (handler *Handler) importAccount(
	ctx context.Context,
	credential accountapp.Credential,
	profile accountapp.PublicProfile,
) (accountapp.AccountOverview, bool, error) {
	result, err := handler.importer.Import(ctx, credential, profile)
	if err != nil {
		return accountapp.AccountOverview{}, false, err
	}
	overview, err := handler.management.GetAccountOverview(
		ctx,
		result.Account().Ref(),
	)
	if err != nil {
		return accountapp.AccountOverview{}, false, err
	}
	return overview, result.Created(), nil
}

// accountImportStatus 用 HTTP 语义区分首次创建与既有身份原地更新。
func accountImportStatus(created bool) int {
	if created {
		return http.StatusCreated
	}
	return http.StatusOK
}

// writeNativeImportInputError 输出不含 Provider artifact 内容的稳定错误。
func writeNativeImportInputError(
	response http.ResponseWriter,
	err error,
) {
	if errors.Is(err, errUnsupportedNativeProvider) {
		writeAPIError(
			response,
			http.StatusUnprocessableEntity,
			"unsupported_provider",
			"当前只支持 Codex 和 Claude",
		)
		return
	}
	writeAPIError(
		response,
		http.StatusUnprocessableEntity,
		"invalid_native_artifacts",
		"Provider 原生认证 artifact 无效",
	)
}
