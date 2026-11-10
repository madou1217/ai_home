package opencode

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
)

// JSONC 保留式改写的最小实现：只做到「定位到某个对象成员的值」并原地替换或补一条成员，
// 其余字节（用户自己的键、注释、空白、尾随逗号风格）一律不动。
//
// 不引第三方 jsonc 库是刻意的：这里只需要 set-path 一种编辑，而任何外部库都要把整份
// 文档重排一遍，反而保证不了「注释不被挪走」。

type node struct {
	kind    byte // '{' 对象，'[' 数组，'s' 标量
	start   int
	end     int
	close   int // 右括号偏移；标量为 -1
	comma   int // 对象/数组末尾多余逗号的偏移；没有为 -1
	members []member
	elems   []node
}

type member struct {
	key   string
	value node
	start int
	end   int
}

type parser struct {
	text []byte
	pos  int
}

type syntaxError struct {
	pos int
	msg string
}

func (e *syntaxError) Error() string {
	return fmt.Sprintf("jsonc: %s (offset %d)", e.msg, e.pos)
}

func parseJSONC(text []byte) (node, error) {
	p := &parser{text: text}
	p.skip()
	if p.pos >= len(text) {
		return node{}, &syntaxError{pos: p.pos, msg: "empty document"}
	}
	value, err := p.parseValue()
	if err != nil {
		return node{}, err
	}
	p.skip()
	if p.pos != len(text) {
		return node{}, &syntaxError{pos: p.pos, msg: "trailing content"}
	}
	return value, nil
}

func (p *parser) parseValue() (node, error) {
	p.skip()
	if p.pos >= len(p.text) {
		return node{}, &syntaxError{pos: p.pos, msg: "unexpected end of input"}
	}
	switch p.text[p.pos] {
	case '{':
		return p.parseObject()
	case '[':
		return p.parseArray()
	case '"':
		start := p.pos
		if _, err := p.parseString(); err != nil {
			return node{}, err
		}
		return node{kind: 's', start: start, end: p.pos, close: -1, comma: -1}, nil
	default:
		return p.parseScalar()
	}
}

func (p *parser) parseObject() (node, error) {
	value := node{kind: '{', start: p.pos, close: -1, comma: -1}
	p.pos++
	p.skip()
	if p.pos < len(p.text) && p.text[p.pos] == '}' {
		value.close = p.pos
		value.end = p.pos + 1
		p.pos++
		return value, nil
	}
	for {
		p.skip()
		keyStart := p.pos
		key, err := p.parseString()
		if err != nil {
			return node{}, err
		}
		p.skip()
		if p.pos >= len(p.text) || p.text[p.pos] != ':' {
			return node{}, &syntaxError{pos: p.pos, msg: "missing colon"}
		}
		p.pos++
		memberValue, err := p.parseValue()
		if err != nil {
			return node{}, err
		}
		value.members = append(value.members, member{
			key:   key,
			value: memberValue,
			start: keyStart,
			end:   memberValue.end,
		})
		p.skip()
		if p.pos >= len(p.text) {
			return node{}, &syntaxError{pos: p.pos, msg: "unterminated object"}
		}
		if p.text[p.pos] == ',' {
			commaPos := p.pos
			p.pos++
			p.skip()
			if p.pos < len(p.text) && p.text[p.pos] == '}' {
				value.comma = commaPos
				value.close = p.pos
				value.end = p.pos + 1
				p.pos++
				return value, nil
			}
			continue
		}
		if p.text[p.pos] == '}' {
			value.close = p.pos
			value.end = p.pos + 1
			p.pos++
			return value, nil
		}
		return node{}, &syntaxError{pos: p.pos, msg: "expected , or }"}
	}
}

func (p *parser) parseArray() (node, error) {
	value := node{kind: '[', start: p.pos, close: -1, comma: -1}
	p.pos++
	p.skip()
	if p.pos < len(p.text) && p.text[p.pos] == ']' {
		value.close = p.pos
		value.end = p.pos + 1
		p.pos++
		return value, nil
	}
	for {
		element, err := p.parseValue()
		if err != nil {
			return node{}, err
		}
		value.elems = append(value.elems, element)
		p.skip()
		if p.pos >= len(p.text) {
			return node{}, &syntaxError{pos: p.pos, msg: "unterminated array"}
		}
		if p.text[p.pos] == ',' {
			commaPos := p.pos
			p.pos++
			p.skip()
			if p.pos < len(p.text) && p.text[p.pos] == ']' {
				value.comma = commaPos
				value.close = p.pos
				value.end = p.pos + 1
				p.pos++
				return value, nil
			}
			continue
		}
		if p.text[p.pos] == ']' {
			value.close = p.pos
			value.end = p.pos + 1
			p.pos++
			return value, nil
		}
		return node{}, &syntaxError{pos: p.pos, msg: "expected , or ]"}
	}
}

func (p *parser) parseScalar() (node, error) {
	start := p.pos
	for p.pos < len(p.text) && !isScalarStop(p.text[p.pos]) {
		p.pos++
	}
	if p.pos == start {
		return node{}, &syntaxError{pos: start, msg: "unexpected token"}
	}
	raw := p.text[start:p.pos]
	if !json.Valid(raw) {
		return node{}, &syntaxError{pos: start, msg: "invalid literal"}
	}
	return node{kind: 's', start: start, end: p.pos, close: -1, comma: -1}, nil
}

func (p *parser) parseString() (string, error) {
	if p.pos >= len(p.text) || p.text[p.pos] != '"' {
		return "", &syntaxError{pos: p.pos, msg: "expected string"}
	}
	start := p.pos
	p.pos++
	for p.pos < len(p.text) {
		switch p.text[p.pos] {
		case '\\':
			p.pos += 2
			continue
		case '"':
			p.pos++
			var decoded string
			if err := json.Unmarshal(p.text[start:p.pos], &decoded); err != nil {
				return "", &syntaxError{pos: start, msg: "invalid string"}
			}
			return decoded, nil
		case '\n':
			return "", &syntaxError{pos: p.pos, msg: "newline in string"}
		}
		p.pos++
	}
	return "", &syntaxError{pos: start, msg: "unterminated string"}
}

func (p *parser) skip() {
	for p.pos < len(p.text) {
		switch {
		case isSpace(p.text[p.pos]):
			p.pos++
		case p.text[p.pos] == '/' && p.pos+1 < len(p.text) && p.text[p.pos+1] == '/':
			for p.pos < len(p.text) && p.text[p.pos] != '\n' {
				p.pos++
			}
		case p.text[p.pos] == '/' && p.pos+1 < len(p.text) && p.text[p.pos+1] == '*':
			rest := bytes.Index(p.text[p.pos+2:], []byte("*/"))
			if rest < 0 {
				p.pos = len(p.text)
				return
			}
			p.pos += rest + 4
		default:
			return
		}
	}
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r'
}

func isScalarStop(c byte) bool {
	switch c {
	case ',', '}', ']', ' ', '\t', '\n', '\r', '/':
		return true
	}
	return false
}

// ---------------------------------------------------------------------------
// 编辑
// ---------------------------------------------------------------------------

type edit struct {
	start int
	end   int
	text  string
}

// setPath 在 text 上把 path 指向的值替换成 value；路径不存在则补一条成员。
// 返回新文本，输入不被修改。
func setPath(text []byte, path []string, value any) ([]byte, error) {
	root, err := parseJSONC(text)
	if err != nil {
		return nil, err
	}
	if root.kind != '{' {
		return nil, &syntaxError{pos: root.start, msg: "root must be an object"}
	}
	edits, err := planSet(text, root, path, value)
	if err != nil {
		return nil, err
	}
	return applyEdits(text, edits), nil
}

func planSet(text []byte, object node, path []string, value any) ([]edit, error) {
	if len(path) == 0 {
		return nil, &syntaxError{pos: object.start, msg: "empty path"}
	}
	existing, found := object.lookup(path[0])
	if !found {
		return []edit{insertEdit(text, object, path[0], nest(path[1:], value))}, nil
	}
	if len(path) == 1 {
		return []edit{replaceEdit(text, existing, value)}, nil
	}
	if existing.value.kind != '{' {
		// 目标中间层不是对象（手写成 null / 字符串）：整块换掉才能继续落笔。
		return []edit{replaceEdit(text, existing, nest(path[1:], value))}, nil
	}
	return planSet(text, existing.value, path[1:], value)
}

func replaceEdit(text []byte, target member, value any) edit {
	indent := lineIndent(text, target.start)
	return edit{start: target.value.start, end: target.value.end, text: encodeJSON(value, indent)}
}

// insertEdit 把 key 追加到对象末尾：保持在成员所在缩进层级，沿用原文件的尾随逗号风格。
func insertEdit(text []byte, object node, key string, value any) edit {
	baseIndent := lineIndent(text, object.start)
	indent := baseIndent + "  "
	if len(object.members) > 0 {
		if memberIndent := lineIndent(text, object.members[len(object.members)-1].start); memberIndent != "" {
			indent = memberIndent
		}
	}
	entry := quote(key) + ": " + encodeJSON(value, indent)
	if len(object.members) == 0 {
		inner := text[object.start+1 : object.close]
		if len(bytes.TrimSpace(inner)) == 0 {
			return edit{start: object.start + 1, end: object.close, text: "\n" + indent + entry + "\n" + baseIndent}
		}
		// 空对象里只有注释：注释原样留在下面，新成员插在 { 之后。
		return edit{start: object.start + 1, end: object.start + 1, text: "\n" + indent + entry + ","}
	}
	if object.comma >= 0 {
		return edit{start: object.comma + 1, end: object.comma + 1, text: "\n" + indent + entry + ","}
	}
	last := object.members[len(object.members)-1]
	return edit{start: last.end, end: last.end, text: ",\n" + indent + entry}
}

func applyEdits(text []byte, edits []edit) []byte {
	sort.Slice(edits, func(i, j int) bool { return edits[i].start > edits[j].start })
	out := append([]byte(nil), text...)
	for _, item := range edits {
		next := make([]byte, 0, len(out)-(item.end-item.start)+len(item.text))
		next = append(next, out[:item.start]...)
		next = append(next, item.text...)
		next = append(next, out[item.end:]...)
		out = next
	}
	return out
}

// nest 把剩余路径包成嵌套对象字面量，供「中间层缺失或类型不对」时整体替换。
func nest(path []string, value any) any {
	for i := len(path) - 1; i >= 0; i-- {
		wrapper := newOrderedObject()
		wrapper.set(path[i], value)
		value = wrapper
	}
	return value
}

// lineIndent 返回 offset 所在行的前导空白。
func lineIndent(text []byte, offset int) string {
	if offset > len(text) {
		offset = len(text)
	}
	lineStart := bytes.LastIndexByte(text[:offset], '\n') + 1
	end := lineStart
	for end < offset && (text[end] == ' ' || text[end] == '\t') {
		end++
	}
	return string(text[lineStart:end])
}

func (object node) lookup(key string) (member, bool) {
	for _, item := range object.members {
		if item.key == key {
			return item, true
		}
	}
	return member{}, false
}
