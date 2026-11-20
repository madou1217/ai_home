package modelmetadata

import (
	"strings"
	"unicode"
)

// 模型 ID 的等价判定只在本文件定义一次。
//
// Node 来源：lib/server/model-id.js（normalizeModelVersionSeparators / modelIdsMatch）。
// 同一个模型在不同来源里既可能写成 `4.6` 也可能写成 `4-6`（上游目录、额度快照、
// WebUI 设置、计价快照各自习惯不同），因此"是不是同一个模型"必须有一份共享口径：
// 精确小写相等，或版本分隔符归一化后相等。
//
// 此前 transport 的目录收窄、models-dev 模态索引与计价快照各写了一份「数字.数字 → 数字-数字」
// 的规则；三份都改成调用本函数，避免其中之一改口径后其余静默漂移。

// NormalizeVersionSeparators 把「数字.数字」里的点换成横线（`gpt-5.5` → `gpt-5-5`）。
//
// 逐字符扫描而不是正则：Go 的 RE2 不支持 Node 版本里用到的 `(?=...)` 前瞻，
// 且线性扫描天然等价于「反复替换到不再变化」。
func NormalizeVersionSeparators(modelID string) string {
	runes := []rune(modelID)
	changed := false
	for index := 1; index < len(runes)-1; index++ {
		if runes[index] != '.' {
			continue
		}
		if unicode.IsDigit(runes[index-1]) && unicode.IsDigit(runes[index+1]) {
			runes[index] = '-'
			changed = true
		}
	}
	if !changed {
		return modelID
	}
	return string(runes)
}

// ModelIDLookupKeys 返回模型 ID 的比对键（小写原样，以及版本分隔符归一化后的形态）。
//
// 空串返回 nil：调用方应把空引用视为"没有模型"，而不是匹配一切。
func ModelIDLookupKeys(modelID string) []string {
	exact := strings.ToLower(strings.TrimSpace(modelID))
	if exact == "" {
		return nil
	}
	normalized := NormalizeVersionSeparators(exact)
	if normalized == exact || normalized == "" {
		return []string{exact}
	}
	return []string{exact, normalized}
}

// MatchModelIDs 判断两个模型 ID 是否指向同一个模型。
//
// 与 Node lib/server/model-id.js 的 modelIdsMatch 同语义：任一比对键相等即视为同模型。
func MatchModelIDs(left, right string) bool {
	leftKeys := ModelIDLookupKeys(left)
	if len(leftKeys) == 0 {
		return false
	}
	rightKeys := ModelIDLookupKeys(right)
	for _, leftKey := range leftKeys {
		for _, rightKey := range rightKeys {
			if leftKey == rightKey {
				return true
			}
		}
	}
	return false
}
