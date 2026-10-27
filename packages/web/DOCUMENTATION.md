# Web browser assets

## Ownership

The web HTML entrypoints and Vite plugins own browser bootstrap documents. `public/` contains the brand generator's icon files. `scripts/web-icons.mjs` serializes them into the classic script emitted by `vite-web-icons.ts`. The manifest endpoint owns dynamic names, orientation and authorized recent-session shortcuts.

## Invariants

- Image bytes occur only in the content-hashed `assets/web-icons-*.js`, which uses the existing immutable asset cache policy. HTML and the uncached manifest endpoint contain no embedded image bytes.
- The icon script is parser-blocking. It initializes data URLs before Android's document-end icon collection, without relying on a later React effect or asynchronous module.
- The page fetches manifest metadata once with credentials, embeds icon data locally and exposes a Blob manifest. Launch, scope, identity and shortcut URLs are absolute because a Blob cannot resolve the endpoint's relative URLs.
- The browser never fetches the metadata endpoint a second time through its manifest link. Metadata remains uncached; session titles never enter the shared immutable icon script.
- Vite reads icons from `public/` in development and when packaging HTML. The running server needs no icon source directory or data-URL map.
- Artwork, icon sizes and manifest launch URLs remain unchanged. Firefox Android also receives data URLs on all Apple touch icon links because it ranks them above favicons. Other browsers retain file-based Apple touch icons for Safari compatibility; mask icon links retain file URLs everywhere.
- The change applies to browser-hosted web pages and the main HTML shared with Electron. VS Code and Capacitor have separate entrypoints and retain their existing icon behavior.

## Decisions

### Why data URLs live in a cached script

Firefox Android downloads tab and home-screen icons separately from the page. On an mTLS deployment those downloads can fail even when the page and a directly opened image authenticate successfully. A normal page script supplies data URLs without that background TLS request. Keeping the bytes in a content-hashed script lets different document URLs and manifest refreshes reuse one cached resource. Embedding them in the dynamic manifest would retransmit them on every uncached metadata request.
