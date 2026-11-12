# Management Key durability and QR onboarding design

## Problem

The WebUI has recently shown an offline or unauthorized state because the
server-side Management Key was temporarily written and later cleared during a
diagnostic flow. A separate WebUI edit path also treated an empty password
field as a replacement value, which could invalidate an existing saved Server
profile. A phone can reach the WebUI, but manually typing a long Management Key
is error-prone.

The current runtime evidence is that the local server has a configured
Management Key, the active browser profile has the same credential, and an
authenticated management status request returns HTTP 200. The remaining work
is to make accidental clearing impossible and provide an explicit QR handoff
for trusted setup.

## Goals

- Preserve an existing non-empty Management Key when a normal update omits it
  or supplies an empty form value.
- Keep key clearing available only as an explicit, confirmed operator action.
- Add `aih server config show --show-secrets --qr` and the equivalent `get`
  form for a terminal-rendered QR code.
- Encode the Server URL and Management Key together in a versioned payload so
  the phone can fill both setup fields.
- Let desktop and mobile Server Setup scan the QR code through the browser
  camera, validate the payload locally, and submit it through the existing
  profile connection flow.
- Keep credentials out of URLs, logs, process arguments, and browser DOM
  attributes. The QR display itself is the intentional secret disclosure.

## Non-goals

- Do not introduce a new pairing token, device identity, scope system, or
  alternate server authentication scheme.
- Do not rotate the key as part of QR display or scanning.
- Do not remove the existing manual input path.
- Do not add a new `AIH_*` environment variable.

## Design

### Durable key mutation boundary

`lib/server/server-config-store.js` remains the single persistence boundary for
`config:server`. Normal patches preserve a configured key when the incoming
patch omits the field or contains an empty string. The CLI parser carries an
explicit clear intent only for `--clear-management-key`; the command requires
`--confirm-clear-management-key` before passing that intent to the writer.
Generic WebUI configuration updates and profile synchronization never receive
the clear intent. Management-key rotation continues to require the current
credential and a non-empty replacement.

The WebUI connection layer keeps the already-fixed semantics that an empty
Management Key input means “leave unchanged” for an existing profile. Failed
authorization marks the profile as degraded or redirects to setup without
deleting the saved credential. The QR payload uses the same 32–4096 character
credential bound as WebUI profile storage and browser transport; it rejects
CR/LF/NUL while allowing other printable key characters.

### QR payload and CLI rendering

The CLI assembles a short JSON payload:

```json
{"v":1,"type":"aih-server-credentials","endpoint":"http://…:9527","managementKey":"…"}
```

`--qr` requires `--show-secrets`, reads the persisted server configuration, and
renders the payload with a package-free QR encoder in a focused CLI module.
The terminal renderer uses a white background and high-contrast block cells,
with a quiet-zone margin and no raw key text in QR mode. Without `--qr`, the
existing `--show-secrets` output remains unchanged. Invalid or missing keys
produce an actionable error and no QR output.

### Browser scanner

Desktop and mobile Server Setup share a controlled scanner component. It opens
only after an explicit button press, requests camera permission, decodes the
QR payload, validates `v`, `type`, an HTTP(S) endpoint, and the existing
Management Key length/character contract, then writes the endpoint and key into
the active form. It stops the camera on success, cancel, unmount, and errors.
Unsupported camera/decoder environments retain the manual form and show an
inline explanation; no credential is persisted until the normal Save/Connect
submit succeeds.

## Error handling

- An unconfirmed clear command exits non-zero, explains the required
  confirmation flag, and leaves the stored key untouched.
- A QR command without `--show-secrets` exits non-zero without reading or
  printing secret material.
- Malformed, wrong-type, unsupported-version, invalid-endpoint, or invalid-key
  payloads are rejected locally and leave form values unchanged.
- Camera permission denial and decoder unavailability are shown as compact
  inline status text; manual entry remains available.
- A failed Server request never clears the previous profile key.

## Verification

- Run existing focused Node tests covering server-config parsing/store,
  control-plane profile connection, and profile merge behavior.
- Run the real CLI parser/output commands with temporary injected readers and
  confirm unconfirmed clears do not write while confirmed clears do.
- Run `cd web && npm run lint` for modified frontend files and `npm run build`.
- Against the running local server, verify authenticated management status,
  empty edit submission preservation, and successful non-empty rotation.
- Inspect the rendered QR payload through the decoder path without printing the
  raw credential in logs or command diagnostics.

## Pattern review

- **Single mutation boundary:** server config store owns persistence and the
  clear-intent guard, preventing callers from inventing alternate semantics.
- **Strategy/facade boundary:** QR encoding and terminal rendering are isolated
  from command parsing; the shared scanner is isolated from form state.
- **KISS/YAGNI:** the payload is versioned JSON over the existing credential;
  no new pairing service or persistent device registry is introduced.
