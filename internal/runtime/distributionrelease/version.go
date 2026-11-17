package distributionrelease

import (
	"fmt"
	"regexp"
	"strings"
)

var semverPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$`)

type version struct {
	text       string
	core       [3]string
	prerelease string
}

func parseVersion(text string, allowV bool) (version, error) {
	if allowV {
		text = strings.TrimPrefix(text, "v")
	}
	if len(text) > 128 {
		return version{}, fmt.Errorf("semver exceeds length limit")
	}
	parts := semverPattern.FindStringSubmatch(text)
	if parts == nil {
		return version{}, fmt.Errorf("expected strict major.minor.patch semver")
	}
	for _, identifier := range strings.Split(parts[4], ".") {
		if len(identifier) > 1 && identifier[0] == '0' && numericIdentifier(identifier) {
			return version{}, fmt.Errorf("numeric prerelease identifier has a leading zero")
		}
	}
	return version{text: text, core: [3]string{parts[1], parts[2], parts[3]}, prerelease: parts[4]}, nil
}

func numericIdentifier(text string) bool {
	for _, c := range text {
		if c < '0' || c > '9' {
			return false
		}
	}
	return text != ""
}

// Compare arbitrary-length semver numeric components without integer overflow.
// Build metadata is ignored. A stable version supersedes its own prerelease;
// a prerelease never supersedes a stable version. Major upgrades are allowed.
func newerStable(candidate, current version) bool {
	if candidate.prerelease != "" {
		return false
	}
	for i, component := range candidate.core {
		other := current.core[i]
		if len(component) != len(other) {
			return len(component) > len(other)
		}
		if component != other {
			return component > other
		}
	}
	return current.prerelease != ""
}
