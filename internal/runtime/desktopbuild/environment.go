package desktopbuild

import (
	"os"
	"strings"
)

func launchEnvironment(platform string) []string {
	keys := []string{"HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "__CF_USER_TEXT_ENCODING"}
	if platform == "win32" {
		keys = []string{"USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "LANG", "LC_ALL", "SystemRoot", "WINDIR", "ComSpec"}
	}
	var result []string
	for _, key := range keys {
		if value, ok := os.LookupEnv(key); ok && value != "" {
			result = append(result, key+"="+value)
		}
	}
	return result
}

func setEnvironment(base []string, key, value string) []string {
	result := make([]string, 0, len(base)+1)
	for _, entry := range base {
		name, _, _ := strings.Cut(entry, "=")
		if !strings.EqualFold(name, key) {
			result = append(result, entry)
		}
	}
	return append(result, key+"="+value)
}
