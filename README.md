# 🚀 SB SFTP Studio

**SB SFTP Studio** is a modern, high-performance, cross-platform Desktop GUI and Web Hub for managing **Multi-Client SSH and SFTP remote server connections**.

Built with TypeScript, Express, WebSockets, SSH2, and Electron.

Current release: **v1.3.1**

---

## ✨ Features

- 🖥️ **Dual Explorer Panels**: Side-by-side Local Filesystem and Remote SFTP explorer with zero horizontal scrolling.
- 👥 **Multi-Client Profiles Manager**: Store and switch between multiple remote servers with saved credentials and quick connection.
- ⚡ **Bi-Directional File & Folder Transfers**: Background transfer queue with progress bars, speed metrics, ETA calculations, and directory recursive syncing.
- 🗑️ **Full File & Folder Deletion**: Delete single files or entire directory trees safely on both local and remote systems.
- 💻 **Integrated SSH Command Terminal**: Run remote commands with a detachable floating desktop window.
- 🛑 **Real Transfer Cancellation**: Active transfers are aborted, partial files are removed, and queue concurrency remains enforced.
- 👁️ **In-App Media & Code Preview**: Instant modal preview for text, JSON, logs, markdown, source code, and images with syntax highlighting.
- 🎨 **13 Professional Themes**:
  - *Dark*: Midnight Neon, GitHub Dark Dimmed, VS Code Modern, One Dark Pro, Catppuccin Mocha, Nordic Frost, Cyber Dracula, Emerald Matrix, Solarized Dark.
  - *Light*: Paper Light, GitHub Light Modern, Nord Snow Storm, Solarized Light.
- 🔍 **Dynamic Global Zoom & Font Sizing**: Header zoom widget (`[-] 100% [+]`) and global keyboard shortcuts (`Ctrl/Cmd +`, `Ctrl/Cmd -`, `Ctrl/Cmd 0`).
- 🔄 **Intelligent Port Fallback**: Auto-increments from `3000 -> 3001 -> 3002...` if port is occupied on startup.
- 📦 **Cross-Platform Electron Desktop App**: Native builds for **macOS** (`.dmg`, `.app`) and **Windows** (`.exe` NSIS installer, portable `.exe`).

---

## 🛠️ Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v20 or higher)
- `npm`

### Installation
```bash
# Clone the repository
git clone https://github.com/sureshmagix/sftp.git
cd sftp

# Install dependencies
npm install
```

### Running the Web GUI
```bash
npm start
```
`npm start` opens an authenticated browser window automatically. The server is restricted to `127.0.0.1`; a manually opened unauthenticated URL is rejected.

### Running the Electron Desktop App
```bash
# Build TypeScript and launch Electron
npm run build
npm run electron
```

---

## 📦 Building Distribution Packages

### macOS (Intel / Apple Silicon)
```bash
# Packages DMG installer and App bundle into release/
npm run dist:mac
```

### Windows (x64)
```bash
# Packages NSIS Setup Installer (.exe), Portable standalone (.exe), and .zip into release/
npm run dist:win
```

### Build All Platforms
```bash
npm run dist:all
```

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| <kbd>Ctrl/Cmd</kbd> + <kbd>+</kbd> | Increase UI font size / zoom in |
| <kbd>Ctrl/Cmd</kbd> + <kbd>-</kbd> | Decrease UI font size / zoom out |
| <kbd>Ctrl/Cmd</kbd> + <kbd>0</kbd> | Reset UI zoom to 100% |

---

## 📄 License
This project is licensed under the [MIT License](LICENSE).

## ✅ Quality Checks

Run the complete build, syntax, transfer-cancellation, server-security, and API smoke-test suite with:

```bash
npm run check
```

Check production dependencies for known vulnerabilities with:

```bash
npm audit
```

## 🔐 Security Defaults

- Local UI binding is restricted to `127.0.0.1`.
- API and WebSocket access require a random per-process session token.
- SSH passwords are kept in memory for the current session only and are excluded from local storage and profile exports.
- SSH host keys require a verified SHA-256 fingerprint, preventing silent man-in-the-middle connections.
- LAN mode is disabled by default. Set `SFTP_ALLOW_LAN=true` only on a trusted network with appropriate host firewall rules.

## 🏷️ v1.3.1 Release Highlights

- **Auto-Closing Transfer Dialog Window**:
  - Automatically dismisses the external animated Transfer Popout window (`#transferPopoutModal`) upon successful completion or evacuation of all items in the transfer queue.
  - Ensures transfer queue status updates reliably trigger window dismissal across progress polling and WebSocket notifications.
- **Universal Version Visibility (v1.3.1)**:
  - Header badge, window title, About dialogue, and `/api/server-info` updated to `v1.3.1`.

## 🏷️ v1.3.0 Release Highlights

- **Universal Folder and File Deletion**:
  - Robust deletion of both files and directory trees (including nested structures and batch selections) across local filesystem and remote SFTP.
  - Automatic detection and fallback between file unlinking and recursive directory removal (`rmdir`) on both client and server.
  - Batch deletion correctly resolves selected folders and files regardless of cache or path formatting nuances.
- **Enhanced Live Transfer Popout Dialog & Cancellation Controls**:
  - Prominent animated Transfer Popout dialog with larger multi-stage visual transfer graphics, glowing nodes, and directional energy flow.
  - Live real-time stats including transferred bytes, total size, throughput speed, remaining ETA, and queue count.
  - Direct, accessible provision to **Cancel Transfer** on active items as well as **Cancel All** for queued batch jobs directly within the popout and HUD.
  - Option to minimize the popout to background while continuing to browse local or remote directories.
- **Universal Version Visibility (v1.3.0)**:
  - App header logo, page document title, Electron native title bar, Preferences / About modal, and Server & Network dialog all visibly display `v1.3.0`.
  - System version dynamically exposed through `/api/server-info`.

## 🏷️ v1.2.0 Release Highlights

- **Transfer Consistency for Large File & Folder Transfers**:
  - Automatic recursive remote directory creation ensures deeply nested folders and parent directories exist before writing.
  - Byte-level size integrity checks on upload and download prevent truncated transfers from being renamed to final filenames.
  - Complete preservation of empty directory hierarchies during recursive directory uploads and downloads.
  - Added transient network error retries (up to 2 automatic retries with backoff) to protect large batch transfers against socket resets.
  - Atomic temporary transfer files (`.sbpart-*`) with automatic cleanup upon cancellation or failure.
- **Idle Connectivity Maintenance & Heartbeat**:
  - Active idle SFTP heartbeat ping every 20s prevents stateful firewall, NAT router, and sshd idle channel timeouts.
  - Automatic reconnection with exponential backoff on unexpected drops while idle.
  - Periodic WebSocket server heartbeat keeps client-server connection alive and detects disconnections instantly.
- **Enhanced Toast Notification System**:
  - Interactive **Live Process Toast** displays real-time transfer progress, speed, ETA, and item counts with an animated progress bar.
  - Prominent **Batch Completion Toast** summarizes finished transfers, total transferred size, and duration.
  - Anti-flood deduplication prevents toast spamming during multi-file transfers.
  - Modern glassmorphic card design with distinct status badges and close controls.

## 🏷️ v1.1.0 Release Highlights

- Added reliable cancellation for queued and active uploads/downloads, including partial-file cleanup.
- Added transfer lifecycle controls for cancelling all transfers and waiting for the queue to become idle.
- Added mandatory SSH SHA-256 host-key fingerprint verification.
- Added authenticated API/WebSocket sessions, trusted-origin checks, restrictive security headers, and local-only binding by default.
- Hardened Electron navigation, permissions, and renderer sandboxing.
- Removed persistent password storage and sanitized imported/exported profiles.
- Added atomic port switching, automated transfer/security/API tests, and zero-vulnerability dependency updates.
