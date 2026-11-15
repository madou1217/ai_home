package providerlaunch

import (
	"errors"
	"strings"
	"unicode"

	"github.com/madou1217/ai_home/core/providers"
)

var (
	ErrSessionVerbUnsupported  = errors.New("native session verb unsupported")
	ErrSessionIdentityRequired = errors.New("native session identity required")
	ErrSessionIdentityInvalid  = errors.New("native session identity invalid")
)

// BuildSessionVerb delegates wire argv to the shared provider contract. It does
// not look up accounts, spawn clients, or infer support from unrelated flags.
func BuildSessionVerb(sessions providers.NativeSessions, verb, identity string, extra []string) ([]string, error) {
	identity = strings.TrimSpace(identity)
	var command *providers.NativeSessionCommand
	switch verb {
	case "resume":
		command = sessions.Resume
	case "fork":
		command = sessions.Fork
	}
	if command == nil {
		return nil, ErrSessionVerbUnsupported
	}
	if strings.IndexFunc(identity, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 || strings.HasPrefix(identity, "-") {
		return nil, ErrSessionIdentityInvalid
	}
	template := command.WithID
	if identity == "" {
		template = command.WithoutID
	}
	if len(template) == 0 {
		return nil, ErrSessionIdentityRequired
	}
	args := make([]string, 0, len(template)+len(extra))
	for _, value := range template {
		if value == providers.SessionIdentityPlaceholder {
			value = identity
		}
		args = append(args, value)
	}
	return append(args, extra...), nil
}
