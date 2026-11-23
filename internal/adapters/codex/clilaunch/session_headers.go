package clilaunch

import "fmt"

// RemoteSessionEnv carries the remote execution session id into the provider
// process; RemoteSessionHeader is the request header Codex sends to the AIH
// gateway so usage can be attributed to that session.
const (
	RemoteSessionEnv    = "AIH_REMOTE_SESSION_ID"
	RemoteSessionHeader = "x-aih-remote-session"
)

// RemoteSessionArguments maps the env var onto the managed provider's
// env_http_headers. Codex resolves the header value from the environment at
// request time, so every request of one session carries the same id.
func RemoteSessionArguments() []string {
	return []string{
		"-c",
		fmt.Sprintf("model_providers.%s.env_http_headers.%s=%s", ManagedProviderKey, RemoteSessionHeader, RemoteSessionEnv),
	}
}
