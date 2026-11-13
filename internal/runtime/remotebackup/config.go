// Package remotebackup 实现与 Node 兼容的远程账号增量备份：
// 配置文件 <aiHomeDir>/backup/{config,state}.json、aih-accounts v1 导出、
// 基于内容哈希的 manifest、SFTP v3 原子写入与去抖单飞调度器。
package remotebackup

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const (
	BackupConfigVersion    = 1
	BackupStateVersion     = 1
	BackupDirName          = "backup"
	BackupConfigFileName   = "config.json"
	BackupStateFileName    = "state.json"
	DefaultIntervalMinutes = 360
	DefaultDebounceSeconds = 30
	DefaultRemoteDir       = "~/.aih-backup"
	DefaultStrategy        = "ssh"
	MinIntervalMinutes     = 1
	MaxIntervalMinutes     = 7 * 24 * 60
)

var (
	targetIDPattern     = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
	sshHostPattern      = regexp.MustCompile(`^[A-Za-z0-9._:\[\]-]+$`)
	sshUserPattern      = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
	passwordEnvPattern  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	sha256HexPattern    = regexp.MustCompile(`^[a-f0-9]{64}$`)
	slugInvalidPattern  = regexp.MustCompile(`[^a-z0-9._-]+`)
	slugTrimDashPattern = regexp.MustCompile(`^-+|-+$`)
)

// BackupTarget 描述一个远程 SSH/SFTP 备份目标。
// 配置内只存私钥路径或密码环境变量名，绝不持久化明文密码。
type BackupTarget struct {
	ID                 string `json:"id"`
	Strategy           string `json:"strategy"`
	Enabled            bool   `json:"enabled"`
	Host               string `json:"host"`
	Port               int    `json:"port"`
	Username           string `json:"username"`
	RemoteDir          string `json:"remoteDir"`
	IdentityFile       string `json:"identityFile"`
	PasswordEnv        string `json:"passwordEnv"`
	HostKeyFingerprint string `json:"hostKeyFingerprint"`
}

// BackupConfig 对应 <aiHomeDir>/backup/config.json。
type BackupConfig struct {
	Version         int            `json:"version"`
	Enabled         bool           `json:"enabled"`
	IntervalMinutes int            `json:"intervalMinutes"`
	DebounceSeconds int            `json:"debounceSeconds"`
	Targets         []BackupTarget `json:"targets"`
}

// TargetRunState 记录单个目标最近一次备份执行状态。
type TargetRunState struct {
	LastRunAt string `json:"lastRunAt,omitempty"`
	LastOkAt  string `json:"lastOkAt,omitempty"`
	LastError string `json:"lastError,omitempty"`
	Uploaded  int    `json:"uploaded"`
	Unchanged int    `json:"unchanged"`
	Deleted   int    `json:"deleted"`
	Revision  int    `json:"revision,omitempty"`
	Total     int    `json:"total,omitempty"`
}

// BackupState 对应 <aiHomeDir>/backup/state.json。
type BackupState struct {
	Version int                       `json:"version"`
	Targets map[string]TargetRunState `json:"targets"`
}

// ResolveBackupDir 返回 <aiHomeDir>/backup 目录路径。
func ResolveBackupDir(aiHomeDir string) (string, error) {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return "", errors.New("aiHomeDir is required")
	}
	return filepath.Join(filepath.Clean(root), BackupDirName), nil
}

// ResolveBackupConfigPath 返回 <aiHomeDir>/backup/config.json 路径。
func ResolveBackupConfigPath(aiHomeDir string) (string, error) {
	dir, err := ResolveBackupDir(aiHomeDir)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, BackupConfigFileName), nil
}

// ResolveBackupStatePath 返回 <aiHomeDir>/backup/state.json 路径。
func ResolveBackupStatePath(aiHomeDir string) (string, error) {
	dir, err := ResolveBackupDir(aiHomeDir)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, BackupStateFileName), nil
}

// DefaultBackupConfig 返回默认启用、6 小时间隔与 30 秒去抖的空目标配置。
func DefaultBackupConfig() BackupConfig {
	return BackupConfig{
		Version:         BackupConfigVersion,
		Enabled:         true,
		IntervalMinutes: DefaultIntervalMinutes,
		DebounceSeconds: DefaultDebounceSeconds,
		Targets:         []BackupTarget{},
	}
}

// DefaultBackupState 返回空目标状态集合。
func DefaultBackupState() BackupState {
	return BackupState{
		Version: BackupStateVersion,
		Targets: make(map[string]TargetRunState),
	}
}

type parsedSSHAddress struct {
	Host     string
	Port     int
	Username string
}

func parseSSHAddress(input string) (parsedSSHAddress, error) {
	text := strings.TrimSpace(input)
	if text == "" {
		return parsedSSHAddress{}, errors.New("缺少 SSH 目标（例如 ubuntu@1.2.3.4）")
	}
	username := ""
	if at := strings.LastIndex(text, "@"); at > 0 {
		username = strings.TrimSpace(text[:at])
		text = strings.TrimSpace(text[at+1:])
	}
	port := 22
	if strings.HasPrefix(text, "[") {
		if hostPart, portPart, splitErr := net.SplitHostPort(text); splitErr == nil {
			if !isAllDigits(portPart) || portPart == "" {
				return parsedSSHAddress{}, fmt.Errorf("SSH 端口不合法：%s", portPart)
			}
			p, convErr := strconv.Atoi(portPart)
			if convErr != nil {
				return parsedSSHAddress{}, fmt.Errorf("SSH 端口不合法：%s", portPart)
			}
			port = p
			text = hostPart
		} else if strings.HasSuffix(text, "]") {
			text = text[1 : len(text)-1]
		}
	} else if strings.Count(text, ":") == 1 {
		hostPart, portPart, _ := strings.Cut(text, ":")
		if isAllDigits(portPart) && portPart != "" {
			p, convErr := strconv.Atoi(portPart)
			if convErr == nil {
				port = p
				text = hostPart
			}
		}
	}
	if text == "" {
		return parsedSSHAddress{}, errors.New("SSH 目标缺少主机名")
	}
	if !sshHostPattern.MatchString(text) {
		return parsedSSHAddress{}, fmt.Errorf("SSH 主机名不合法：%s", text)
	}
	if strings.HasPrefix(text, "[") && strings.HasSuffix(text, "]") {
		text = text[1 : len(text)-1]
	}
	if username != "" && !sshUserPattern.MatchString(username) {
		return parsedSSHAddress{}, fmt.Errorf("SSH 用户名不合法：%s", username)
	}
	if port < 1 || port > 65535 {
		return parsedSSHAddress{}, fmt.Errorf("SSH 端口不合法：%d", port)
	}
	return parsedSSHAddress{Host: text, Port: port, Username: username}, nil
}

func normalizeRemoteDir(value string) (string, error) {
	remoteDir := strings.ReplaceAll(strings.TrimSpace(value), `\`, `/`)
	if remoteDir == "" {
		remoteDir = DefaultRemoteDir
	}
	if strings.ContainsRune(remoteDir, '\x00') {
		return "", errors.New("远程目录不合法")
	}
	for _, seg := range strings.Split(remoteDir, "/") {
		if seg == ".." {
			return "", errors.New("远程目录不能包含 ..")
		}
	}
	return remoteDir, nil
}

// TargetInput 是构建或规范化远程备份目标时的宽松输入（兼容 address/ssh/host 与 key）。
type TargetInput struct {
	ID                 string
	Name               string
	Strategy           string
	Enabled            *bool
	Address            string
	SSH                string
	Host               string
	Port               int
	Username           string
	RemoteDir          string
	IdentityFile       string
	Key                string
	PasswordEnv        string
	HostKeyFingerprint string
}

// NormalizeTarget 校验并规范化单条远程备份目标。
func NormalizeTarget(in TargetInput) (BackupTarget, error) {
	addrRaw := firstNonEmpty(in.Address, in.SSH, in.Host)
	addr, err := parseSSHAddress(addrRaw)
	if err != nil {
		return BackupTarget{}, err
	}
	username := firstNonEmpty(in.Username, addr.Username)
	if username == "" {
		return BackupTarget{}, errors.New("SSH 用户名不能为空（用 user@host 或 --user）")
	}
	port := in.Port
	if port == 0 {
		port = addr.Port
	}
	if port == 0 {
		port = 22
	}
	if port < 1 || port > 65535 {
		return BackupTarget{}, fmt.Errorf("SSH 端口不合法：%d", in.Port)
	}
	strategy := strings.ToLower(firstNonEmpty(in.Strategy, DefaultStrategy))
	if strategy != DefaultStrategy {
		return BackupTarget{}, fmt.Errorf("不支持的备份策略：%s（可用：ssh）", strategy)
	}
	id := firstNonEmpty(in.ID, in.Name)
	if id == "" {
		id = slugifyTarget(username + "-" + addr.Host)
	}
	if !targetIDPattern.MatchString(id) {
		return BackupTarget{}, fmt.Errorf("备份目标名不合法：%s", id)
	}
	remoteDir, err := normalizeRemoteDir(in.RemoteDir)
	if err != nil {
		return BackupTarget{}, err
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	passwordEnv := strings.TrimSpace(in.PasswordEnv)
	if passwordEnv != "" && !passwordEnvPattern.MatchString(passwordEnv) {
		return BackupTarget{}, fmt.Errorf("密码环境变量名不合法：%s", passwordEnv)
	}
	fp := strings.ToLower(strings.TrimSpace(in.HostKeyFingerprint))
	if fp != "" && !sha256HexPattern.MatchString(fp) {
		return BackupTarget{}, errors.New("hostKeyFingerprint 必须是 sha256 的 64 位十六进制")
	}
	return BackupTarget{
		ID:                 id,
		Strategy:           strategy,
		Enabled:            enabled,
		Host:               addr.Host,
		Port:               port,
		Username:           username,
		RemoteDir:          remoteDir,
		IdentityFile:       firstNonEmpty(in.IdentityFile, in.Key),
		PasswordEnv:        passwordEnv,
		HostKeyFingerprint: fp,
	}, nil
}

// rawTargetJSON 兼容读取 Node config.json（含缺省 enabled/strategy）。
type rawConfigJSON struct {
	Version         int               `json:"version"`
	Enabled         *bool             `json:"enabled"`
	IntervalMinutes *float64          `json:"intervalMinutes"`
	DebounceSeconds *float64          `json:"debounceSeconds"`
	Targets         []json.RawMessage `json:"targets"`
}

type rawTargetJSON struct {
	ID                 string `json:"id"`
	Name               string `json:"name"`
	Strategy           string `json:"strategy"`
	Enabled            *bool  `json:"enabled"`
	Address            string `json:"address"`
	SSH                string `json:"ssh"`
	Host               string `json:"host"`
	Port               int    `json:"port"`
	Username           string `json:"username"`
	RemoteDir          string `json:"remoteDir"`
	IdentityFile       string `json:"identityFile"`
	Key                string `json:"key"`
	PasswordEnv        string `json:"passwordEnv"`
	HostKeyFingerprint string `json:"hostKeyFingerprint"`
}

// NormalizeConfig 规范化配置；strict 为 false 时跳过损坏目标避免影响服务启动。
func NormalizeConfig(raw []byte, strict bool) (BackupConfig, error) {
	cfg := DefaultBackupConfig()
	if len(strings.TrimSpace(string(raw))) == 0 {
		return cfg, nil
	}
	var parsed rawConfigJSON
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return BackupConfig{}, err
	}
	if parsed.Enabled != nil {
		cfg.Enabled = *parsed.Enabled
	}
	if parsed.IntervalMinutes != nil && !math.IsNaN(*parsed.IntervalMinutes) && !math.IsInf(*parsed.IntervalMinutes, 0) {
		rounded := int(math.Round(*parsed.IntervalMinutes))
		if rounded < MinIntervalMinutes {
			rounded = MinIntervalMinutes
		} else if rounded > MaxIntervalMinutes {
			rounded = MaxIntervalMinutes
		}
		cfg.IntervalMinutes = rounded
	}
	if parsed.DebounceSeconds != nil && !math.IsNaN(*parsed.DebounceSeconds) && !math.IsInf(*parsed.DebounceSeconds, 0) {
		rounded := int(math.Round(*parsed.DebounceSeconds))
		if rounded < 0 {
			rounded = 0
		} else if rounded > 3600 {
			rounded = 3600
		}
		cfg.DebounceSeconds = rounded
	}
	seen := make(map[string]struct{}, len(parsed.Targets))
	for _, rawTarget := range parsed.Targets {
		var rt rawTargetJSON
		if err := json.Unmarshal(rawTarget, &rt); err != nil {
			if strict {
				return BackupConfig{}, err
			}
			continue
		}
		norm, err := NormalizeTarget(TargetInput{
			ID:                 rt.ID,
			Name:               rt.Name,
			Strategy:           rt.Strategy,
			Enabled:            rt.Enabled,
			Address:            rt.Address,
			SSH:                rt.SSH,
			Host:               rt.Host,
			Port:               rt.Port,
			Username:           rt.Username,
			RemoteDir:          rt.RemoteDir,
			IdentityFile:       rt.IdentityFile,
			Key:                rt.Key,
			PasswordEnv:        rt.PasswordEnv,
			HostKeyFingerprint: rt.HostKeyFingerprint,
		})
		if err != nil {
			if strict {
				return BackupConfig{}, err
			}
			continue
		}
		if _, dup := seen[norm.ID]; dup {
			if strict {
				return BackupConfig{}, fmt.Errorf("备份目标重复：%s", norm.ID)
			}
			continue
		}
		seen[norm.ID] = struct{}{}
		cfg.Targets = append(cfg.Targets, norm)
	}
	return cfg, nil
}

// ReadBackupConfig 读取并规范化 <aiHomeDir>/backup/config.json；文件不存在返回默认配置。
func ReadBackupConfig(aiHomeDir string) (BackupConfig, error) {
	file, err := ResolveBackupConfigPath(aiHomeDir)
	if err != nil {
		return BackupConfig{}, err
	}
	payload, err := os.ReadFile(file)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return DefaultBackupConfig(), nil
		}
		return BackupConfig{}, err
	}
	cfg, err := NormalizeConfig(payload, false)
	if err != nil {
		return BackupConfig{}, fmt.Errorf("备份配置不是合法 JSON：%s", file)
	}
	return cfg, nil
}

// WriteBackupConfig 严格校验并原子以 0600 权限写入 config.json。
func WriteBackupConfig(aiHomeDir string, cfg BackupConfig) (BackupConfig, error) {
	file, err := ResolveBackupConfigPath(aiHomeDir)
	if err != nil {
		return BackupConfig{}, err
	}
	encoded, err := json.Marshal(cfg)
	if err != nil {
		return BackupConfig{}, err
	}
	normalized, err := NormalizeConfig(encoded, true)
	if err != nil {
		return BackupConfig{}, err
	}
	out, err := json.MarshalIndent(normalized, "", "  ")
	if err != nil {
		return BackupConfig{}, err
	}
	out = append(out, '\n')
	if err := writePrivateFileAtomic(file, out); err != nil {
		return BackupConfig{}, err
	}
	return normalized, nil
}

// ReadBackupState 读取 <aiHomeDir>/backup/state.json；缺失或损坏时回退为空状态。
func ReadBackupState(aiHomeDir string) (BackupState, error) {
	file, err := ResolveBackupStatePath(aiHomeDir)
	if err != nil {
		return BackupState{}, err
	}
	payload, err := os.ReadFile(file)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return DefaultBackupState(), nil
		}
		return DefaultBackupState(), nil
	}
	var parsed struct {
		Version int                       `json:"version"`
		Targets map[string]TargetRunState `json:"targets"`
	}
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return DefaultBackupState(), nil
	}
	targets := parsed.Targets
	if targets == nil {
		targets = make(map[string]TargetRunState)
	}
	return BackupState{
		Version: BackupStateVersion,
		Targets: targets,
	}, nil
}

// WriteBackupState 原子以 0600 权限持久化 state.json。
func WriteBackupState(aiHomeDir string, state BackupState) (BackupState, error) {
	file, err := ResolveBackupStatePath(aiHomeDir)
	if err != nil {
		return BackupState{}, err
	}
	targets := state.Targets
	if targets == nil {
		targets = make(map[string]TargetRunState)
	}
	normalized := BackupState{
		Version: BackupStateVersion,
		Targets: targets,
	}
	out, err := json.MarshalIndent(normalized, "", "  ")
	if err != nil {
		return BackupState{}, err
	}
	out = append(out, '\n')
	if err := writePrivateFileAtomic(file, out); err != nil {
		return BackupState{}, err
	}
	return normalized, nil
}

func writePrivateFileAtomic(targetPath string, content []byte) error {
	dir := filepath.Dir(targetPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	var suffix [4]byte
	_, _ = rand.Read(suffix[:])
	tempPath := fmt.Sprintf("%s.tmp-%d-%s", targetPath, os.Getpid(), hex.EncodeToString(suffix[:]))
	file, err := os.OpenFile(tempPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(content)
	closeErr := file.Close()
	if writeErr != nil {
		_ = os.Remove(tempPath)
		return writeErr
	}
	if closeErr != nil {
		_ = os.Remove(tempPath)
		return closeErr
	}
	_ = os.Chmod(tempPath, 0o600)
	if err := os.Rename(tempPath, targetPath); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	_ = os.Chmod(targetPath, 0o600)
	return nil
}

func slugifyTarget(value string) string {
	lower := strings.ToLower(strings.TrimSpace(value))
	cleaned := slugInvalidPattern.ReplaceAllString(lower, "-")
	cleaned = slugTrimDashPattern.ReplaceAllString(cleaned, "")
	if cleaned == "" {
		return "target"
	}
	return cleaned
}

func isAllDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return len(s) > 0
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if trimmed := strings.TrimSpace(v); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
