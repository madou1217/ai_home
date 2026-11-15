package codexstatepage

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf16"
)

var objectivePattern = regexp.MustCompile(`(?is)<objective>\s*(.*?)\s*</objective>`)

type titleResolver struct {
	home          string
	loaded        bool
	index         map[string]string
	lookups       int
	scanned       int64
	maxBytes      int64
	fallback      map[string]string
	fallbackBytes int
	unsupported   bool
}

func sanitizeTitle(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	for _, prefix := range []string{"# AGENTS.md instructions", "<codex_internal_context", "<environment_context", "<turn_aborted", "<user_instructions", "<user_shell_command", "Caveat:", "<command-name>", "<local-command"} {
		if strings.HasPrefix(value, prefix) {
			return ""
		}
	}
	if strings.Contains(value, "<INSTRUCTIONS>") {
		return ""
	}
	units := utf16.Encode([]rune(value))
	if len(units) > 4000 {
		if units[3999] >= 0xd800 && units[3999] <= 0xdbff {
			return "\x00aih-title-surrogate-cut"
		}
		value = string(utf16.Decode(units[:4000]))
	}
	return value
}
func userTitle(value string) string {
	if m := objectivePattern.FindStringSubmatch(value); len(m) > 1 {
		if title := sanitizeTitle(m[1]); title != "" {
			return title
		}
	}
	return sanitizeTitle(value)
}
func titleLine(line []byte) string {
	if !bytes.Contains(line, []byte("user_message")) && !bytes.Contains(line, []byte(`"user"`)) && !bytes.Contains(line, []byte("thread_goal_updated")) {
		return ""
	}
	var record struct {
		Type    string `json:"type"`
		Payload struct {
			Type    string `json:"type"`
			Role    string `json:"role"`
			Message string `json:"message"`
			Goal    struct {
				Objective string `json:"objective"`
			} `json:"goal"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &record) != nil || (record.Type != "event_msg" && record.Type != "response_item") {
		return ""
	}
	p := record.Payload
	if p.Type == "user_message" {
		return userTitle(p.Message)
	}
	if p.Type == "thread_goal_updated" {
		return sanitizeTitle(p.Goal.Objective)
	}
	if p.Type == "message" && p.Role == "user" {
		var chunks []string
		for _, v := range p.Content {
			if (v.Type == "input_text" || v.Type == "text") && v.Text != "" {
				chunks = append(chunks, v.Text)
			}
		}
		return userTitle(strings.Join(chunks, " "))
	}
	return ""
}
func scanTitleLines(ctx context.Context, file *os.File, limit int64, visit func([]byte) bool) (string, int64, error) {
	reader := bufio.NewReaderSize(io.LimitReader(file, limit), 64<<10)
	var carry []byte
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return "", total, err
		}
		part, err := reader.ReadSlice('\n')
		total += int64(len(part))
		if len(carry)+len(part) > 8<<20 {
			return "", total, ErrBudget
		}
		if len(carry) > 0 || err == bufio.ErrBufferFull {
			carry = append(carry, part...)
		} else {
			carry = part
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if len(carry) > 0 && visit(carry) {
			return "found", total, nil
		}
		carry = nil
		if err != nil {
			if errors.Is(err, io.EOF) {
				return "", total, nil
			}
			return "", total, err
		}
	}
}
func (resolver *titleResolver) loadIndex(ctx context.Context) error {
	if resolver.loaded {
		return nil
	}
	resolver.loaded = true
	resolver.index = make(map[string]string)
	file, err := openTitleFile(filepath.Join(resolver.home, "session_index.jsonl"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return nil
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil
	}
	if info.Size() > 32<<20 {
		return ErrBudget
	}
	bytesKept := 0
	overflow := false
	_, _, err = scanTitleLines(ctx, file, info.Size(), func(raw []byte) bool {
		var value struct {
			ID   string `json:"id"`
			Name string `json:"thread_name"`
		}
		if json.Unmarshal(raw, &value) != nil {
			return false
		}
		id := strings.TrimSpace(value.ID)
		if id == "" || resolver.index[id] != "" {
			return false
		}
		name := sanitizeTitle(value.Name)
		if strings.ContainsRune(name, 0) {
			resolver.unsupported = true
			return true
		}
		if name != "" {
			bytesKept += len(id) + len(name)
			if len(resolver.index) >= maxCandidates || bytesKept > maxIdentityBytes {
				overflow = true
				return true
			}
			resolver.index[id] = name
		}
		return false
	})
	if overflow {
		return ErrBudget
	}
	if resolver.unsupported {
		return errors.New("codex_state_title_encoding_unsupported")
	}
	return err
}
func (resolver *titleResolver) resolve(ctx context.Context, row Row) (string, error) {
	initial := text(row["title"])
	if initial == "" {
		initial = text(row["first_user_message"])
	}
	if title := strings.TrimSpace(initial); title != "" {
		return title, nil
	}
	if err := resolver.loadIndex(ctx); err != nil {
		return "", err
	}
	if value := resolver.index[strings.TrimSpace(text(row["id"]))]; value != "" {
		return value, nil
	}
	path := strings.TrimSpace(text(row["rollout_path"]))
	if path == "" {
		return "", nil
	}
	key := strings.TrimSpace(text(row["id"])) + "\x00" + path
	if resolver.fallback != nil {
		if cached, ok := resolver.fallback[key]; ok {
			return cached, nil
		}
	}
	resolver.lookups++
	if resolver.lookups > 256 || resolver.scanned >= 256<<20 {
		return "", ErrBudget
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", nil
	}
	file, err := openTitleFile(path)
	if err != nil {
		return "", nil
	}
	defer file.Close()
	if actual, err := file.Stat(); err != nil || !actual.Mode().IsRegular() {
		return "", nil
	}
	limit := resolver.maxBytes
	if limit <= 0 {
		limit = 16 << 20
	}
	limit = max(1024, limit)
	if limit > 32<<20 || resolver.scanned+min(info.Size(), limit) > 256<<20 {
		return "", ErrBudget
	}
	var title string
	_, n, err := scanTitleLines(ctx, file, limit, func(line []byte) bool { title = titleLine(line); return title != "" })
	resolver.scanned += n
	if strings.ContainsRune(title, 0) {
		return "", errors.New("codex_state_title_encoding_unsupported")
	}
	if err == nil {
		if resolver.fallback == nil {
			resolver.fallback = make(map[string]string)
		}
		resolver.fallbackBytes += len(key) + len(title)
		if resolver.fallbackBytes > maxIdentityBytes {
			return "", ErrBudget
		}
		resolver.fallback[key] = title
	}
	return title, err
}
