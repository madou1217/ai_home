package proxykit

import "encoding/json"

// ProxyNode 表示标准化后的代理节点对象（保留协议字段与可选运行时元数据）。
type ProxyNode map[string]any

// Clone 深拷贝节点映射。
func (n ProxyNode) Clone() ProxyNode {
	if n == nil {
		return nil
	}
	raw, _ := json.Marshal(map[string]any(n))
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return ProxyNode(out)
}

func (n ProxyNode) Str(key string) string {
	if n == nil {
		return ""
	}
	v, ok := n[key]
	if !ok || v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return toString(v)
}

func (n ProxyNode) Int(key string) (int, bool) {
	if n == nil {
		return 0, false
	}
	v, ok := n[key]
	if !ok || v == nil {
		return 0, false
	}
	return toInt(v)
}

func (n ProxyNode) Float(key string) (float64, bool) {
	if n == nil {
		return 0, false
	}
	v, ok := n[key]
	if !ok || v == nil {
		return 0, false
	}
	return toFloat(v)
}

func (n ProxyNode) Bool(key string) (bool, bool) {
	if n == nil {
		return false, false
	}
	v, ok := n[key]
	if !ok || v == nil {
		return false, false
	}
	return toBool(v)
}

// FieldOptionDef 描述表单字段候选项。
type FieldOptionDef struct {
	Value any    `json:"value"`
	Label string `json:"label"`
}

// ProtocolFieldDef 描述单个协议表单字段。
type ProtocolFieldDef struct {
	Key      string           `json:"key"`
	Label    string           `json:"label"`
	Control  string           `json:"control"`
	Section  string           `json:"section"`
	Required bool             `json:"required"`
	Options  []FieldOptionDef `json:"options,omitempty"`
}

// ProtocolFormDef 描述协议表单元数据。
type ProtocolFormDef struct {
	Protocol string             `json:"protocol"`
	Name     string             `json:"name"`
	Defaults map[string]any     `json:"defaults"`
	Fields   []ProtocolFieldDef `json:"fields"`
}

// YAMLKV 与 YAMLMap 用于保持确定顺序的 YAML 键序。
type YAMLKV struct {
	Key   string
	Value any
}

// YAMLMap 按插入顺序序列化 YAML mapping。
type YAMLMap struct {
	Entries []YAMLKV
}

func (m *YAMLMap) Set(key string, val any) {
	if m == nil {
		return
	}
	for i := range m.Entries {
		if m.Entries[i].Key == key {
			m.Entries[i].Value = val
			return
		}
	}
	m.Entries = append(m.Entries, YAMLKV{Key: key, Value: val})
}

func (m *YAMLMap) Get(key string) (any, bool) {
	if m == nil {
		return nil, false
	}
	for _, e := range m.Entries {
		if e.Key == key {
			return e.Value, true
		}
	}
	return nil, false
}

func (m *YAMLMap) Delete(key string) {
	if m == nil {
		return
	}
	out := m.Entries[:0]
	for _, e := range m.Entries {
		if e.Key != key {
			out = append(out, e)
		}
	}
	m.Entries = out
}

type RelayEndpoint struct {
	Host     string
	Port     int
	Username string
	Password string
	UDP      bool
}
