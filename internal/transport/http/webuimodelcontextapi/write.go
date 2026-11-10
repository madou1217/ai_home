package webuimodelcontextapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	_ "modernc.org/sqlite"
)

const maxWriteBodyBytes = 1024 * 1024

type writePayload struct {
	Model       string   `json:"model"`
	Tokens      any      `json:"tokens"`
	AccountRefs []string `json:"accountRefs"`
}

type singleWriteResponse struct {
	OK        bool                      `json:"ok"`
	Overrides map[string]map[string]int `json:"overrides"`
	Resolved  ModelView                 `json:"resolved"`
}

type bulkWriteResponse struct {
	OK        bool                      `json:"ok"`
	Overrides map[string]map[string]int `json:"overrides"`
}

// writeSingle 处理单账号写入：POST /.../{provider}/{accountRef}/model-context。
func (handler *Handler) writeSingle(response http.ResponseWriter, request *http.Request, provider string, accountRef string) {
	ctx := request.Context()
	databasePath, err := appstate.DatabasePath(handler.aiHomeDir)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "model_context_write_failed", err.Error())
		return
	}
	owner, found, err := appstate.LookupAccountProvider(ctx, databasePath, accountRef)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "model_context_write_failed", err.Error())
		return
	}
	if !found {
		writeError(response, http.StatusNotFound, "account_not_found", "未找到 "+provider+" 账号 "+accountRef)
		return
	}
	if strings.ToLower(strings.TrimSpace(owner)) != provider {
		writeError(response, http.StatusConflict, "account_provider_mismatch", "")
		return
	}

	payload, failure := parseWritePayload(response, request)
	if failure != nil {
		writeError(response, failure.status, failure.code, failure.message)
		return
	}
	modelID := strings.TrimSpace(payload.Model)
	if modelID == "" {
		writeError(response, http.StatusBadRequest, "account_and_model_required", "")
		return
	}
	tokens, clearing, ok := resolveWriteTokens(payload.Tokens)
	if !ok {
		writeError(response, http.StatusBadRequest, "context_tokens_out_of_range", "")
		return
	}

	overrides, readErr := readOverrides(ctx, databasePath)
	if readErr != nil {
		writeError(response, http.StatusBadRequest, "storage_write_failed", readErr.Error())
		return
	}
	applyOverride(overrides, accountRef, modelID, tokens, clearing)
	if writeErr := writeOverrides(ctx, databasePath, overrides); writeErr != nil {
		writeError(response, http.StatusBadRequest, "storage_write_failed", writeErr.Error())
		return
	}

	probed, probedErr := readProbedLimits(ctx, databasePath)
	if probedErr != nil {
		probed = map[string]map[string]int{}
	}
	writeJSON(response, http.StatusOK, singleWriteResponse{
		OK:        true,
		Overrides: overrides,
		Resolved:  handler.resolveModel(provider, accountRef, modelID, overrides, probed),
	})
}

// ServeBulkHTTP 处理批量写入：POST /.../{provider}/model-context/bulk。
func (handler *Handler) ServeBulkHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil {
		writeError(response, http.StatusServiceUnavailable, "model_context_unavailable", "模型上下文服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 POST")
		return
	}
	payload, failure := parseWritePayload(response, request)
	if failure != nil {
		writeError(response, failure.status, failure.code, failure.message)
		return
	}
	modelID := strings.TrimSpace(payload.Model)
	accountRefs := normalizeAccountRefs(payload.AccountRefs)
	if modelID == "" || len(accountRefs) == 0 {
		writeError(response, http.StatusBadRequest, "account_and_model_required", "")
		return
	}
	tokens, clearing, ok := resolveWriteTokens(payload.Tokens)
	if !ok {
		writeError(response, http.StatusBadRequest, "context_tokens_out_of_range", "")
		return
	}
	ctx := request.Context()
	databasePath, err := appstate.DatabasePath(handler.aiHomeDir)
	if err != nil {
		writeError(response, http.StatusBadRequest, "storage_write_failed", err.Error())
		return
	}
	overrides, readErr := readOverrides(ctx, databasePath)
	if readErr != nil {
		writeError(response, http.StatusBadRequest, "storage_write_failed", readErr.Error())
		return
	}
	for _, accountRef := range accountRefs {
		applyOverride(overrides, accountRef, modelID, tokens, clearing)
	}
	if writeErr := writeOverrides(ctx, databasePath, overrides); writeErr != nil {
		writeError(response, http.StatusBadRequest, "storage_write_failed", writeErr.Error())
		return
	}
	writeJSON(response, http.StatusOK, bulkWriteResponse{OK: true, Overrides: overrides})
}

func parseWritePayload(response http.ResponseWriter, request *http.Request) (writePayload, *apiError) {
	var payload writePayload
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, maxWriteBodyBytes))
	if err := decoder.Decode(&payload); err != nil {
		if errors.Is(err, io.EOF) {
			return writePayload{}, &apiError{status: 400, code: "invalid_json_body"}
		}
		return writePayload{}, &apiError{status: 400, code: "invalid_json_body"}
	}
	return payload, nil
}

// resolveWriteTokens 对齐 Node：null/缺省/空串/数字 0 = 清除；其余必须是
// [1024, 2000000] 的安全整数，越界或非数字明确拒绝。
func resolveWriteTokens(value any) (int, bool, bool) {
	switch typed := value.(type) {
	case nil:
		return 0, true, true
	case float64:
		if typed == 0 {
			return 0, true, true
		}
		tokens := normalizeTokens(typed)
		return tokens, false, tokens > 0
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return 0, true, true
		}
		tokens := normalizeTokens(text)
		return tokens, false, tokens > 0
	default:
		return 0, false, false
	}
}

func normalizeAccountRefs(values []string) []string {
	result := make([]string, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		ref := strings.TrimSpace(value)
		if ref == "" {
			continue
		}
		if _, exists := seen[ref]; exists {
			continue
		}
		seen[ref] = struct{}{}
		result = append(result, ref)
	}
	return result
}

func applyOverride(overrides map[string]map[string]int, accountRef string, modelID string, tokens int, clearing bool) {
	byModel := overrides[accountRef]
	if byModel == nil {
		byModel = map[string]int{}
	}
	if clearing {
		delete(byModel, modelID)
	} else {
		byModel[modelID] = tokens
	}
	if len(byModel) == 0 {
		delete(overrides, accountRef)
		return
	}
	overrides[accountRef] = byModel
}

// writeOverrides 以 BEGIN IMMEDIATE 读改写整份覆盖表；Go 是这张表的唯一写者。
func writeOverrides(ctx context.Context, databasePath string, overrides map[string]map[string]int) error {
	db, err := sql.Open("sqlite", buildWritableDSN(databasePath))
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if _, err := db.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)"); err != nil {
		return err
	}
	payload, err := json.Marshal(overrides)
	if err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx,
		"INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, strftime('%s','now')*1000) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
		overrideKey, string(payload)); err != nil {
		return err
	}
	return tx.Commit()
}

func buildWritableDSN(databasePath string) string {
	fileURL := &url.URL{Scheme: "file", Path: filepath.ToSlash(databasePath)}
	query := fileURL.Query()
	query.Set("mode", "rwc")
	query.Set("_txlock", "immediate")
	query.Add("_pragma", "busy_timeout(5000)")
	fileURL.RawQuery = query.Encode()
	return fileURL.String()
}
