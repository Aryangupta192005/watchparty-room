# WatchParty Room

A small full-stack watch-party starter: invite-by-link rooms, synchronized playback, shared file uploads/downloads, participant list, and live chat.

## What works in this starter

- Create a room and copy a shareable `/room/ROOMCODE` link.
- Anyone with the link can join with a display name; no account is required.
- Upload video/audio files so they become the room's shared selection, or upload other files for room members to download.
- Play/pause/seek updates are broadcast live. Clients periodically correct playback drift.
- Real-time chat and presence list.
- Responsive layout for desktop and mobile.

## Run locally

1. Install Node.js 20 or later.
2. Open a terminal in this folder.
3. Run:

   ```bash
   npm install
   npm start
   ```

4. Open <http://localhost:3000>.
5. To test multiple viewers, open the same room link in a second browser or an incognito window and choose another display name.

For development with Node's watch mode, use `npm run dev`.

## Deploy so people can join from anywhere

Deploy this Node app to a host that supports persistent WebSocket connections and a persistent disk, then share the public HTTPS room link. Configure `PORT` from the host if required. `MAX_FILE_BYTES` can optionally change the per-file limit in bytes; the default is 1 GiB.

**Important hosting note:** this MVP stores room state in server memory and uploaded files in `./uploads`. On a server restart, room membership/chat/state will reset, and any host with an ephemeral filesystem may lose uploaded files. Use persistent storage (or an object store such as S3-compatible storage) before relying on it for long-lived rooms or large video files.

## Known limitations / production hardening

- Internet playback can be closely synchronized, not mathematically frame-perfect; latency, buffering, device clocks, and different decoders vary. This implementation shares the same selection and play/pause/seek state and periodically corrects drift.
- Browser autoplay policies may require each viewer to press Play once before remote playback can start with sound.
- The upload route is open to anyone who has the room code. Add authentication, per-room authorization, upload quotas, malware/content scanning, rate limits, and automatic file expiry before making a public production service.
- Room and chat state is in memory; use Redis or a database to scale across multiple server instances and persist the state. For large uploads, use resumable uploads and object storage/CDN delivery.
- File extension and MIME labels are supplied by browsers and are not proof of content. Treat shared files as untrusted; keep upload scanning and safe download headers in production.
- The app shares user-provided files only. It does not bypass DRM or streaming-service access controls.

## Main files

- `server.js` — Express, Socket.IO rooms, upload/download endpoints, sync broadcasts.
- `public/index.html` — home and room markup.
- `public/styles.css` — responsive visual design.
- `public/app.js` — room navigation, live chat, uploads, and playback correction.
