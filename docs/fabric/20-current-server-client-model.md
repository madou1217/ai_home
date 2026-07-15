# Fabric Current Server/Client Model

> Status: canonical current design. This document and the repository root `README.md` override Fabric documents 00-19, which are retained as historical design and evidence records.

## Product concepts

- **Server** runs the AIH gateway and management APIs and owns accounts, sessions, models, SSH connections, and optional worker state.
- **Client** means the Browser/installable Web shell, CLI, or Tauri-based macOS/Windows/Linux native desktop application that connects to a Server.
- **SSH development machine** is a Server-managed SSH target and workspace source. It is not a client identity.
- **Worker** is an advanced internal execution target. A normal client does not need to create or join a worker before connecting to a Server.

## Client authentication contract

Every non-loopback client uses exactly:

```text
Server URL
Authorization: Bearer <Management Key>
```

Management Key is the only client credential. A legacy Server Profile is rewritten to the canonical schema on read; obsolete client authorization data is discarded and is never accepted as a Management Key fallback.

Management Key has full administrative authority and is shared by every trusted client. An authenticated client may rotate it from Server Management and update its own saved credential in the same operation; every other trusted client must then update its locally saved key. The Server CLI remains an alternative rotation entry point. This does not introduce pairing, device tokens, or permission scopes. Expose a remote Server only through HTTPS, VPN, or a controlled tunnel.

Loopback requests may use the local trust boundary when no Management Key is configured. A non-loopback management request fails closed when the Server has no Management Key.

## Worker join boundary

The one-time worker join invite remains because it bootstraps a machine into the advanced worker topology. It is not client authorization and does not create a client identity. After join, worker-to-Server operations use the explicit Management Key contract; legacy credential aliases are not accepted.

## Client implementations

- Browser/installable Web uses the shared React UI and TypeScript API client. JSON, SSE, media, and attachment requests send the Management Key only in the Authorization header; it is not placed in URLs. There is no offline service worker today.
- When Server A hosts the WebUI for a profile targeting Server B, Server A stores B's Management Key and acts as the trusted credential proxy. An untrusted Server must not host that browser session.
- CLI uses `aih server add/ls/use/remove` and never prints the raw key in normal list or diagnostic output.
- Tauri native desktop reuses the shared React UI. Rust owns Server Profiles, system Keyring access, JSON/SSE/Blob requests, and the native stream bridge. The Management Key remains in macOS Keychain, Windows Credential Manager, or Linux Secret Service; React receives only `credentialRef` and `managementKeyConfigured` metadata. Remote endpoints require HTTPS, while HTTP is allowed only for loopback.
- The repository contains macOS, Windows, and Linux package-and-smoke workflows. A platform is release-validated only after its real packaged application passes install, launch, Keyring, JSON, SSE, and Blob smoke and produces complete evidence; this document does not claim unverified packages as delivered.

## Canonical profile schema

```text
id
name
endpoint
managementKey (browser/CLI store) or credentialRef + managementKeyConfigured (native desktop metadata)
state: ready | degraded | offline
```

The canonical schema contains no alternate client credential, client identity, or per-client authorization state.
