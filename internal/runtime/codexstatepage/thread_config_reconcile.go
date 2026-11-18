package codexstatepage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"regexp"
	"strconv"
	"unicode/utf8"

	"github.com/madou1217/ai_home/internal/runtime/jsondocument"
)

const MaxThreadConfigReconcileInput = 256 << 10
const maxThreadConfigReconcileOutput = 1 << 20

var errThreadConfigReconcileInput = errors.New("codex_thread_config_reconcile_input_invalid")
var errThreadConfigReconcileUnavailable = errors.New("codex_thread_config_reconcile_unavailable")
var managedReconcileProvider = regexp.MustCompile(`^aih_[A-Za-z0-9_-]+$`)

// Admit only the finite subset for which discover has the same order as the
// original JS selector: bounded exact integers, with no same-directory version
// tie requiring localeCompare. Directory errors and >16 sources stay optional
// unavailable. Do not claim arbitrary filesystem or locale equivalence.
func managedReconcileSources(home string) ([]string, error) {
	paths, err := discover(home)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool)
	for _, path := range paths {
		name := filepath.Base(path)
		for _, char := range name {
			if char > 127 {
				return nil, errThreadConfigReconcileUnavailable
			}
		}
		match := stateName.FindStringSubmatch(name)
		if len(match) != 2 {
			return nil, errThreadConfigReconcileUnavailable
		}
		version, err := strconv.ParseUint(match[1], 10, 31)
		if err != nil {
			return nil, errThreadConfigReconcileUnavailable
		}
		key := filepath.Dir(path) + "\x00" + strconv.FormatUint(version, 10)
		if seen[key] {
			return nil, errThreadConfigReconcileUnavailable
		}
		seen[key] = true
	}
	return paths, nil
}

// SQL text and NULL are the supported vendor schema contract. An unsupported
// successful row is unavailable, not permission to query a later convenient DB.
func managedReconcileText(value any) (string, error) {
	if value == nil {
		return "", nil
	}
	text, ok := value.(string)
	if !ok || !utf8.ValidString(text) {
		return "", errThreadConfigReconcileUnavailable
	}
	if len(text) > MaxThreadConfigReconcileInput {
		return "", ErrBudget
	}
	return responseTrim(text), nil
}

// CompileThreadConfigReconcile owns the managed-provider source selection,
// three-column read and changed/context policy. TOML and native resume remain
// caller-owned. A successful query is authoritative even when it finds no row.
func CompileThreadConfigReconcile(ctx context.Context, raw []byte) ([]byte, error) {
	if len(raw) > MaxThreadConfigReconcileInput {
		return nil, ErrBudget
	}
	request, err := jsondocument.Object(raw)
	if err != nil || len(request) != 6 || request["version"] != json.Number("1") {
		return nil, errThreadConfigReconcileInput
	}
	home, homeOK := request["codexHome"].(string)
	method, methodOK := request["method"].(string)
	threadID, idOK := request["threadId"].(string)
	provider, providerOK := request["currentProvider"].(string)
	model, modelOK := request["currentModel"].(string)
	if !homeOK || !filepath.IsAbs(home) || filepath.Clean(home) != home || responseTrim(home) != home ||
		!methodOK || (method != "thread/read" && method != "thread/resume") ||
		!idOK || threadID == "" || responseTrim(threadID) != threadID ||
		!providerOK || (provider != "aih" && !managedReconcileProvider.MatchString(provider)) ||
		!modelOK || responseTrim(model) != model {
		return nil, errThreadConfigReconcileInput
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
		var persistedProvider, persistedModel, cwd any
		err = tx.QueryRowContext(ctx, "SELECT model_provider, model, cwd FROM threads WHERE id = ?", threadID).
			Scan(&persistedProvider, &persistedModel, &cwd)
		_ = tx.Rollback()
		_ = db.Close()
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			continue
		}
		providerValue, valueErr := managedReconcileText(persistedProvider)
		if valueErr != nil {
			return nil, valueErr
		}
		modelValue, valueErr := managedReconcileText(persistedModel)
		if valueErr != nil {
			return nil, valueErr
		}
		contextValue := map[string]any{
			"changed": false, "method": method, "threadId": threadID,
			"stateDbPath": path, "persistedProvider": providerValue,
			"persistedModel": modelValue, "currentProvider": provider,
		}
		if !errors.Is(err, sql.ErrNoRows) && providerValue != "" {
			// JS's providerDifference || (currentModel && modelDifference)
			// intentionally yields an empty string when both model strings are
			// empty and providers match. Preserve that value, not only truthiness.
			var changed any = providerValue != provider
			if providerValue == provider {
				if model == "" {
					changed = ""
				} else {
					changed = modelValue != model
				}
			}
			contextValue["changed"] = changed
			contextValue["currentModel"] = model
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		result, err := marshalWire(map[string]any{"context": contextValue})
		if len(result)+1 > maxThreadConfigReconcileOutput {
			return nil, ErrBudget
		}
		return result, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return []byte(`{"context":null}`), nil
}
