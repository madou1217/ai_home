// Package workspacepath owns the remote path-resolution scripts used by Go and
// Node. Keeping the wire framing and path policy here avoids dialect drift.
package workspacepath

import _ "embed"

//go:embed resolve-posix.sh
var POSIX string

//go:embed resolve-powershell.ps1
var PowerShell string

//go:embed search-posix.sh
var SearchPOSIX string

//go:embed search-powershell.ps1
var SearchPowerShell string
