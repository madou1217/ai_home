// Package legacy 只读扫描 Claude/Gemini 的静态会话目录，返回与 Node
// lib/sessions/session-reader-{claude,gemini}.js 一致的 projects/sessions 视图。
//
// 布局：
//
//	~/.claude/projects/<dir>/<session>.jsonl
//	~/.gemini/tmp/<project>/chats/<session>.json|.jsonl
//
// 目录缺失、单个项目或单条记录损坏时跳过，不把局部失败升级成整体错误。
package legacy

import (
	"encoding/json"
	"os"
	"sort"
	"strings"
)

// UnnamedTitle 是 Node 读取器对「读不出标题」的占位值；带此标题的会话不会出现在结果里。
const UnnamedTitle = "未命名会话"

// Session 与 Node 会话条目同形。
type Session struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	UpdatedAt      int64  `json:"updatedAt"`
	Provider       string `json:"provider"`
	ProjectDirName string `json:"projectDirName"`
}

// Project 与 Node 项目条目同形。
type Project struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Path     string    `json:"path"`
	Sessions []Session `json:"sessions"`
	Provider string    `json:"provider"`
}

func fileModifiedMillis(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.ModTime().UnixMilli()
}

func isDirectory(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// truncateTitle 等价于 JS 的 String#slice(0, 50)；按 rune 截断，避免切坏 UTF-8。
func truncateTitle(text string) string {
	runes := []rune(text)
	if len(runes) <= 50 {
		return text
	}
	return string(runes[:50])
}

func directoryNames(root string) []string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	return names
}

func fileNames(root, suffix string) []string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), suffix) {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	return names
}

// contentText 解析 Claude 的 message.content：string 或 [{type:"text",text:"..."}]。
// 数组只拼接 type=="text" 的块，与 Node 的 map/filter 行为一致。
func contentText(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return ""
	}
	parts := make([]string, 0, len(blocks))
	for _, block := range blocks {
		if block.Type == "text" && block.Text != "" {
			parts = append(parts, block.Text)
		}
	}
	return strings.Join(parts, " ")
}

// geminiContentText 解析 Gemini 的 content：string 或数组中第一个带 text 的块。
func geminiContentText(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text
	}
	var blocks []struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return ""
	}
	for _, block := range blocks {
		if block.Text != "" {
			return block.Text
		}
	}
	return ""
}

// splitLines 处理 LF/CRLF，并保留空行（调用方自行忽略）。
func splitLines(content string) []string {
	return strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
}
