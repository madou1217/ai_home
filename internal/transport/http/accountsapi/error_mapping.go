package accountsapi

import (
	"errors"
	"net/http"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// writeInvalidQuery 输出稳定的查询参数错误合同。
func writeInvalidQuery(response http.ResponseWriter) {
	writeAPIError(
		response,
		http.StatusBadRequest,
		"invalid_query",
		"请求包含不支持的查询参数",
	)
}

// writeRequestDecodeError 把请求体错误映射为固定 HTTP 语义。
func writeRequestDecodeError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errUnsupportedMediaType):
		writeAPIError(
			response,
			http.StatusUnsupportedMediaType,
			"unsupported_media_type",
			"请求体必须使用 application/json",
		)
	case errors.Is(err, errRequestBodyTooLarge):
		writeAPIError(
			response,
			http.StatusRequestEntityTooLarge,
			"request_too_large",
			"请求体超过允许大小",
		)
	default:
		writeAPIError(
			response,
			http.StatusBadRequest,
			"invalid_request",
			"JSON 请求体无效",
		)
	}
}

// writeStaticCredentialInputError 区分 Provider、凭据类型和字段组合错误。
func writeStaticCredentialInputError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrUnsupportedProvider):
		writeAPIError(
			response,
			http.StatusUnprocessableEntity,
			"unsupported_provider",
			"当前只支持 Codex 和 Claude",
		)
	case errors.Is(err, ErrUnsupportedStaticAuthKind):
		writeAPIError(
			response,
			http.StatusUnprocessableEntity,
			"unsupported_auth_kind",
			"目标 Provider 不支持该静态凭据类型",
		)
	default:
		writeAPIError(
			response,
			http.StatusUnprocessableEntity,
			"invalid_static_credential",
			"静态凭据字段或 Base URL 无效",
		)
	}
}

// writeApplicationError 把领域和持久化错误收敛为无内部细节的 HTTP 错误。
func writeApplicationError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, usageapp.ErrSnapshotNotFound):
		writeAPIError(
			response,
			http.StatusNotFound,
			"usage_not_found",
			"账号还没有成功额度快照",
		)
	case errors.Is(err, usageapp.ErrUsageUnsupported):
		writeAPIError(
			response,
			http.StatusUnprocessableEntity,
			"usage_refresh_unsupported",
			"当前凭据没有可信额度接口",
		)
	case errors.Is(err, usageapp.ErrRefreshFailed):
		writeAPIError(
			response,
			http.StatusBadGateway,
			"usage_refresh_failed",
			"Provider 额度刷新失败，未改写当前快照",
		)
	case errors.Is(err, accountapp.ErrAccountNotFound):
		writeAPIError(
			response,
			http.StatusNotFound,
			"account_not_found",
			"账号不存在",
		)
	case errors.Is(err, accountapp.ErrAccountRuntimeActive):
		writeAPIError(
			response,
			http.StatusConflict,
			"account_runtime_active",
			"账号仍有活跃持久会话，不能删除",
		)
	case errors.Is(err, accountapp.ErrAccountRuntimeUnverifiable):
		writeAPIError(
			response,
			http.StatusServiceUnavailable,
			"account_runtime_unverifiable",
			"无法确认账号持久会话已经退出",
		)
	case errors.Is(err, accountapp.ErrAccountDeletionPreparationFailed):
		writeAPIError(
			response,
			http.StatusServiceUnavailable,
			"account_deletion_preparation_failed",
			"无法安全收敛账号 Provider 资源或敏感凭据投影",
		)
	case errors.Is(err, accountapp.ErrProviderDefaultNotFound):
		writeAPIError(
			response,
			http.StatusNotFound,
			"default_account_not_found",
			"Provider 当前没有默认账号",
		)
	case errors.Is(err, accountapp.ErrLaunchSelectionProviderMismatch):
		writeAPIError(
			response,
			http.StatusUnprocessableEntity,
			"account_selection_provider_mismatch",
			"目标账号不属于指定 Provider",
		)
	case errors.Is(err, accountapp.ErrLaunchSelectionDisabled):
		writeAPIError(
			response,
			http.StatusConflict,
			"account_selection_disabled",
			"目标账号已被用户停用",
		)
	case errors.Is(err, accountapp.ErrLaunchSelectionUnconfigured):
		writeAPIError(
			response,
			http.StatusConflict,
			"account_selection_unconfigured",
			"目标账号缺少可用凭据",
		)
	case errors.Is(err, accountapp.ErrInvalidLaunchSelection):
		writeAPIError(
			response,
			http.StatusUnprocessableEntity,
			"invalid_account_selection",
			"Provider 或启动账号选择无效",
		)
	case errors.Is(err, accountapp.ErrProviderDefaultMismatch):
		writeAPIError(
			response,
			http.StatusUnprocessableEntity,
			"default_account_provider_mismatch",
			"目标账号不属于指定 Provider",
		)
	case errors.Is(err, accountapp.ErrProviderDefaultDisabled):
		writeAPIError(
			response,
			http.StatusUnprocessableEntity,
			"default_account_disabled",
			"已停用账号不能设为默认账号",
		)
	case errors.Is(err, accountapp.ErrProviderDefaultUnconfigured):
		writeAPIError(
			response,
			http.StatusUnprocessableEntity,
			"default_account_unconfigured",
			"未配置账号不能设为默认账号",
		)
	case errors.Is(err, accountapp.ErrProviderDefaultConflict):
		writeAPIError(
			response,
			http.StatusConflict,
			"default_account_conflict",
			"默认账号已被并发修改",
		)
	case errors.Is(err, accountapp.ErrInvalidProviderDefault):
		writeAPIError(
			response,
			http.StatusUnprocessableEntity,
			"invalid_provider_default",
			"Provider 或默认账号数据无效",
		)
	case errors.Is(err, accountapp.ErrAccountConflict):
		writeAPIError(
			response,
			http.StatusConflict,
			"account_conflict",
			"账号已经存在或数字别名冲突",
		)
	case errors.Is(err, accountapp.ErrReauthenticationGenerationUnordered):
		writeAPIError(
			response,
			http.StatusConflict,
			"account_import_generation_unordered",
			"无法证明导入凭据比当前凭据更新",
		)
	case errors.Is(err, accountapp.ErrCLIAccountIDExhausted):
		writeAPIError(
			response,
			http.StatusConflict,
			"cli_account_id_exhausted",
			"Provider 数字别名已经耗尽",
		)
	case errors.Is(err, accountapp.ErrCredentialNotFound):
		writeAPIError(
			response,
			http.StatusConflict,
			"credential_not_found",
			"账号缺少可用凭据",
		)
	case errors.Is(err, accountapp.ErrStaticCredentialRotationUnsupported):
		writeAPIError(
			response,
			http.StatusUnprocessableEntity,
			"static_credential_rotation_unsupported",
			"OAuth 或当前凭据类型不能通过该接口轮换",
		)
	case errors.Is(err, accountapp.ErrStaticCredentialRotationConflict):
		writeAPIError(
			response,
			http.StatusConflict,
			"static_credential_rotation_conflict",
			"账号已变化或当前凭据已被其他账号使用",
		)
	case errors.Is(err, accountapp.ErrUnsupportedAccountExport):
		writeAPIError(
			response,
			http.StatusUnprocessableEntity,
			"account_export_unsupported",
			"当前账号凭据不支持标准导出",
		)
	case errors.Is(err, accountapp.ErrModelDiscoveryUnsupported):
		writeAPIError(
			response,
			http.StatusUnprocessableEntity,
			"model_refresh_unsupported",
			"当前 Provider 不支持模型刷新",
		)
	case errors.Is(err, accountapp.ErrModelDiscoveryFailed):
		writeAPIError(
			response,
			http.StatusBadGateway,
			"model_refresh_failed",
			"Provider 模型目录刷新失败",
		)
	case errors.Is(err, accountapp.ErrInvalidAccountModel),
		errors.Is(err, accountapp.ErrInvalidDiscoveredModels):
		writeAPIError(
			response,
			http.StatusUnprocessableEntity,
			"invalid_model",
			"账号模型数据无效",
		)
	case errors.Is(err, accountapp.ErrInvalidRegistration),
		errors.Is(err, accountapp.ErrInvalidStaticCredentialRotation),
		errors.Is(err, accountapp.ErrInvalidOverview),
		errors.Is(err, accountcore.ErrInvalidAccount):
		writeAPIError(
			response,
			http.StatusUnprocessableEntity,
			"invalid_account",
			"账号数据无效",
		)
	default:
		writeAPIError(
			response,
			http.StatusInternalServerError,
			"internal_error",
			"账号服务内部错误",
		)
	}
}

// writeMethodNotAllowed 返回统一 JSON，而不是 net/http 默认纯文本。
func writeMethodNotAllowed(response http.ResponseWriter) {
	writeAPIError(
		response,
		http.StatusMethodNotAllowed,
		"method_not_allowed",
		"HTTP 方法不受支持",
	)
}
