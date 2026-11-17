package providercli

const (
	CodeCodexManagedRuntimeInvalid = "codex_managed_runtime_invalid"
	CodeCodexOfficialCLIMissing    = "codex_official_cli_missing"
	CodeCodexBinaryOverrideInvalid = "codex_binary_override_invalid"
	CodeCodexHookUntrusted         = "codex_hook_untrusted"
	CodeCodexHookCycle             = "codex_hook_cycle"
	CodeCodexHookDepthExceeded     = "codex_hook_depth_exceeded"
)

// CodexBinaryError keeps availability separate from unsafe or explicit selections.
// Missing official CLI and invalid managed runtime have distinct recovery actions.
// Resolution never installs a CLI or replaces an existing wrapper.
type CodexBinaryError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Path    string `json:"path,omitempty"`
	Action  string `json:"action,omitempty"`
	cause   error
}

func (err *CodexBinaryError) Error() string {
	if err.Path != "" {
		return err.Message + " (" + err.Path + ")"
	}
	return err.Message
}

func (err *CodexBinaryError) Unwrap() error {
	return err.cause
}

func codexOfficialCLIMissing(legacyHookPath string) error {
	message := "Codex 尚未准备完成"
	if legacyHookPath != "" {
		message = "Codex 旧安装需要修复"
	}
	return &CodexBinaryError{
		Code:    CodeCodexOfficialCLIMissing,
		Message: message + "；请打开工具箱 → 应用管理 → Codex CLI，点击安装并修复（保留配置及旧版本）",
		Path:    legacyHookPath,
		Action:  "install_official_cli",
		cause:   ErrProviderBinaryNotFound,
	}
}

func codexHookError(code, path, message string, cause error) error {
	return &CodexBinaryError{
		Code: code, Message: message, Path: path, Action: "repair_codex_hook", cause: cause,
	}
}
