// Package accountbrowsernative contains only source assets for the native
// single-window surface helper; it embeds no browser engine or credentials.
package accountbrowsernative

import "embed"

//go:embed main.swift capture.swift input.swift output.swift
var Sources embed.FS
