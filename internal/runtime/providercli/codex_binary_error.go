package providercli

const (
	CodeCodexOfficialCLIMissing    = "codex_official_cli_missing"
	CodeCodexBinaryOverrideInvalid = "codex_binary_override_invalid"
	CodeCodexHookUntrusted         = "codex_hook_untrusted"
	CodeCodexHookCycle             = "codex_hook_cycle"
	CodeCodexHookDepthExceeded     = "codex_hook_depth_exceeded"
)

// CodexBinaryError keeps availability separate from unsafe or explicit selections.
// Only codex_official_cli_missing offers install_official_cli to installer/UI callers.
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
	message := "未找到可用的官方 Codex CLI"
	if legacyHookPath != "" {
		message = "检测到旧 Codex Node hook，但没有可用的官方上游 CLI"
	}
	return &CodexBinaryError{
		Code:    CodeCodexOfficialCLIMissing,
		Message: message + "；请通过官方 CLI 安装入口安装（保留现有 wrapper）",
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
