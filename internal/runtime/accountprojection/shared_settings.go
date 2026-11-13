package accountprojection

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// mergeSettingsFile 把投影里的 settings.json 并进宿主规范文件（target 优先）。
//
// 对齐 Node lib/runtime/codebuddy-shared-config.js 的 mergeSettingsFilesIntoCanonical：
// 对象递归合并、标量数组取并集、其它冲突保留 target。旧账号投影里的真实
// settings.json 会在这里一次性归一，然后由调用方删掉投影副本并建链接。
func mergeSettingsFile(sourcePath string, targetPath string) error {
	sourceData, err := os.ReadFile(sourcePath)
	if err != nil {
		return err
	}
	targetData, err := os.ReadFile(targetPath)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	source, sourceOK := decodeJSONObject(sourceData)
	target, targetOK := decodeJSONObject(targetData)
	if !sourceOK && !targetOK {
		return nil
	}
	merged := mergeJSONValue(target, source)
	encoded, err := json.MarshalIndent(merged, "", "  ")
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	writable := targetPath
	if resolved, resolveErr := filepath.EvalSymlinks(targetPath); resolveErr == nil {
		writable = resolved
	}
	return writeFileAtomic(writable, encoded, 0o600)
}

func decodeJSONObject(data []byte) (map[string]any, bool) {
	if len(data) == 0 {
		return nil, false
	}
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, false
	}
	object, ok := value.(map[string]any)
	return object, ok
}

// mergeJSONValue 以 target 为准：缺键补 source，嵌套对象递归，标量数组并集。
func mergeJSONValue(target any, source any) any {
	targetObject, targetOK := target.(map[string]any)
	sourceObject, sourceOK := source.(map[string]any)
	if targetOK && sourceOK {
		merged := make(map[string]any, len(targetObject)+len(sourceObject))
		for key, value := range targetObject {
			merged[key] = value
		}
		for key, value := range sourceObject {
			if existing, exists := merged[key]; exists {
				merged[key] = mergeJSONValue(existing, value)
				continue
			}
			merged[key] = value
		}
		return merged
	}
	if targetSlice, ok := target.([]any); ok {
		if sourceSlice, sourceIsSlice := source.([]any); sourceIsSlice {
			return unionJSONArray(targetSlice, sourceSlice)
		}
	}
	if target == nil {
		return source
	}
	return target
}

func unionJSONArray(target []any, source []any) []any {
	merged := append([]any(nil), target...)
	for _, item := range source {
		key, err := json.Marshal(item)
		if err != nil {
			continue
		}
		found := false
		for _, existing := range merged {
			existingKey, marshalErr := json.Marshal(existing)
			if marshalErr == nil && string(existingKey) == string(key) {
				found = true
				break
			}
		}
		if !found {
			merged = append(merged, item)
		}
	}
	return merged
}
