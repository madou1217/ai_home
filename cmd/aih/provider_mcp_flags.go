package main

// stripNoMCPFlag removes --no-mcp before the provider separator and reports
// whether it was present. Arguments after -- belong to the provider and are
// never interpreted by aih.
func stripNoMCPFlag(args []string) ([]string, bool) {
	out := make([]string, 0, len(args))
	disabled := false
	for index := 0; index < len(args); index++ {
		if args[index] == "--" {
			out = append(out, args[index:]...)
			break
		}
		if args[index] == "--no-mcp" {
			disabled = true
			continue
		}
		out = append(out, args[index])
	}
	return out, disabled
}
