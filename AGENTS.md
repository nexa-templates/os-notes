# Notes template

Keep this a simple Markdown notebook. Preserve functional editing, persistence, sharing, import/export, and conflict recovery when adapting it.

- `web/` is the frontend; `src/worker.js` is the Cloudflare Worker and SQLite Durable Object. `scripts/build.mjs` bundles local dependencies into `dist/`.
- Run `npm ci`, `npm test`, and `npm run build` before publishing changes. Browser tests require Chromium; see README. Use isolated notebooks and delete only test-created data.
- Deploy a new Worker with its own Durable Object storage in the customer's account. Rename the Worker; preserve the binding and migration. Never reuse the public demo's API/storage or copy customer data or credentials into this public repository.
- Production access requires a verified Cloudflare Access login and revocable notebook capability links. Enforce roles on the server, store only token hashes, keep tokens out of request paths/query strings/logs, and keep the no-referrer and no-store headers.
- Never silently overwrite a concurrent edit. Use note versions, preserve local drafts on failures, and require explicit conflict resolution.
- Render Markdown through DOMPurify with restricted tags/attributes. No external images, scripts, or analytics. Keep keyboard access and mobile layouts usable.
- `web/rich-editor.js` owns the Tiptap formatted editor and Markdown conversion. Preserve raw source when switching views without edits. Route unsupported Markdown to source mode rather than dropping content, isolate undo history per note, sanitize pasted HTML, and test both rich and source edits through sharing/conflict recovery.
- Keep the upstream Git remote/history so future template fixes can be merged. Document changes to storage and access semantics.

This standalone version uses Cloudflare Access. Production must fail closed without its issuer, audience and application origin. Local sample tests run with PREVIEW_MODE=true; signed-token tests cover the production gate. Never enable preview mode for customer data or live email.
