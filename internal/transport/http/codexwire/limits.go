package codexwire

// MaxRequestBytes matches the other inference ingress paths and the Node Codex
// decoder. Long sessions include encrypted reasoning that is removed only after
// decoding; a smaller ingress limit rejects otherwise valid, resumable history.
// Keep both the wire body and its decompressed representation bounded.
const MaxRequestBytes int64 = 32 * 1024 * 1024
