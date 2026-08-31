# 🚀 SB SFTP Studio

**SB SFTP Studio** is a modern, high-performance, cross-platform Desktop GUI and Web Hub for managing **Multi-Client SSH and SFTP remote server connections**.

Built with TypeScript, Express, WebSockets, xterm.js, and Electron.

---

## ✨ Features

- 🖥️ **Dual Explorer Panels**: Side-by-side Local Filesystem and Remote SFTP explorer with zero horizontal scrolling.
- 👥 **Multi-Client Profiles Manager**: Store and switch between multiple remote servers with saved credentials and quick connection.
- ⚡ **Bi-Directional File & Folder Transfers**: Background transfer queue with progress bars, speed metrics, ETA calculations, and directory recursive syncing.
- 🗑️ **Full File & Folder Deletion**: Delete single files or entire directory trees safely on both local and remote systems.
- 💻 **Integrated Interactive SSH Terminal**: Powered by WebSockets and xterm.js, with support for detaching into a floating resizable desktop window.
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
- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- `npm`

### Installation
```bash
# Clone the repository
git clone https://github.com/sureshmagix/sb-sftp-studio.git
cd sb-sftp-studio

# Install dependencies
npm install
```

### Running the Web GUI
```bash
npm start
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

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
