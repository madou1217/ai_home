// Command modelsdevmodalities 从带来源声明的 models.dev catalog 文档生成 Go 模态索引。
// 输入文档由 scripts/gen-models-dev-modalities.js 依据 @opencode-ai/models SDK 快照临时产出。
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
)

const (
	snapshotSchemaVersion = 1
	modelsDevCatalogURL   = "https://models.dev/catalog.json"
)

var errInvalidSource = errors.New("models.dev catalog 快照无效")

// snapshotRecord 是嵌入 Go 二进制的稳定 JSON 记录。
//
// Efforts 是该模型声明的推理强度档位（升序、去重）。网关按它做阶梯对齐：
// 客户端要的档位（Claude Code 发 max）与模型能表达的档位（kimi k3 只有 low/high/max）
// 不是同一套词汇，没有这份数据就只能拒绝或猜。缺失表示「该模型没有档位概念」。
type snapshotRecord struct {
	Input   []string `json:"input"`
	Output  []string `json:"output"`
	Efforts []string `json:"efforts,omitempty"`
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
	Models    map[string]catalogModel  `json:"models"`
	Providers map[string]catalogSource `json:"providers"`
}

// catalogSource 是 models.dev 的单个 Provider 条目。
//
// 它的 models 是「该 Provider 视角下」的模型表：聚合类 Provider（opencode、
// github-copilot、zai-coding-plan 等）在这里给出自己的模型 ID，而这些 ID 在 canonical
// models 里并不存在。缺少这一层，消费方只能按厂商命名空间查，聚合 Provider 的模型
// 会一律查不到。
type catalogSource struct {
	Models map[string]catalogModel `json:"models"`
}

type catalogModel struct {
	ID               string                 `json:"id"`
	Modalities       snapshotRecord         `json:"modalities"`
	ReasoningOptions []catalogReasoningItem `json:"reasoning_options"`
}

// catalogReasoningItem 是 models.dev 的单个推理配置项。
//
// 只有 type=effort 的项携带档位枚举；toggle / budget_tokens 表达的是「能不能关」
// 与「给多少预算」，不是档位，因此不参与阶梯。
type catalogReasoningItem struct {
	Type   string   `json:"type"`
	Values []string `json:"values"`
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
	if err := appendModels(snapshot, "", catalog.Models); err != nil {
		return nil, err
	}
	// 只收录消费方真正会查的命名空间：全部 213 个 Provider 的模型表接近 8000 条，
	// 而这里用到的候选只有十来个，收录它们即可把嵌入体积控制在两倍以内。
	for _, namespace := range providerNamespaces {
		provider, found := catalog.Providers[namespace]
		if !found {
			continue
		}
		if err := appendModels(snapshot, namespace, provider.Models); err != nil {
			return nil, err
		}
	}
	return snapshot, nil
}

// providerNamespaces 是消费方（模态索引）会用到的 models.dev 命名空间。
//
// 与 Node 的 inferModelsDevProviderIds 候选集保持一致；新增候选时必须同步这里，
// 否则对应命名空间的模型会在索引里静默缺失。
var providerNamespaces = []string{
	"openai",
	"github-copilot",
	"anthropic",
	"google",
	"google-vertex",
	"xai",
	"moonshotai",
	"moonshotai-cn",
	"kimi-for-coding",
	"zai",
	"zhipuai",
	"zai-coding-plan",
	"zhipuai-coding-plan",
	"zhipu",
	"opencode",
	"opencode-go",
}

// appendModels 把一张模型表并入快照；namespace 为空时按 canonical 键写入。
func appendModels(
	snapshot map[string]snapshotRecord,
	namespace string,
	models map[string]catalogModel,
) error {
	for modelID, model := range models {
		if strings.TrimSpace(modelID) == "" || model.ID != modelID {
			return fmt.Errorf("%w: model id %q", errInvalidSource, modelID)
		}
		if !validModalities(model.Modalities.Input) || !validModalities(model.Modalities.Output) {
			return fmt.Errorf("%w: %s modalities", errInvalidSource, modelID)
		}
		efforts, err := effortLadder(model.ReasoningOptions)
		if err != nil {
			return fmt.Errorf("%w: %s", err, modelID)
		}
		key := modelID
		if namespace != "" {
			key = namespace + "/" + modelID
		}
		snapshot[key] = snapshotRecord{
			Input:   append([]string(nil), model.Modalities.Input...),
			Output:  append([]string(nil), model.Modalities.Output...),
			Efforts: efforts,
		}
	}
	return nil
}

// effortLadder 提取模型声明的强度档位，按强度升序去重。
//
// 排序必须与网关的 Canonical 强度全序一致（none<minimal<low<medium<high<xhigh<max<ultra）：
// 阶梯对齐按位置配对，顺序错了映射就错了。目录里出现未登记的档位是**数据错误**——
// 静默丢弃会让「模型支持该档位」变成「模型不支持」，比整条失败更危险。
func effortLadder(options []catalogReasoningItem) ([]string, error) {
	declared := make(map[string]struct{})
	for _, option := range options {
		if option.Type != "effort" {
			continue
		}
		for _, value := range option.Values {
			declared[value] = struct{}{}
		}
	}
	if len(declared) == 0 {
		return nil, nil
	}
	ordered := make([]string, 0, len(declared))
	for _, value := range canonicalEffortOrder {
		if _, found := declared[value]; found {
			ordered = append(ordered, value)
			delete(declared, value)
		}
	}
	if len(declared) > 0 {
		return nil, fmt.Errorf("未知推理档位 %v", sortedKeys(declared))
	}
	return ordered, nil
}

// canonicalEffortOrder 是网关 Canonical 推理强度的升序全序。
//
// 它与 core/inference 的 ReasoningEffort 枚举是同一套词汇；生成器不能 import core
// （生成工具必须独立于被生成物），因此这里显式重复一次，并由 core 侧的
// TestCanonicalEffortOrderMatchesGenerator 守住两者一致。
var canonicalEffortOrder = []string{
	"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
}

func sortedKeys(values map[string]struct{}) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
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
