# API Playground Audit

Date: 2026-04-09

## Documented WebSocket Coverage

Repo documentation and inline flow docs describe these core ENGAGE WebSocket behaviors:

- Automatic `EngageEventSubscription` after gateway connection
- `GET /edgeDevices/linkList`
- `GET /edgeDevices/lockStatus`
- `PUT /edgeDevices/{linkId}/lockControl`
- `PUT /edgeDevices/{linkId}/database`
- Async gateway / edge-device events

Additional repo code also implements:

- `GET /edgeDevices/{linkId}/params`
- `PUT /edgeDevices/{linkId}/config`
- `GET /edgeDevices/{linkId}/dbDownloadStatus`
- `DELETE /edgeDevices/{linkId}/database`

## Implementation Status

Implemented end to end:

- Subscription handshake is sent automatically by the server during WebSocket setup.
- All request paths listed above are routable through the generic Playground proxy.
- Dashboard SSE relays normalized event data for `engage:event`, `access:event`, `lock:result`, `database:status`, gateway connect/disconnect, and reconnection updates.

Partially implemented or not exposed directly:

- Subscription management is implemented but not exposed as a manual Playground action.
- Database helper generation fully understands `usrRcrd` and `schedules`, but optional sections such as `firstPersonIn` are not validated by backend helpers yet.
- Playground events display the app's normalized SSE contract, not the raw gateway event frame.

## Contract Inconsistencies Found

- Event examples in repo docs are inconsistent:
  - `README/GATEWAY_SETUP.md` shows numeric `eventType`
  - implementation commonly treats audit events as 8-character hex strings
  - other docs include more generic string-style event examples
- `README/ENGAGE_FLOW.md` mentions `doNotDisturb` as a lock-control value, while the original UI/backend only allowed `secure`, `passage`, and `momentaryUnlock`.
- Database option coverage in docs is thinner than the payload surface the Playground can forward, so some advanced fields can only be exposed as editable examples today.

## UI Changes Driven By Audit

- Added guided lock-control modes for `secure`, `passage`, `momentaryUnlock`, `frozenSecure`, and `frozenPassage`
- Added a guided reader/audit config builder that maps user-friendly choices to `T` / `F`
- Added a structured database helper panel with editable example sections and field guide content
