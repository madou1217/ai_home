# AIH Translation browser extension

Load this directory as an unpacked Manifest V3 extension in Chromium or install the packaged extension when distribution packaging is added. The extension adds context-menu actions for the current selection and the current page, bounded page translation (three concurrent segments), side-by-side annotations, and undo.

Configure the AIH Server origin and target language from the extension action. The server remains the source of truth for language confirmation, provider descriptors, ordered routes, and fallback. A management key is optional only when the configured server accepts the request through an authenticated browser session; if a key is entered it stays in local extension storage (it is never synced to other browser devices) and is sent only in the Authorization header.
