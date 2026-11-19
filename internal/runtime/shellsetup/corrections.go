package shellsetup

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// CorrectionsFileName 是拼写纠正存储的文件名。
const CorrectionsFileName = "corrections.json"

// CorrectionsMaxEntries 限制学习表大小，避免无限增长。
const CorrectionsMaxEntries = 200

// Correction 是一条「错法 → 正确 argv」记录。
type Correction struct {
	Typo    string   `json:"typo"`
	Argv    []string `json:"argv"`
	Command string   `json:"command"`
}

type correctionRecord struct {
	argv []string
}

// CorrectionsStore 管理已学习的拼写纠正。
type CorrectionsStore struct {
	FilePath string
}

// NewCorrectionsStore 使用 aih 数据目录构造存储。
func NewCorrectionsStore(aiHomeDir string) *CorrectionsStore {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return &CorrectionsStore{}
	}
	return &CorrectionsStore{FilePath: filepath.Join(root, "run", "shell", CorrectionsFileName)}
}

type orderedCorrections struct {
	order []string
	items map[string][]string
}

func (o *orderedCorrections) set(key string, argv []string) {
	if _, exists := o.items[key]; !exists {
		o.order = append(o.order, key)
	} else {
		for index, existing := range o.order {
			if existing == key {
				o.order = append(o.order[:index], o.order[index+1:]...)
				break
			}
		}
		o.order = append(o.order, key)
	}
	o.items[key] = argv
}

func (o *orderedCorrections) delete(key string) bool {
	if _, exists := o.items[key]; !exists {
		return false
	}
	delete(o.items, key)
	for index, existing := range o.order {
		if existing == key {
			o.order = append(o.order[:index], o.order[index+1:]...)
			break
		}
	}
	return true
}

func readCorrections(filePath string) *orderedCorrections {
	result := &orderedCorrections{items: map[string][]string{}}
	if filePath == "" {
		return result
	}
	raw, err := os.ReadFile(filePath)
	if err != nil {
		return result
	}
	var document struct {
		Entries json.RawMessage `json:"entries"`
	}
	if err := json.Unmarshal(raw, &document); err != nil || len(document.Entries) == 0 {
		return result
	}
	decoder := json.NewDecoder(bytes.NewReader(document.Entries))
	token, err := decoder.Token()
	if err != nil {
		return result
	}
	if delimiter, ok := token.(json.Delim); !ok || delimiter != '{' {
		return result
	}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return result
		}
		key, _ := keyToken.(string)
		var record struct {
			Argv []any `json:"argv"`
		}
		if err := decoder.Decode(&record); err != nil {
			return result
		}
		argv := make([]string, 0, len(record.Argv))
		for _, token := range record.Argv {
			argv = append(argv, fmt.Sprintf("%v", token))
		}
		if key == "" || len(argv) == 0 {
			continue
		}
		result.set(key, argv)
	}
	return result
}

func escapeJSON(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func writeCorrections(filePath string, data *orderedCorrections) error {
	order := data.order
	if len(order) > CorrectionsMaxEntries {
		order = order[len(order)-CorrectionsMaxEntries:]
	}
	var buffer bytes.Buffer
	buffer.WriteString("{\n \"version\": 1,\n \"entries\": {\n")
	for index, key := range order {
		buffer.WriteString("  ")
		buffer.WriteString(escapeJSON(key))
		buffer.WriteString(": {\n   \"argv\": [\n")
		argv := data.items[key]
		for argvIndex, token := range argv {
			buffer.WriteString("    ")
			buffer.WriteString(escapeJSON(token))
			if argvIndex < len(argv)-1 {
				buffer.WriteString(",")
			}
			buffer.WriteString("\n")
		}
		buffer.WriteString("   ]\n  }")
		if index < len(order)-1 {
			buffer.WriteString(",")
		}
		buffer.WriteString("\n")
	}
	buffer.WriteString(" }\n}\n")
	if err := os.MkdirAll(filepath.Dir(filePath), 0o700); err != nil {
		return err
	}
	temporary := fmt.Sprintf("%s.%d.tmp", filePath, os.Getpid())
	if err := os.WriteFile(temporary, buffer.Bytes(), 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, filePath)
}

// Record 记下一次确认过的纠正（同一错法后写覆盖先写）。
func (s *CorrectionsStore) Record(typo string, argv []string) bool {
	if s == nil || s.FilePath == "" {
		return false
	}
	key := strings.TrimSpace(typo)
	words := make([]string, 0, len(argv))
	for _, token := range argv {
		if token != "" {
			words = append(words, token)
		}
	}
	if key == "" || len(words) == 0 {
		return false
	}
	data := readCorrections(s.FilePath)
	data.set(key, words)
	return writeCorrections(s.FilePath, data) == nil
}

// Forget 删除一条纠正记录。
func (s *CorrectionsStore) Forget(typo string) bool {
	if s == nil || s.FilePath == "" {
		return false
	}
	data := readCorrections(s.FilePath)
	if !data.delete(strings.TrimSpace(typo)) {
		return false
	}
	return writeCorrections(s.FilePath, data) == nil
}

// List 返回按学习顺序排列的纠正。
func (s *CorrectionsStore) List() []Correction {
	if s == nil || s.FilePath == "" {
		return []Correction{}
	}
	data := readCorrections(s.FilePath)
	result := make([]Correction, 0, len(data.order))
	for _, key := range data.order {
		argv := data.items[key]
		result = append(result, Correction{Typo: key, Argv: argv, Command: strings.Join(argv, " ")})
	}
	return result
}
