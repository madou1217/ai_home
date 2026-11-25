// Package sessionownership 持久化「原生 CLI 会话 → 账号」归属。
//
// Provider hook 在原生直连会话里携带 accountRef（WebUI / CLI 启动时注入的
// AIH_PROVIDER_ACCOUNT_REF），但会话 token 只写在本地 transcript 里，网关账本看不到。
// 把归属落成 run/provider-session-owners/ 下的小文件后，用量扫描器就能把该会话的
// token 记到账号名下，账号卡片不再显示 0。
//
// 网关会话（Anthropic/OpenAI base URL 指向本机 Server）不参与归属：它的用量已经由
// 网关账本按账号记录，按会话再记一次会重复计算。hook sender 用 gateway 字段区分。
package sessionownership

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const dirName = "provider-session-owners"

var (
	accountRefPattern = regexp.MustCompile(`^acct_[a-f0-9]{20}$`)
	sessionIDPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`)
)

// Record 是一个会话归属文件的内容。
type Record struct {
	Provider   string `json:"provider"`
	SessionID  string `json:"sessionId"`
	AccountRef string `json:"accountRef"`
	Gateway    bool   `json:"gateway"`
	UpdatedAt  int64  `json:"updatedAt"`
}

// Dir 返回归属文件目录。
func Dir(aiHomeDir string) string {
	return filepath.Join(strings.TrimSpace(aiHomeDir), "run", dirName)
}

// Write 原子写入（或更新）一个会话归属。参数无效时返回错误，由调用方决定是否忽略。
func Write(
	aiHomeDir, provider, sessionID, accountRef string,
	gateway bool,
	at time.Time,
) error {
	home := strings.TrimSpace(aiHomeDir)
	prov := strings.ToLower(strings.TrimSpace(provider))
	session := strings.TrimSpace(sessionID)
	ref := strings.TrimSpace(accountRef)
	if home == "" || prov == "" || !sessionIDPattern.MatchString(session) || !accountRefPattern.MatchString(ref) {
		return errors.New("session_ownership_invalid")
	}
	if at.IsZero() {
		at = time.Now()
	}
	dir := Dir(home)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(Record{
		Provider:   prov,
		SessionID:  session,
		AccountRef: ref,
		Gateway:    gateway,
		UpdatedAt:  at.UnixMilli(),
	}, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".owner-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(raw, '\n')); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, filepath.Join(dir, prov+"-"+session+".json")); err != nil {
		return err
	}
	cleanup = false
	return nil
}

// LoadNative 返回指定 Provider 的「原生（非网关）会话 → accountRef」映射。
//
// 只返回 gateway=false 的记录：网关会话用量由 usage_ledger 记账，扫描器不能再按
// 会话归一次。损坏或无效文件被跳过，不影响其他会话。
func LoadNative(aiHomeDir, provider string) map[string]string {
	home := strings.TrimSpace(aiHomeDir)
	prov := strings.ToLower(strings.TrimSpace(provider))
	if home == "" || prov == "" {
		return nil
	}
	entries, err := os.ReadDir(Dir(home))
	if err != nil {
		return nil
	}
	owners := make(map[string]string)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(Dir(home), entry.Name()))
		if err != nil {
			continue
		}
		var record Record
		if json.Unmarshal(raw, &record) != nil {
			continue
		}
		if strings.ToLower(strings.TrimSpace(record.Provider)) != prov || record.Gateway {
			continue
		}
		session := strings.TrimSpace(record.SessionID)
		ref := strings.TrimSpace(record.AccountRef)
		if !sessionIDPattern.MatchString(session) || !accountRefPattern.MatchString(ref) {
			continue
		}
		owners[session] = ref
	}
	if len(owners) == 0 {
		return nil
	}
	return owners
}

// LoadAll 读取全部归属（按 Provider 分组），供需要全量对账的调用方使用。
func LoadAll(aiHomeDir string) map[string]map[string]string {
	home := strings.TrimSpace(aiHomeDir)
	if home == "" {
		return nil
	}
	entries, err := os.ReadDir(Dir(home))
	if err != nil {
		return nil
	}
	out := make(map[string]map[string]string)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(Dir(home), entry.Name()))
		if err != nil {
			continue
		}
		var record Record
		if json.Unmarshal(raw, &record) != nil {
			continue
		}
		prov := strings.ToLower(strings.TrimSpace(record.Provider))
		session := strings.TrimSpace(record.SessionID)
		ref := strings.TrimSpace(record.AccountRef)
		if prov == "" || record.Gateway || !sessionIDPattern.MatchString(session) || !accountRefPattern.MatchString(ref) {
			continue
		}
		if out[prov] == nil {
			out[prov] = make(map[string]string)
		}
		out[prov][session] = ref
	}
	return out
}

// FileName 返回某会话归属文件的绝对路径（供诊断/清理使用）。
func FileName(aiHomeDir, provider, sessionID string) string {
	return filepath.Join(Dir(aiHomeDir), fmt.Sprintf("%s-%s.json", strings.ToLower(strings.TrimSpace(provider)), strings.TrimSpace(sessionID)))
}
