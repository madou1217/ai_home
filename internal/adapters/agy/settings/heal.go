// Package settings 自愈 agy（Antigravity CLI）运行投影里的 settings.json。
//
// 迁移来源（Node）：
//   - lib/runtime/agy-settings-heal.js  healAgySettingsModel 的完整行为
//   - lib/runtime/agy-model-names.js    模型 id ↔ CLI 显示名（见 modelnames.go）
//   - lib/server/native-session-launch-preparation.js  启动准备阶段调用本自愈
//
// 事实（Node 注释同源，2026-10-15 本机实测）：settings.json 的 model 字段会过期——
// 账号投影与宿主都停在不被 CLI 识别的旧显示名（如 "Gemini 3.5 Flash (High)"）。
// 直接跑 agy（不经 aih 传 --model）会拿这个过期默认去请求上游，
// 得到 RESOURCE_EXHAUSTED (429)（agy 包装成「AI credits balance is too low」）。
//
// 这里在启动准备阶段把它修成当前有效名：幂等、best effort、原文件先备份、
// 只改 model 一个字段，其它键与顺序原样保留（含用户自己的自定义键）。
package settings

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// 自愈结果状态，取值与 Node healAgySettingsModel 的返回值一致。
const (
	StatusOK      = "ok"
	StatusHealed  = "healed"
	StatusSkipped = "skipped"
	StatusFailed  = "failed"
)

// 跳过/失败原因码，与 Node 一致（wiring 侧按这些码记诊断）。
const (
	ReasonSettingsPathUnavailable = "settings_path_unavailable"
	ReasonSettingsUnreadable      = "settings_unreadable"
	ReasonNoKnownModelName        = "no_known_model_name"
)

// backupSuffix 是首次自愈前保存原文件的备份后缀（Node 同款）。
const backupSuffix = ".aih-model-heal.bak"

// DefaultSettingsRelative 是 settings.json 相对 HOME/投影根的路径
// （对应 Node DEFAULT_SETTINGS_RELATIVE）。
var DefaultSettingsRelative = []string{".gemini", "antigravity-cli", "settings.json"}

// Result 对应 Node healAgySettingsModel 的返回对象：status 必填，
// from/to 只在 ok/healed 时有意义，reason 只在 skipped/failed 时有意义。
type Result struct {
	Status string
	From   string
	To     string
	Reason string
}

// ProjectionSettingsPath 返回投影里的 settings.json 路径，等价 Node 的
// path.join(projectionDir, ...DEFAULT_SETTINGS_RELATIVE)。
// projectionDir 为空时返回空串：Node handler 在这种情况下直接 skipped，
// 不拼相对路径，避免误写进程当前目录。
func ProjectionSettingsPath(projectionDir string) string {
	dir := strings.TrimSpace(projectionDir)
	if dir == "" {
		return ""
	}
	parts := append([]string{dir}, DefaultSettingsRelative...)
	return filepath.Join(parts...)
}

// HealModel 修一个 agy settings 文件里的默认模型，逐条对齐 Node healAgySettingsModel：
//
//   - settingsPath 为空 → skipped / settings_path_unavailable；
//   - 文件读不到、不是合法 JSON、或顶层不是对象 → skipped / settings_unreadable；
//   - 当前 model 已是合法 id 或显示名 → ok（from=to=当前值），不写文件；
//   - 否则优先用 preferredModel（id 或显示名），非法或缺省时回落到 DefaultModelName()；
//   - 写前把原文件复制成 <settingsPath>.aih-model-heal.bak，已存在则不覆盖
//     （重复自愈永远保留用户最初的文件）；
//   - 只替换 model 一个键；缩进 2 空格、结尾换行，与 JSON.stringify(..., null, 2) 一致；
//   - 任何备份/写入错误 → failed / 错误文本（best effort：调用方不拦会话启动）。
//
// 与 Node 的刻意差异（都不影响「是否自愈」）：
//   - 顶层是数组时 Node 会继续（数组也是 object）并把整个文件覆盖成对象；这里按不可读跳过，
//     避免毁掉用户文件；
//   - 非 model 的数值/字符串值保留原 JSON 文本（Node 会重排数字，如 1.50 → 1.5）；
//   - model 是非字符串时，诊断里的 from 用 JSON 原文（Node 为 "[object Object]"/"1,2"）。
func HealModel(settingsPath string, preferredModel string) Result {
	path := strings.TrimSpace(settingsPath)
	if path == "" {
		return Result{Status: StatusSkipped, Reason: ReasonSettingsPathUnavailable}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return Result{Status: StatusSkipped, Reason: ReasonSettingsUnreadable}
	}
	document, err := parseDocument(raw)
	if err != nil {
		return Result{Status: StatusSkipped, Reason: ReasonSettingsUnreadable}
	}
	current := document.textValue("model")
	if ResolveModelName(current) != "" {
		return Result{Status: StatusOK, From: current, To: current}
	}
	preferred := ResolveModelName(preferredModel)
	if preferred == "" {
		preferred = DefaultModelName()
	}
	if preferred == "" {
		return Result{Status: StatusSkipped, Reason: ReasonNoKnownModelName}
	}
	// 备份只在第一次自愈时落盘。Node 用 existsSync 判断，这里对非 NotExist 错误
	// 也直接失败：无法确认备份状态时不能冒险写掉用户原文件。
	backupPath := path + backupSuffix
	if _, statErr := os.Stat(backupPath); statErr != nil {
		if !errors.Is(statErr, os.ErrNotExist) {
			return Result{Status: StatusFailed, Reason: statErr.Error()}
		}
		mode := os.FileMode(0o600)
		if info, infoErr := os.Stat(path); infoErr == nil {
			mode = info.Mode().Perm()
		}
		if writeErr := os.WriteFile(backupPath, raw, mode); writeErr != nil {
			return Result{Status: StatusFailed, Reason: writeErr.Error()}
		}
	}
	if err := document.setString("model", preferred); err != nil {
		return Result{Status: StatusFailed, Reason: err.Error()}
	}
	updated, err := document.marshalIndent()
	if err != nil {
		return Result{Status: StatusFailed, Reason: err.Error()}
	}
	// Node 用 writeFileSync 直接截断写入，保留 inode/权限/xattr；这里同语义。
	if err := os.WriteFile(path, updated, 0o666); err != nil {
		return Result{Status: StatusFailed, Reason: err.Error()}
	}
	return Result{Status: StatusHealed, From: current, To: preferred}
}

// document 是保序的顶层 JSON 对象。
//
// Node 用 { ...settings, model } 改写，键顺序保留（model 原位替换，缺失则追加）；
// Go 的 map 会按字典序重排，直接改写成 map 会让用户文件的 diff 噪声很大。
// 这里只解析顶层键值，值保留原始 JSON 字节，写回时再统一缩进。
type document struct {
	entries []documentEntry
}

type documentEntry struct {
	key string
	raw json.RawMessage
}

var errNotJSONObject = errors.New("agy settings 顶层不是 JSON 对象")

// parseDocument 解析顶层对象并保留键顺序；重复键按 JSON.parse 语义取最后一个值、
// 位置沿用首次出现处。
func parseDocument(raw []byte) (*document, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	if delim, ok := token.(json.Delim); !ok || delim != '{' {
		return nil, errNotJSONObject
	}
	result := &document{}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, errNotJSONObject
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		result.replaceOrAppend(key, value)
	}
	if _, err := decoder.Token(); err != nil { // 关闭的 '}'
		return nil, err
	}
	// JSON.parse 拒绝尾随内容；decoder 默认允许多个顶层值，必须显式确认已到文件末尾。
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, errors.New("agy settings 含尾随内容")
		}
		return nil, err
	}
	return result, nil
}

func (d *document) indexOf(key string) int {
	for index, entry := range d.entries {
		if entry.key == key {
			return index
		}
	}
	return -1
}

func (d *document) replaceOrAppend(key string, raw json.RawMessage) {
	if index := d.indexOf(key); index >= 0 {
		d.entries[index].raw = append(json.RawMessage(nil), raw...)
		return
	}
	d.entries = append(d.entries, documentEntry{key: key, raw: append(json.RawMessage(nil), raw...)})
}

func (d *document) rawValue(key string) (json.RawMessage, bool) {
	if index := d.indexOf(key); index >= 0 {
		return d.entries[index].raw, true
	}
	return nil, false
}

// textValue 复刻 Node 的 String(settings.model || ”).trim()，只用于判断当前默认模型
// 与填充诊断里的 from。数字 0 与 false 在 JS 里是 falsy → 空串。
func (d *document) textValue(key string) string {
	raw, found := d.rawValue(key)
	if !found {
		return ""
	}
	text := bytes.TrimSpace(raw)
	if len(text) == 0 {
		return ""
	}
	switch text[0] {
	case '"':
		var value string
		if err := json.Unmarshal(text, &value); err != nil {
			return ""
		}
		return strings.TrimSpace(value)
	case 'n': // null
		return ""
	case 't': // true
		return string(text)
	case 'f': // false
		return ""
	case '[', '{':
		// Node 得到 "1,2"/"[object Object]"；这里用 JSON 原文，差异只影响诊断文本。
		return string(text)
	}
	number, err := strconv.ParseFloat(string(text), 64)
	if err != nil {
		return string(text)
	}
	if number == 0 {
		return ""
	}
	return string(text)
}

func (d *document) setString(key, value string) error {
	encoded, err := marshalJSONString(value)
	if err != nil {
		return err
	}
	d.replaceOrAppend(key, json.RawMessage(encoded))
	return nil
}

// marshalIndent 生成与 Node JSON.stringify(document, null, 2) + 换行 等价的文本。
// json.Indent 不做 HTML 转义（Go 的 Marshal 会把 < > & 转成 \u003c 等），
// 这样 statusLine.command 里含 shell 元字符时保持用户原文。
func (d *document) marshalIndent() ([]byte, error) {
	var compact bytes.Buffer
	compact.WriteByte('{')
	for index, entry := range d.entries {
		if index > 0 {
			compact.WriteByte(',')
		}
		key, err := marshalJSONString(entry.key)
		if err != nil {
			return nil, err
		}
		compact.Write(key)
		compact.WriteByte(':')
		compact.Write(entry.raw)
	}
	compact.WriteByte('}')
	var formatted bytes.Buffer
	if err := json.Indent(&formatted, compact.Bytes(), "", "  "); err != nil {
		return nil, err
	}
	formatted.WriteByte('\n')
	return formatted.Bytes(), nil
}

// marshalJSONString 按 JSON.stringify 的风格编码字符串：不转义 < > &。
func marshalJSONString(value string) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
}
