// Package accountbrowserhost owns one task-private installed stable browser
// process on supported platforms. It is deliberately not an accountbrowser.Host:
// process survival alone cannot provide browser-in-browser frames or input.
//
// It never adopts an existing browser, accesses everyday browser profiles,
// installs an engine/extension, enables debugging or automation, or promises
// that third-party authentication/security policies will permit a login.
package accountbrowserhost
