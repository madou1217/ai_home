package accountsapi

import (
	"encoding/json"
	"net/http"
)

// handleSub2APIImport 只接受一个未经 AIH 私有包装的 sub2api-data 文档。
func (handler *Handler) handleSub2APIImport(
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
	var document json.RawMessage
	if err := decodeJSONRequestWithLimit(
		response,
		request,
		&document,
		maxSub2APIImportBodyBytes,
	); err != nil {
		writeRequestDecodeError(response, err)
		return
	}
	credential, profile, err := handler.sub2api.DecodeAccount(document)
	if err != nil {
		writeAPIError(
			response,
			http.StatusUnprocessableEntity,
			"invalid_sub2api_document",
			"sub2api 单账号迁移文档无效或不受支持",
		)
		return
	}
	overview, err := handler.registerAccount(
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
		http.StatusCreated,
		accountResponse{Data: newAccountView(overview)},
	)
}
