// Package accountbrowsernative contains only source assets for the native
// single-window surface helper; it embeds no browser engine or credentials.
package accountbrowsernative

import "embed"

//go:embed main.swift capture.swift input.swift output.swift identity.swift mouse-events.swift windows/BrowserSurface.csproj windows/Program.cs
var Sources embed.FS
