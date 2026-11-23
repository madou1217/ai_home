package clientkeystats

import (
	"context"
	"strings"
)

// RemoteSessionHeader is the request header that carries the remote execution
// session id from a provider CLI to the inference gateway.
const RemoteSessionHeader = "x-aih-remote-session"

type remoteSessionContextKey struct{}

// WithRemoteSession attaches the remote execution session id to a request
// context. The inference relay reads it from x-aih-remote-session.
func WithRemoteSession(ctx context.Context, sessionID string) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return ctx
	}
	return context.WithValue(ctx, remoteSessionContextKey{}, sessionID)
}

// RemoteSessionFromContext returns the session id, or "" when the request is
// not part of a remote execution.
func RemoteSessionFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	value, _ := ctx.Value(remoteSessionContextKey{}).(string)
	return strings.TrimSpace(value)
}
