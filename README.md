# LAN Messenger 🦕

A modern, native desktop Local Area Network (LAN) messenger built entirely with **[Deno Desktop](https://deno.com/blog/v2.9#deno-desktop)** (introduced in **Deno 2.9**).

**Zero external dependencies:** No Node.js runtime, no Bun, no `npm install`, and no `node_modules`. Pure Deno from top to bottom.

---

## ⚡ Features

- **Native Desktop App**: Runs natively on macOS, Windows, and Linux via `deno desktop` using the OS's native webview engine and `Deno.BrowserWindow`.
- **Zero-Configuration LAN Peer Discovery**: Uses UDP broadcast heartbeats on port `45450` (`node:dgram`) to automatically detect other computers running LAN Messenger on the same Wi-Fi or local network.
- **Direct P2P Communication**: Messages and file transfers travel directly between peer IP addresses over local HTTP and WebSockets. No central cloud servers, no third-party tracking, and zero latency.
- **Broadcast Channels & Direct Messages**:
  - `#general`, `#random`, `#announcements`: LAN-wide broadcast channels where all discovered peers see posts in real-time.
  - **1-on-1 Direct Messaging**: Click any peer in the sidebar to chat privately peer-to-peer.
- **High-Speed LAN File Sharing**:
  - Drag-and-drop any file anywhere onto the window.
  - Instant inline previews for images with a full-screen zoom lightbox.
  - Direct download links for documents, archives, and binaries with formatted file sizes.
- **Voice Notes**:
  - Record voice messages directly using your microphone (`navigator.mediaDevices.getUserMedia`).
  - Custom in-bubble audio player with waveform scrub bar and duration indicator.
- **Subnet Fallback & Direct Connect**:
  - **Active Subnet Scanner**: One-click scan of the local `/24` subnet for corporate or guest Wi-Fi networks with AP isolation or UDP broadcast blocking.
  - **Direct IP Connect**: Manually connect to any peer machine via `IP:Port`.
- **Rich Messaging**:
  - Markdown support (bold, italic, auto-hyperlinks).
  - Code blocks with syntax highlighting look and a one-click **Copy Code** button.
  - Emoji reactions (👍, ❤️, 😂, 🎉, 🚀) with live count pills.
  - Real-time typing indicators (*"Alice is typing..."*).
  - Web Audio API notification chimes (harmonic bell chime synthesized dynamically in-browser without audio assets).
- **Customizable Profile & Theme**:
  - Choose display name, avatar emoji/icon, availability status (Online, Away, Busy), and custom status message.
  - Instant Dark & Light mode toggle with persistent `localStorage` settings.
  - In-chat search filter and chat transcript exporter.

---

## 🏗️ Architecture

```
                       +-----------------------------------+
                       |    Deno Desktop (v2.9+) Runner    |
                       |       Deno.BrowserWindow          |
                       +-----------------+-----------------+
                                         |
                       +-----------------v-----------------+
                       |    Embedded Native OS Webview     |
                       |     (index.html, CSS, app.js)     |
                       +-----------------+-----------------+
                                         | Local WebSocket (/ws)
                       +-----------------v-----------------+
                       |      Deno Runtime Backend         |
                       |          (main.ts)                |
                       +-------+-------------------+-------+
                               |                   |
            UDP Broadcast      |                   |  Direct HTTP & WS
            (Port 45450)       |                   |  (Port 4545, 4546...)
                               v                   v
              +-----------------------------------------+
              |           Local Area Network (LAN)       |
              |       Other Deno Desktop Peer Nodes     |
              +-----------------------------------------+
```

1. **Native Shell**: `deno desktop` starts a lightweight native desktop window backed by WKWebView on macOS, WebView2 on Windows, and WebKitGTK on Linux.
2. **Local Bridge**: The webview connects to the internal Deno backend via a local WebSocket (`/ws`).
3. **Peer Discovery**: The Deno process broadcasts an `ANNOUNCE` packet over UDP `45450` every 4 seconds. When peers launch, they exchange a `HELLO` packet for instant mutual discovery.
4. **Transport**: Chat messages and file payloads route directly to `http://<peer_ip>:<lan_port>/api/peer/message`.

---

## 🚀 Quick Start

Ensure you have **Deno v2.9+** installed:
```bash
deno --version
```

### 1. Run in Development Mode with Hot Module Replacement (HMR)

```bash
deno task dev
```
*Launches the native desktop window. Any changes to `index.html`, `style.css`, or `app.js` update live.*

### 2. Run the Desktop Application

```bash
deno task start
```

### 3. Compile a Standalone Native Executable

Produce a self-contained, distributable desktop application (`LanMessenger.app` on macOS, `.exe` on Windows, or `.AppImage` on Linux):

```bash
deno task build
```

You can then run the compiled desktop app directly on your machine:
```bash
open LanMessenger.app
```

### 4. Zero-Install Web Client Access (Anyone on Wi-Fi Can Join!)

When you run **Option 3** (`open LanMessenger.app`), it **automatically serves the web interface on your local network** (`http://<your-mac-ip>:4545`, e.g., `http://192.168.1.7:4545`).

**Anyone on your local Wi-Fi or LAN can immediately join your chat with zero setup:**
- From an iPhone, iPad, or Android phone (via Safari or Chrome).
- From any Windows, Mac, or Linux computer (via Edge, Chrome, or Firefox).
- **They do not need to install Deno or anything else!**
- Each web browser connects as an independent participant with their own name, avatar, and direct messaging abilities.

### 5. Running Option 3 and Option 4 Simultaneously

You can also run both on your machine at the same time:
1. Launch the Desktop App:
   ```bash
   open LanMessenger.app
   ```
   *(Binds to port `4545`)*
2. In a terminal, run the web server task:
   ```bash
   deno task web
   ```
   *(Automatically detects port `4545` is busy and binds to `4546`)*
3. Both instances discover each other over UDP broadcast and communicate as independent nodes!

---

## 🧪 Testing Multi-Peer Chat on a Single Machine

You can simulate multiple users chatting over LAN on the same computer:

1. Open a terminal and run the first instance:
   ```bash
   deno task web
   ```
   *(Listens on port `4545`)*

2. Open a second terminal and run a second instance:
   ```bash
   PORT=4546 deno task web
   ```
   *(Automatically detects port 4545 is taken and binds to `4546`)*

3. Both instances will discover each other over `127.0.0.1` and LAN IP!
4. Send messages, attach files, record voice notes, and test emoji reactions between the two instances.

---

## 📁 Project Structure

```
lan-messenger/
├── main.ts              # Deno Desktop entrypoint, UDP discovery, LAN HTTP & WebSocket server
├── index.html           # Accessible HTML5 SPA interface
├── style.css            # Dark/Light theme styles, glassmorphism, responsive layout
├── app.js               # Client state, audio synthesis, media recorder, drag & drop
├── deno.json            # Tasks, compiler configuration, and build options
└── README.md            # Architecture, documentation, and user guide
```

---

## 🔒 Security & Privacy

- **100% Local**: No external cloud servers or analytics.
- **Air-Gapped Friendly**: Functions completely offline on isolated Wi-Fi or Ethernet LANs with zero internet connectivity.
- **No Node/Bun runtime**: Uses Deno's secure permission model (`--allow-net`, `--allow-read`).
