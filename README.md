# Mandelogue Web Editor

Mandelogue is a browser-based code editor + Linux VM workspace.

It combines:
- Monaco editor tabs
- File explorer (folder workspace and in-memory project mode)
- xterm terminal connected to a v86 VM
- Host <-> VM sync tools
- Snapshot save/load/download/upload
- Tooling for C, C++, Rust, Python, Lua, GitHub import, and VM HTTP proxy preview

## Features

- Folder and project workflows
- Open local folders (File System Access API)
- Create/open/save Mandelogue project files (`.mlp`)
- Explorer actions: create, rename, remove, drag-move
- Tab actions: close, close others, close left/right

- VM integration
- Boot v86 with configurable assets
- Mount workspace files into VM
- Auto-sync VM changes back to host workspace
- Manual sync action

- Snapshots
- Save/load/clear local VM snapshots (IndexedDB)
- Download snapshot (`.bin`) with optional compression (`.zst` / gzip fallback)
- Upload snapshot (`.bin`, `.zst`, `.gz`, etc.)

- Developer tools
- VM internet test
- VM HTTP proxy controls and preview (`/__vm_proxy__/`)
- Bottom status bar + mount/sync progress indicators
- Right sidebar Devtools log panel

## Project Structure

- `index.html` - app shell and UI containers
- `css/styles.css` - styles
- `js/main.js` - app orchestration, menus, actions, sync loop
- `js/editor.js` - Monaco integration
- `js/filesystem.js` - workspace/project filesystem abstraction
- `js/terminal.js` - xterm integration
- `js/vm.js` - v86 service, VM commands, mount/sync/snapshots
- `js/vm-http-proxy.js` - VM HTTP proxy bridge
- `vm-proxy-sw.js` - service worker route for VM proxy

## Run Locally

1. Start a local static server from the repo root.

```powershell
python -m http.server 8000
```

2. Open:

```text
http://localhost:8000
```

Notes:
- Use a modern Chromium-based browser for best File System Access API support.
- For local folder access, run on `localhost` or HTTPS secure context.

## Basic Workflow

1. Open a folder or create a new Mandelogue project.
2. Edit files in Monaco.
3. Save (`Ctrl+S` / `Cmd+S`) to write changes.
4. Mount to VM and run commands in terminal.
5. Use manual sync when needed, or keep auto-sync enabled.
6. Save/download snapshots for fast future boots.

## Snapshot Defaults

- Bundled default snapshot path: `./bin/default.bin`
- External fallback URL can be configured in `js/vm.js`.

## Troubleshooting

- VM runtime fails to load:
- Check browser console/network for blocked asset URLs or proxy limits.
- Verify `js/vm.js` config URLs (runtime, wasm, BIOS, filesystem).

- Folder actions unavailable:
- Ensure the workspace is open and browser grants directory permissions.

- Proxy preview not working:
- Service Worker must be available.
- Enable VM HTTP proxy from Tools and verify the configured port.

## License

No license file is currently included in this repository.
