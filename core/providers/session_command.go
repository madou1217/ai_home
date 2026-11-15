package providers

import (
	"fmt"
	"strings"
)

const SessionIdentityPlaceholder = "{sessionId}"

func validateSessionCommands(sessions NativeSessions) error {
	flags := make(map[string]bool, len(sessions.Flags))
	for _, flag := range sessions.Flags {
		flags[flag] = true
	}
	for name, command := range map[string]*NativeSessionCommand{"resume": sessions.Resume, "fork": sessions.Fork} {
		if command == nil {
			continue
		}
		if len(command.WithID) == 0 {
			return fmt.Errorf("sessions.%s.withId must declare an identity form", name)
		}
		for _, shape := range []struct {
			args  []string
			slots int
		}{{command.WithID, 1}, {command.WithoutID, 0}} {
			slots := 0
			for index, arg := range shape.args {
				if arg == SessionIdentityPlaceholder {
					slots++
					continue
				}
				if strings.TrimSpace(arg) != arg || arg == "" || strings.ContainsAny(arg, "\x00\r\n") {
					return fmt.Errorf("sessions.%s contains invalid argv", name)
				}
				if (index == 0 || strings.HasPrefix(arg, "-")) && !flags[arg] {
					return fmt.Errorf("sessions.%s references undeclared flag %q", name, arg)
				}
			}
			if slots != shape.slots {
				return fmt.Errorf("sessions.%s identity placeholder count invalid", name)
			}
		}
	}
	return nil
}
