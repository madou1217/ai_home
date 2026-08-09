// Command modelsdevmodalities 从 vendored models.dev 生成 Go 运行时只读模态快照。
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

var (
	// errInvalidSource 表示 models.dev 文件缺失或声明了损坏的继承和模态。
	errInvalidSource = errors.New("models.dev 模态数据无效")
)

// rawModel 保存生成阶段所需的最小 TOML 字段。
type rawModel struct {
	baseModel string
	input     []string
	output    []string
}

// snapshotRecord 是嵌入 Go 二进制的稳定 JSON 记录。
type snapshotRecord struct {
	Input  []string `json:"input"`
	Output []string `json:"output"`
}

// main 校验命令参数并原子替换生成快照。
func main() {
	var sourceRoot string
	var targetFile string
	flag.StringVar(&sourceRoot, "source", "", "models.dev 的 models 目录")
	flag.StringVar(&targetFile, "target", "", "生成 JSON 文件")
	flag.Parse()
	if strings.TrimSpace(sourceRoot) == "" || strings.TrimSpace(targetFile) == "" {
		fmt.Fprintln(os.Stderr, "source 和 target 不能为空")
		os.Exit(2)
	}
	if err := generateSnapshot(sourceRoot, targetFile); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// generateSnapshot 构建确定性 JSON，并在成功后一次性替换目标文件。
func generateSnapshot(sourceRoot string, targetFile string) error {
	snapshot, err := buildSnapshot(sourceRoot)
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

// buildSnapshot 扫描基础模型定义，解析继承后生成完整不可变记录。
func buildSnapshot(sourceRoot string) (map[string]snapshotRecord, error) {
	models := make(map[string]rawModel)
	err := filepath.WalkDir(sourceRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".toml" {
			return nil
		}
		modelID, err := modelIDFromPath(sourceRoot, path)
		if err != nil {
			return err
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		model, parseErr := parseModelDocument(file)
		closeErr := file.Close()
		if parseErr != nil {
			return fmt.Errorf("解析 %s: %w", modelID, parseErr)
		}
		if closeErr != nil {
			return closeErr
		}
		models[modelID] = model
		return nil
	})
	if err != nil || len(models) == 0 {
		return nil, fmt.Errorf("%w: %v", errInvalidSource, err)
	}
	snapshot := make(map[string]snapshotRecord, len(models))
	for modelID := range models {
		resolved, resolveErr := resolveModel(modelID, models, map[string]bool{})
		if resolveErr != nil || len(resolved.input) == 0 || len(resolved.output) == 0 {
			return nil, fmt.Errorf("%w: %s: %v", errInvalidSource, modelID, resolveErr)
		}
		snapshot[modelID] = snapshotRecord{
			Input:  append([]string(nil), resolved.input...),
			Output: append([]string(nil), resolved.output...),
		}
	}
	return snapshot, nil
}

// modelIDFromPath 把跨平台相对路径转换为 models.dev 的斜杠模型键。
func modelIDFromPath(root string, path string) (string, error) {
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == "." || strings.HasPrefix(relative, "..") {
		return "", errInvalidSource
	}
	return filepath.ToSlash(strings.TrimSuffix(relative, filepath.Ext(relative))), nil
}

// parseModelDocument 从 TOML 中只提取 base_model 和 [modalities]。
func parseModelDocument(source io.Reader) (rawModel, error) {
	var model rawModel
	section := ""
	scanner := bufio.NewScanner(source)
	for scanner.Scan() {
		line := strings.TrimSpace(stripTomlComment(scanner.Text()))
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.TrimSpace(strings.Trim(line, "[]"))
			continue
		}
		key, value, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if section == "" && key == "base_model" {
			if err := json.Unmarshal([]byte(value), &model.baseModel); err != nil {
				return rawModel{}, errInvalidSource
			}
			continue
		}
		if section != "modalities" {
			continue
		}
		switch key {
		case "input":
			if err := json.Unmarshal([]byte(value), &model.input); err != nil {
				return rawModel{}, errInvalidSource
			}
		case "output":
			if err := json.Unmarshal([]byte(value), &model.output); err != nil {
				return rawModel{}, errInvalidSource
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return rawModel{}, err
	}
	return model, nil
}

// stripTomlComment 删除字符串外的行尾注释，保留字符串内的井号。
func stripTomlComment(line string) string {
	inString := false
	escaped := false
	for index, character := range line {
		if escaped {
			escaped = false
			continue
		}
		if character == '\\' && inString {
			escaped = true
			continue
		}
		if character == '"' {
			inString = !inString
			continue
		}
		if character == '#' && !inString {
			return line[:index]
		}
	}
	return line
}

// resolveModel 递归合并基础模型，拒绝缺失父项和循环继承。
func resolveModel(
	modelID string,
	models map[string]rawModel,
	visiting map[string]bool,
) (rawModel, error) {
	model, found := models[modelID]
	if !found || visiting[modelID] {
		return rawModel{}, errInvalidSource
	}
	if model.baseModel == "" {
		return model, nil
	}
	visiting[modelID] = true
	parent, err := resolveModel(model.baseModel, models, visiting)
	delete(visiting, modelID)
	if err != nil {
		return rawModel{}, err
	}
	if len(model.input) == 0 {
		model.input = append([]string(nil), parent.input...)
	}
	if len(model.output) == 0 {
		model.output = append([]string(nil), parent.output...)
	}
	return model, nil
}
