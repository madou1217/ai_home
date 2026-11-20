// Package accountbrowser provides the Stage 1 engine-agnostic runtime foundation
// for durable, per-account isolated browser profile registries and private data
// directories.
//
// Scope and non-goals for Stage 1:
//   - Manages stable (serverId, provider, accountRef) identity validation,
//     deterministic opaque profile IDs, private rooted metadata/data storage
//     under <AIHomeDir>/run/account-browser/profiles, and delegation to an
//     optional attached Host.
//   - Does NOT select a specific browser engine (nor choose WebView or relax
//     normal-browser requirements); Electron is forbidden across all stages.
//   - Does NOT launch browser processes, allocate renderers, open windows,
//     create server identity records, or claim persisted open/OAuth/website
//     login restoration.
//   - Persistence in Stage 1 covers profile registry metadata and private data
//     directories only; it never stores credentials, cookies, tokens, or
//     passwords, and never exposes host filesystem paths in exported Profile
//     values.
package accountbrowser
