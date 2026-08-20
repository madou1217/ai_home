// Command modelsdevmodalities 从固定的 models.dev API catalog 快照生成 Go 模态索引。
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
)

const (
	snapshotSchemaVersion = 1
	modelsDevCatalogURL   = "https://models.dev/catalog.json"
)

var errInvalidSource = errors.New("models.dev catalog 快照无效")

// snapshotRecord 是嵌入 Go 二进制的稳定 JSON 记录。
type snapshotRecord struct {
	Input  []string `json:"input"`
	Output []string `json:"output"`
}

type sourceMetadata struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
}

type catalogDocument struct {
	SchemaVersion int             `json:"schemaVersion"`
	Source        sourceMetadata  `json:"source"`
	Catalog       json.RawMessage `json:"catalog"`
}

type catalogPayload struct {
	Models map[string]catalogModel `json:"models"`
}

type catalogModel struct {
	ID         string         `json:"id"`
	Modalities snapshotRecord `json:"modalities"`
}

// main 校验命令参数并原子替换生成快照。
func main() {
	var sourceFile string
	var targetFile string
	flag.StringVar(&sourceFile, "source", "", "models.dev catalog 固定快照")
	flag.StringVar(&targetFile, "target", "", "生成 JSON 文件")
	flag.Parse()
	if strings.TrimSpace(sourceFile) == "" || strings.TrimSpace(targetFile) == "" {
		fmt.Fprintln(os.Stderr, "source 和 target 不能为空")
		os.Exit(2)
	}
	if err := generateSnapshot(sourceFile, targetFile); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// generateSnapshot 构建确定性 JSON，并在成功后一次性替换目标文件。
func generateSnapshot(sourceFile string, targetFile string) error {
	snapshot, err := buildSnapshot(sourceFile)
	if err != nil {
		return err
	}
	document, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return fmt.Errorf("编码模态快照: %w", err)
	}
	document = append(document, '\n')
	temporaryFile := targetFile + ".tmp"
	if err := os.WriteFile(temporaryFile, document, 0o644); err != nil {
		return fmt.Errorf("写入临时模态快照: %w", err)
	}
	if err := os.Rename(temporaryFile, targetFile); err != nil {
		_ = os.Remove(temporaryFile)
		return fmt.Errorf("替换模态快照: %w", err)
	}
	return nil
}

// buildSnapshot 校验固定 catalog 的来源和内容哈希，再提取 canonical model 模态。
func buildSnapshot(sourceFile string) (map[string]snapshotRecord, error) {
	documentBytes, err := os.ReadFile(sourceFile)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errInvalidSource, err)
	}
	var document catalogDocument
	if err := json.Unmarshal(documentBytes, &document); err != nil {
		return nil, fmt.Errorf("%w: %v", errInvalidSource, err)
	}
	if document.SchemaVersion != snapshotSchemaVersion || document.Source.URL != modelsDevCatalogURL {
		return nil, errInvalidSource
	}
	digest := sha256.Sum256(document.Catalog)
	if !strings.EqualFold(hex.EncodeToString(digest[:]), document.Source.SHA256) {
		return nil, fmt.Errorf("%w: catalog sha256 不匹配", errInvalidSource)
	}

	var catalog catalogPayload
	if err := json.Unmarshal(document.Catalog, &catalog); err != nil || len(catalog.Models) == 0 {
		return nil, fmt.Errorf("%w: %v", errInvalidSource, err)
	}
	snapshot := make(map[string]snapshotRecord, len(catalog.Models))
	for modelID, model := range catalog.Models {
		if strings.TrimSpace(modelID) == "" || model.ID != modelID {
			return nil, fmt.Errorf("%w: model id %q", errInvalidSource, modelID)
		}
		if !validModalities(model.Modalities.Input) || !validModalities(model.Modalities.Output) {
			return nil, fmt.Errorf("%w: %s modalities", errInvalidSource, modelID)
		}
		snapshot[modelID] = snapshotRecord{
			Input:  append([]string(nil), model.Modalities.Input...),
			Output: append([]string(nil), model.Modalities.Output...),
		}
	}
	return snapshot, nil
}

func validModalities(values []string) bool {
	if len(values) == 0 {
		return false
	}
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) == "" || value != strings.TrimSpace(value) {
			return false
		}
		if _, duplicate := seen[value]; duplicate {
			return false
		}
		seen[value] = struct{}{}
	}
	return true
}
