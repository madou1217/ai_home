package codexappserverapi

// Bounded native stdout/stderr line reading is owned by the transport-neutral
// codexappserverws bridge. The WebSocket adapter delegates instead of keeping a
// second reader with potentially different limits or final-frame semantics.
