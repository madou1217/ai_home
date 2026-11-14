package accountsapi

import (
	"errors"
	"net/http"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
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
	case errors.Is(err, runtimecore.ErrInvalidAccountBlock):
		writeAPIError(
			response,
			http.StatusBadRequest,
			"invalid_runtime_block",
			"账号运行态阻塞无效",
		)
	case errors.Is(err, usagecore.ErrInvalidDocument):
		writeAPIError(
			response,
			http.StatusBadRequest,
			"invalid_usage_document",
			"账号额度快照文档无效",
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
	case errors.Is(err, accountapp.ErrAccountHostCleanupFailed):
		// 宿主清理通道不可用（Node 未启动 / 未授权 / 通信失败）。账号事实未被
		// 修改，可以原样重试；不能返回 409，否则会被当成「有会话在跑」。
		writeAPIError(
			response,
			http.StatusServiceUnavailable,
			"account_host_cleanup_failed",
			"无法确认或清理账号的宿主资源",
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
	case errors.Is(err, accountapp.ErrReauthenticationUnsupported):
		// 这是能力边界（凭据形态不支持原地替换），不是服务端异常：给 409 让调用方
		// 按终态处理，而不是每轮都当成可重试的 500（2026-11-06 cline 同步一直重试）。
		writeAPIError(
			response,
			http.StatusConflict,
			"account_reauth_unsupported",
			"账号凭据不支持原地重新认证",
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
	case errors.Is(err, accountapp.ErrStaticCredentialEditIncomplete):
		writeAPIError(
			response,
			http.StatusBadRequest,
			"invalid_static_credential_edit",
			"编辑静态凭据需要完整密钥",
		)
	case errors.Is(err, accountapp.ErrStaticBaseURLUnsupported):
		writeAPIError(
			response,
			http.StatusBadRequest,
			"base_url_unsupported",
			"Gemini API Key 模式不支持自定义 Base URL",
		)
	case errors.Is(err, accountcore.ErrInvalidStaticBaseURL):
		writeAPIError(
			response,
			http.StatusBadRequest,
			"invalid_base_url",
			"Base URL 格式无效",
		)
	case errors.Is(err, accountcore.ErrInvalidStaticAPIKey):
		writeAPIError(
			response,
			http.StatusBadRequest,
			"invalid_api_key",
			"API Key 格式无效",
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
	case errors.Is(err, accountapp.ErrModelAuthenticationRejected):
		// 上游账号认证失败不等于当前 WebUI 会话失效，不能返回管理面 401。
		writeAPIError(
			response,
			http.StatusUnprocessableEntity,
			"model_authentication_rejected",
			"模型目录认证被拒绝，请检查账号凭据或重新授权",
		)
	case errors.Is(err, accountapp.ErrModelDiscoveryFailed):
		writeAPIError(
			response,
			http.StatusBadGateway,
			"model_refresh_failed",
			"Provider 模型目录刷新失败",
		)
	case errors.Is(err, accountcredentials.ErrReauthenticationRequired):
		writeAPIError(
			response,
			http.StatusUnauthorized,
			"account_reauth_required",
			"账号凭据已失效，需要重新登录",
		)
	case errors.Is(err, accountcredentials.ErrRefreshUnavailable),
		errors.Is(err, accountcredentials.ErrRefreshRejected):
		writeAPIError(
			response,
			http.StatusBadGateway,
			"credential_refresh_failed",
			"Provider 凭据刷新失败",
		)
	case errors.Is(err, accountcredentials.ErrInvalidRefreshResult):
		writeAPIError(
			response,
			http.StatusBadGateway,
			"credential_refresh_invalid",
			"Provider 凭据刷新返回无效结果",
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
		// 未映射 = 真正的服务端异常：把原始错误写进日志（客户端仍只看到稳定文案）。
		logServerError("internal_error", err)
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
