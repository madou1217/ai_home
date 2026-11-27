//go:build windows

package providersessionhook

// invokingHarness 在 Windows 上无法廉价读取祖先进程，返回空表示不限制。
func invokingHarness() string { return "" }
