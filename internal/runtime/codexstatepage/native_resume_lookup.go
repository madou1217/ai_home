package codexstatepage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/madou1217/ai_home/internal/runtime/jsondocument"
)

const MaxNativeResumeLookupInput = 256 << 10
const maxNativeResumeLookupOutput = 1 << 20

var errNativeResumeLookupInput = errors.New("codex_native_resume_lookup_input_invalid")
var errNativeResumeLookupUnavailable = errors.New("codex_native_resume_lookup_unavailable")

// Preserve the three vendor values, including NULL and untrimmed cwd. The
// native caller still owns provider coercion and project transport policy.
func nativeResumeLookupValue(value any) (any, error) {
	if value == nil {
		return nil, nil
	}
	text, ok := value.(string)
	if !ok || !utf8.ValidString(text) {
		return nil, errNativeResumeLookupUnavailable
	}
	if len(text) > MaxNativeResumeLookupInput {
		return nil, ErrBudget
	}
	return text, nil
}

// CompileNativeResumeLookup moves only native resume's read-only SQL leaf.
// The first successful query is authoritative, including a miss or a row the
// caller rejects. Unsupported successful values never select a later source.
func CompileNativeResumeLookup(ctx context.Context, raw []byte) ([]byte, error) {
	if len(raw) > MaxNativeResumeLookupInput {
		return nil, ErrBudget
	}
	request, err := jsondocument.Object(raw)
	if err != nil || len(request) != 4 || request["version"] != json.Number("1") {
		return nil, errNativeResumeLookupInput
	}
	home, homeOK := request["codexHome"].(string)
	method, methodOK := request["method"].(string)
	threadID, idOK := request["threadId"].(string)
	if !homeOK || !filepath.IsAbs(home) || filepath.Clean(home) != home || responseTrim(home) != home ||
		strings.ContainsRune(home, 0) || !methodOK || method != "thread/resume" ||
		!idOK || threadID == "" || responseTrim(threadID) != threadID {
		return nil, errNativeResumeLookupInput
	}
	paths, err := managedReconcileSources(home)
	if err != nil {
		return nil, err
	}
	for _, path := range paths {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		db, tx, err := openVendorReadOnly(ctx, path)
		if err != nil {
			continue
		}
		var provider, model, cwd any
		err = tx.QueryRowContext(ctx, "SELECT model_provider, model, cwd FROM threads WHERE id = ?", threadID).
			Scan(&provider, &model, &cwd)
		_ = tx.Rollback()
		_ = db.Close()
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if errors.Is(err, sql.ErrNoRows) {
			return []byte(`{"row":null}`), nil
		}
		if err != nil {
			continue
		}
		providerValue, err := nativeResumeLookupValue(provider)
		if err != nil {
			return nil, err
		}
		modelValue, err := nativeResumeLookupValue(model)
		if err != nil {
			return nil, err
		}
		cwdValue, err := nativeResumeLookupValue(cwd)
		if err != nil {
			return nil, err
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		result, err := marshalWire(map[string]any{"row": map[string]any{
			"stateDbPath": path, "model_provider": providerValue, "model": modelValue, "cwd": cwdValue,
		}})
		if len(result)+1 > maxNativeResumeLookupOutput {
			return nil, ErrBudget
		}
		return result, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return []byte(`{"row":null}`), nil
}
