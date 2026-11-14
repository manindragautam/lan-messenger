/**
 * LAN Messenger - Frontend Single Page Application
 * Connected to Deno Desktop backend via WebSocket
 */

(() => {
  // Safe UUID generator supporting non-secure LAN HTTP on mobile devices and browsers
  function generateUUID() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      try {
        return crypto.randomUUID();
      } catch {
        // Fallback if blocked in non-secure context
      }
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // Safe clipboard copy supporting non-secure contexts (LAN HTTP on mobile)
  function copyToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(text).catch(() => {
        fallbackCopyText(text);
      });
    } else {
      fallbackCopyText(text);
    }
  }

  function fallbackCopyText(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      // ignore
    }
    document.body.removeChild(ta);
  }

  globalThis.__copyText = (btn, text) => {
    copyToClipboard(text);
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = orig), 1500);
    }
  };

  // Public Channels helper
  const PUBLIC_CHANNELS = new Set(["general", "random", "announcements"]);
  function isPublicChannel(channelId) {
    if (!channelId) return false;
    const clean = String(channelId).replace(/^#/, "");
    return PUBLIC_CHANNELS.has(clean);
  }
  function normalizeChannel(channelId) {
    if (!channelId) return "general";
    return String(channelId).replace(/^#/, "");
  }

  // Application State
  const state = {
    me: {
      id: "",
      name: "DenoUser",
      avatar: "🦕",
      status: "online",
      statusMessage: "Available",
      lanPort: 4545,
      ips: [],
    },
    peers: new Map(), // peerId -> PeerProfile
    activeChannel: "general", // "general", "random", "announcements", or peerId
    messages: new Map(), // channelId -> Array<ChatMessage>
    unreadCounts: new Map(), // channelId -> number
    typingPeers: new Map(), // channelId -> Set<string>
    soundEnabled: true,
    theme: "dark",
    stagedFile: null, // { name, size, type, dataUrl }
    isRecordingVoice: false,
    mediaRecorder: null,
    audioChunks: [],
    recordingTimerInterval: null,
    recordingStartTime: 0,
    searchQuery: "",
  };

  // WebSocket Connection
  let ws = null;
  let reconnectTimer = null;
  let typingTimeout = null;

  // DOM Elements Cache
  const el = {
    appContainer: document.querySelector(".app-container"),
    sidebar: document.querySelector(".sidebar"),
    sidebarBackdrop: document.getElementById("sidebarBackdrop"),
    mobileSidebarToggleBtn: document.getElementById("mobileSidebarToggleBtn"),
    mobileSidebarCloseBtn: document.getElementById("mobileSidebarCloseBtn"),
    mobileUnreadBadge: document.getElementById("mobileUnreadBadge"),
    // Branding & User
    networkBadge: document.getElementById("networkBadge"),
    networkAddressText: document.getElementById("networkAddressText"),
    myAvatarDisplay: document.getElementById("myAvatarDisplay"),
    myDisplayName: document.getElementById("myDisplayName"),
    myStatusMsgDisplay: document.getElementById("myStatusMsgDisplay"),
    myStatusIndicator: document.getElementById("myStatusIndicator"),
    // Navigation
    channelList: document.getElementById("channelList"),
    peerList: document.getElementById("peerList"),
    peerCountBadge: document.getElementById("peerCountBadge"),
    emptyPeersNotice: document.getElementById("emptyPeersNotice"),
    // Chat Header
    currentChatAvatar: document.getElementById("currentChatAvatar"),
    currentChatTitle: document.getElementById("currentChatTitle"),
    currentChatSubtitle: document.getElementById("currentChatSubtitle"),
    toggleSearchBtn: document.getElementById("toggleSearchBtn"),
    exportChatBtn: document.getElementById("exportChatBtn"),
    clearChatBtn: document.getElementById("clearChatBtn"),
    // Search Bar
    searchBarContainer: document.getElementById("searchBarContainer"),
    searchInput: document.getElementById("searchInput"),
    searchCount: document.getElementById("searchCount"),
    closeSearchBtn: document.getElementById("closeSearchBtn"),
    // Messages
    messagesContainer: document.getElementById("messagesContainer"),
    typingIndicatorBar: document.getElementById("typingIndicatorBar"),
    typingText: document.getElementById("typingText"),
    // Staging & Voice Bar
    fileStagingPreview: document.getElementById("fileStagingPreview"),
    stagingFileIcon: document.getElementById("stagingFileIcon"),
    stagingFileName: document.getElementById("stagingFileName"),
    stagingFileSize: document.getElementById("stagingFileSize"),
    cancelStageBtn: document.getElementById("cancelStageBtn"),
    voiceRecordingBar: document.getElementById("voiceRecordingBar"),
    recordingTimer: document.getElementById("recordingTimer"),
    cancelRecordingBtn: document.getElementById("cancelRecordingBtn"),
    sendRecordingBtn: document.getElementById("sendRecordingBtn"),
    // Composer
    fileInput: document.getElementById("fileInput"),
    attachFileBtn: document.getElementById("attachFileBtn"),
    recordVoiceBtn: document.getElementById("recordVoiceBtn"),
    emojiPickerBtn: document.getElementById("emojiPickerBtn"),
    messageInput: document.getElementById("messageInput"),
    sendMessageBtn: document.getElementById("sendMessageBtn"),
    emojiPopover: document.getElementById("emojiPopover"),
    emojiGrid: document.getElementById("emojiGrid"),
    // Footer Buttons
    themeToggleBtn: document.getElementById("themeToggleBtn"),
    themeIcon: document.getElementById("themeIcon"),
    soundToggleBtn: document.getElementById("soundToggleBtn"),
    soundIcon: document.getElementById("soundIcon"),
    helpInfoBtn: document.getElementById("helpInfoBtn"),
    // Overlays & Modals
    dragDropOverlay: document.getElementById("dragDropOverlay"),
    settingsModal: document.getElementById("settingsModal"),
    openSettingsBtn: document.getElementById("openSettingsBtn"),
    closeSettingsBtn: document.getElementById("closeSettingsBtn"),
    cancelSettingsBtn: document.getElementById("cancelSettingsBtn"),
    saveSettingsBtn: document.getElementById("saveSettingsBtn"),
    displayNameInput: document.getElementById("displayNameInput"),
    statusSelect: document.getElementById("statusSelect"),
    statusMessageInput: document.getElementById("statusMessageInput"),
    avatarSelectionRow: document.getElementById("avatarSelectionRow"),
    networkInterfacesBox: document.getElementById("networkInterfacesBox"),
    // Direct Connect Modal
    directConnectModal: document.getElementById("directConnectModal"),
    openDirectConnectBtn: document.getElementById("openDirectConnectBtn"),
    closeDirectConnectBtn: document.getElementById("closeDirectConnectBtn"),
    cancelDirectConnectBtn: document.getElementById("cancelDirectConnectBtn"),
    confirmDirectConnectBtn: document.getElementById("confirmDirectConnectBtn"),
    peerAddressInput: document.getElementById("peerAddressInput"),
    connectFeedback: document.getElementById("connectFeedback"),
    // Subnet Scan Modal
    subnetScanModal: document.getElementById("subnetScanModal"),
    openSubnetScanBtn: document.getElementById("openSubnetScanBtn"),
    closeSubnetScanBtn: document.getElementById("closeSubnetScanBtn"),
    doneSubnetScanBtn: document.getElementById("doneSubnetScanBtn"),
    startSubnetScanBtn: document.getElementById("startSubnetScanBtn"),
    scanStatusText: document.getElementById("scanStatusText"),
    scanResultsBox: document.getElementById("scanResultsBox"),
    // Lightbox & Help
    imageLightbox: document.getElementById("imageLightbox"),
    lightboxImg: document.getElementById("lightboxImg"),
    lightboxDownloadBtn: document.getElementById("lightboxDownloadBtn"),
    closeLightboxBtn: document.getElementById("closeLightboxBtn"),
    helpModal: document.getElementById("helpModal"),
    closeHelpBtn: document.getElementById("closeHelpBtn"),
    doneHelpBtn: document.getElementById("doneHelpBtn"),
  };

  // Web Audio Chime Synthesizer
  function playAudioChime(type = "incoming") {
    if (!state.soundEnabled) return;
    try {
      const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();

      if (type === "incoming") {
        // Pleasant double-bell harmonic chime
        const now = ctx.currentTime;
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();

        osc1.type = "sine";
        osc1.frequency.setValueAtTime(587.33, now); // D5
        osc1.frequency.exponentialRampToValueAtTime(880, now + 0.12); // A5

        osc2.type = "sine";
        osc2.frequency.setValueAtTime(880, now + 0.08);
        osc2.frequency.exponentialRampToValueAtTime(1174.66, now + 0.25); // D6

        gain.gain.setValueAtTime(0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(ctx.destination);

        osc1.start(now);
        osc2.start(now + 0.08);
        osc1.stop(now + 0.45);
        osc2.stop(now + 0.45);
      } else if (type === "sent") {
        // Subtle pop
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.exponentialRampToValueAtTime(220, now + 0.06);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.06);
      }
    } catch {
      // Audio context might be restricted before first interaction
    }
  }

  // Restore Local Storage Cache
  function restoreLocalData() {
    try {
      const savedTheme = localStorage.getItem("lan_theme");
      if (savedTheme) {
        state.theme = savedTheme;
        document.documentElement.setAttribute("data-theme", savedTheme);
        el.themeIcon.textContent = savedTheme === "dark" ? "🌙" : "☀️";
      }

      const savedSound = localStorage.getItem("lan_sound");
      if (savedSound !== null) {
        state.soundEnabled = savedSound === "true";
        el.soundIcon.textContent = state.soundEnabled ? "🔔" : "🔕";
      }

      const savedMessages = localStorage.getItem("lan_messages_cache");
      if (savedMessages) {
        const parsed = JSON.parse(savedMessages);
        for (const [ch, msgs] of Object.entries(parsed)) {
          state.messages.set(ch, msgs);
        }
      }
    } catch (e) {
      console.warn("Could not load local storage data:", e);
    }
  }

  function saveMessagesToStorage() {
    try {
      const obj = {};
      for (const [ch, msgs] of state.messages.entries()) {
        // Persist last 80 messages per channel
        obj[ch] = msgs.slice(-80);
      }
      localStorage.setItem("lan_messages_cache", JSON.stringify(obj));
    } catch {
      // Storage might be full or disabled in private browsing
    }
  }

  // Connect to Backend WebSocket
  function connectWebSocket() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${location.host}/ws`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log("Connected to Deno Desktop backend WS");
      if (reconnectTimer) {
        clearInterval(reconnectTimer);
        reconnectTimer = null;
      }

      // Determine if this is the native Desktop webview or an external Web browser client
      const isDesktop = !globalThis.location.search.includes("web=1") &&
        (navigator.userAgent.includes("Deno") || (location.hostname === "127.0.0.1" && !localStorage.getItem("lan_web_client_id")));

      let myId = localStorage.getItem("lan_client_id");
      let myName = localStorage.getItem("lan_client_name");
      let myAvatar = localStorage.getItem("lan_client_avatar");

      if (!isDesktop && !myId) {
        myId = "web_" + Math.random().toString(36).slice(2, 9);
        myName = "WebUser-" + Math.floor(1000 + Math.random() * 9000);
        myAvatar = "🦊";
        localStorage.setItem("lan_web_client_id", myId);
        localStorage.setItem("lan_client_id", myId);
        localStorage.setItem("lan_client_name", myName);
        localStorage.setItem("lan_client_avatar", myAvatar);
      }

      ws.send(JSON.stringify({
        type: "CLIENT_HELLO",
        payload: {
          id: myId || undefined,
          name: myName || undefined,
          avatar: myAvatar || undefined,
          isHost: isDesktop,
        },
      }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleServerEvent(msg);
      } catch (err) {
        console.error("Failed to parse incoming WS message:", err);
      }
    };

    ws.onclose = () => {
      console.warn("WebSocket closed. Reconnecting in 2s...");
      if (!reconnectTimer) {
        reconnectTimer = setInterval(connectWebSocket, 2000);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  // Handle Server Events
  function handleServerEvent(event) {
    const { type, payload } = event;

    if (type === "INIT") {
      state.me = payload.me;
      localStorage.setItem("lan_client_id", state.me.id);
      localStorage.setItem("lan_client_name", state.me.name);
      localStorage.setItem("lan_client_avatar", state.me.avatar);
      updateMyProfileUI();
      if (payload.peers) {
        updatePeersList(payload.peers);
      }
      renderMessages();
    } else if (type === "PEER_UPDATE") {
      if (payload.peers) {
        updatePeersList(payload.peers);
      }
    } else if (type === "PROFILE_UPDATED") {
      state.me = payload;
      localStorage.setItem("lan_client_id", state.me.id);
      localStorage.setItem("lan_client_name", state.me.name);
      localStorage.setItem("lan_client_avatar", state.me.avatar);
      updateMyProfileUI();
    } else if (type === "INCOMING_MESSAGE") {
      const message = payload;
      const targetChannel = isPublicChannel(message.channelId)
        ? normalizeChannel(message.channelId)
        : (message.senderId === state.me.id ? message.channelId : message.senderId);

      addMessageToChannel(targetChannel, message);

      if (state.activeChannel === targetChannel) {
        renderMessages();
        scrollToBottom();
      } else {
        const currentUnread = state.unreadCounts.get(targetChannel) || 0;
        state.unreadCounts.set(targetChannel, currentUnread + 1);
        updateUnreadBadges();
      }

      playAudioChime("incoming");
      saveMessagesToStorage();
    } else if (type === "MESSAGE_SENT") {
      const message = payload;
      const targetChannel = isPublicChannel(message.channelId)
        ? normalizeChannel(message.channelId)
        : message.channelId;

      addMessageToChannel(targetChannel, message);
      renderMessages();
      scrollToBottom();
      playAudioChime("sent");
      saveMessagesToStorage();
    } else if (type === "PEER_TYPING") {
      handleTypingNotification(payload);
    } else if (type === "PEER_REACTION") {
      handleReactionNotification(payload);
    } else if (type === "CONNECT_SUCCESS") {
      el.connectFeedback.textContent = `Connected to ${payload.peer.name}!`;
      el.connectFeedback.className = "connect-feedback success";
      setTimeout(() => {
        el.directConnectModal.classList.add("hidden");
        el.peerAddressInput.value = "";
        el.connectFeedback.classList.add("hidden");
      }, 1200);
    } else if (type === "CONNECT_ERROR") {
      el.connectFeedback.textContent = payload.error;
      el.connectFeedback.className = "connect-feedback error";
    } else if (type === "SCAN_COMPLETE") {
      renderScanResults(payload.found);
    }
  }

  function addMessageToChannel(channel, message) {
    if (!state.messages.has(channel)) {
      state.messages.set(channel, []);
    }
    const list = state.messages.get(channel);
    // Deduplicate by message ID
    if (!list.some((m) => m.id === message.id)) {
      list.push(message);
    }
  }

  // Update UI: Local User Profile
  function updateMyProfileUI() {
    el.myAvatarDisplay.textContent = state.me.avatar || "🦕";
    el.myDisplayName.textContent = state.me.name || "DenoUser";
    el.myStatusMsgDisplay.textContent = state.me.statusMessage || "Available";

    el.myStatusIndicator.className = "status-indicator status-" + (state.me.status || "online");

    // Prefer mDNS Host name (Device Name with port) for friendly local sharing
    const displayHost = state.me.mdnsHost || (state.me.ips && state.me.ips.length > 0 ? state.me.ips[0] : "127.0.0.1");
    el.networkAddressText.textContent = `${displayHost}:${state.me.lanPort}`;
    el.networkAddressText.dataset.fullUrl = state.me.mdnsUrl || `http://${displayHost}:${state.me.lanPort}`;

    // Populate Settings Modal fields
    el.displayNameInput.value = state.me.name;
    el.statusSelect.value = state.me.status;
    el.statusMessageInput.value = state.me.statusMessage;

    // Highlight selected avatar
    document.querySelectorAll(".avatar-choice").forEach((btn) => {
      btn.classList.toggle("selected", btn.dataset.avatar === state.me.avatar);
    });

    // Populate network addresses & mDNS device name in modal
    el.networkInterfacesBox.innerHTML = "";

    // 1. mDNS Device Address
    if (state.me.mdnsUrl) {
      const mdnsDiv = document.createElement("div");
      mdnsDiv.className = "iface-entry iface-highlight";
      mdnsDiv.innerHTML = `
        <div class="iface-info">
          <span>🏷️ <strong>mDNS Device Name:</strong></span>
          <a href="${state.me.mdnsUrl}" target="_blank" class="iface-link">${state.me.mdnsUrl}</a>
        </div>
        <button class="copy-url-btn" onclick="window.__copyText(this, '${state.me.mdnsUrl}')">Copy</button>
      `;
      el.networkInterfacesBox.appendChild(mdnsDiv);
    }

    // 2. LAN IPv4 Addresses
    if (state.me.ips && state.me.ips.length > 0) {
      for (const ifaceIp of state.me.ips) {
        const ipUrl = `http://${ifaceIp}:${state.me.lanPort}`;
        const div = document.createElement("div");
        div.className = "iface-entry";
        div.innerHTML = `
          <div class="iface-info">
            <span>📱 <strong>LAN IPv4 Address:</strong></span>
            <a href="${ipUrl}" target="_blank" class="iface-link">${ipUrl}</a>
          </div>
          <button class="copy-url-btn" onclick="window.__copyText(this, '${ipUrl}')">Copy</button>
        `;
        el.networkInterfacesBox.appendChild(div);
      }
    }

    // 3. Localhost URL
    const localUrl = `http://localhost:${state.me.lanPort}`;
    const localDiv = document.createElement("div");
    localDiv.className = "iface-entry";
    localDiv.innerHTML = `
      <div class="iface-info">
        <span>💻 <strong>Local Machine:</strong></span>
        <a href="${localUrl}" target="_blank" class="iface-link">${localUrl}</a>
      </div>
      <button class="copy-url-btn" onclick="window.__copyText(this, '${localUrl}')">Copy</button>
    `;
    el.networkInterfacesBox.appendChild(localDiv);
  }

  // Update UI: Discovered Peers List
  function updatePeersList(peersArray) {
    state.peers.clear();
    for (const p of peersArray) {
      if (p.id !== state.me.id) {
        state.peers.set(p.id, p);
      }
    }

    const onlinePeers = Array.from(state.peers.values()).filter((p) => p.status !== "offline");
    el.peerCountBadge.textContent = String(onlinePeers.length);

    if (state.peers.size === 0) {
      el.emptyPeersNotice.classList.remove("hidden");
      el.peerList.innerHTML = "";
      el.peerList.appendChild(el.emptyPeersNotice);
      return;
    }

    el.emptyPeersNotice.classList.add("hidden");
    el.peerList.innerHTML = "";

    // Sort: online first, then alphabetical
    const sorted = Array.from(state.peers.values()).sort((a, b) => {
      if (a.status === "offline" && b.status !== "offline") return 1;
      if (a.status !== "offline" && b.status === "offline") return -1;
      return a.name.localeCompare(b.name);
    });

    for (const peer of sorted) {
      const btn = document.createElement("button");
      btn.className = `peer-nav-item ${state.activeChannel === peer.id ? "active" : ""}`;
      btn.dataset.peerId = peer.id;

      const unread = state.unreadCounts.get(peer.id) || 0;
      const peerIp = peer.ips && peer.ips.length > 0 ? peer.ips[0] : "";

      btn.innerHTML = `
        <div class="peer-avatar-wrapper">
          <div class="peer-avatar">${peer.avatar || "👤"}</div>
          <span class="peer-status-dot status-${peer.status || "offline"}"></span>
        </div>
        <div class="peer-info-col">
          <span class="peer-name-text">${escapeHtml(peer.name)}</span>
          <span class="peer-sub-text">${escapeHtml(peer.statusMessage || peerIp)}</span>
        </div>
        <span class="unread-pill ${unread === 0 ? "hidden" : ""}" data-unread="${peer.id}">${unread}</span>
      `;

      btn.onclick = () => {
        switchChannel(peer.id);
      };

      el.peerList.appendChild(btn);
    }
  }

  // Mobile Slide-over Sidebar Drawer Controls
  function openMobileSidebar() {
    if (el.sidebar) el.sidebar.classList.add("mobile-open");
    if (el.sidebarBackdrop) el.sidebarBackdrop.classList.remove("hidden");
    if (el.mobileUnreadBadge) el.mobileUnreadBadge.classList.add("hidden");
  }

  function closeMobileSidebar() {
    if (el.sidebar) el.sidebar.classList.remove("mobile-open");
    if (el.sidebarBackdrop) el.sidebarBackdrop.classList.add("hidden");
  }

  // Switch Active Channel or Direct Chat
  function switchChannel(channelId) {
    state.activeChannel = channelId;

    // Automatically close mobile slide-over sidebar upon selecting channel/peer
    closeMobileSidebar();

    // Clear unread count for this channel
    state.unreadCounts.set(channelId, 0);
    updateUnreadBadges();

    // Update active nav button
    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.channel === channelId);
    });
    document.querySelectorAll(".peer-nav-item").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.peerId === channelId);
    });

    // Update Header
    if (channelId.startsWith("#") || ["general", "random", "announcements"].includes(channelId)) {
      const cleanName = channelId.replace(/^#/, "");
      el.currentChatAvatar.textContent = "#";
      el.currentChatTitle.textContent = cleanName;
      el.currentChatSubtitle.textContent = `LAN Broadcast Channel • Everyone on local network`;
      el.messageInput.placeholder = `Message #${cleanName} (Enter to send, Shift+Enter for new line)...`;
    } else {
      const peer = state.peers.get(channelId);
      if (peer) {
        el.currentChatAvatar.textContent = peer.avatar || "👤";
        el.currentChatTitle.textContent = peer.name;
        const ip = peer.ips && peer.ips.length > 0 ? peer.ips[0] : "";
        el.currentChatSubtitle.textContent = `${ip}:${peer.lanPort} • Direct 1-on-1 Chat • ${peer.status.toUpperCase()}`;
        el.messageInput.placeholder = `Message ${peer.name}...`;
      }
    }

    renderMessages();
    scrollToBottom();
    el.messageInput.focus();
  }

  function updateUnreadBadges() {
    let totalUnread = 0;
    document.querySelectorAll(".unread-pill").forEach((pill) => {
      const channel = pill.dataset.unread;
      const count = state.unreadCounts.get(channel) || 0;
      totalUnread += count;
      pill.textContent = String(count);
      pill.classList.toggle("hidden", count === 0);
    });

    if (el.mobileUnreadBadge) {
      el.mobileUnreadBadge.textContent = totalUnread > 99 ? "99+" : String(totalUnread);
      el.mobileUnreadBadge.classList.toggle("hidden", totalUnread === 0);
    }
  }

  // Render Messages for Active Channel
  function renderMessages() {
    const list = state.messages.get(state.activeChannel) || [];
    el.messagesContainer.innerHTML = "";

    // Welcome block
    const isRoom = ["general", "random", "announcements"].includes(state.activeChannel);
    const welcome = document.createElement("div");
    welcome.className = "messages-welcome";
    welcome.innerHTML = `
      <div class="welcome-dino">🦕</div>
      <h3>Welcome to ${isRoom ? "#" + state.activeChannel : el.currentChatTitle.textContent}!</h3>
      <p>${
        isRoom
          ? "Messages sent here are broadcast in real-time across your local network."
          : "Direct, peer-to-peer end-to-end local LAN conversation."
      }</p>
    `;
    el.messagesContainer.appendChild(welcome);

    // Filter by search query if any
    const query = state.searchQuery.toLowerCase().trim();
    let matchesCount = 0;

    for (const msg of list) {
      const isMatch = !query || (msg.content && msg.content.toLowerCase().includes(query)) ||
        (msg.senderName && msg.senderName.toLowerCase().includes(query));

      if (query && isMatch) matchesCount++;

      const row = createMessageRow(msg, query && isMatch);
      el.messagesContainer.appendChild(row);
    }

    if (query) {
      el.searchCount.textContent = `${matchesCount} results`;
    }
  }

  function createMessageRow(msg, isHighlighted = false) {
    const row = document.createElement("div");
    row.className = `message-row ${isHighlighted ? "highlighted" : ""}`;
    row.dataset.msgId = msg.id;

    const isMe = msg.senderId === state.me.id;
    const timeStr = formatTimestamp(msg.timestamp);

    // Render body content
    let bodyHtml = "";
    if (msg.content) {
      bodyHtml += `<div class="message-body">${formatMarkdown(msg.content)}</div>`;
    }

    // Render file / image / audio attachments
    if (msg.fileInfo) {
      const { id, name, size, mimeType, dataUrl } = msg.fileInfo;
      const sizeStr = formatBytes(size);

      if (mimeType.startsWith("image/") && dataUrl) {
        bodyHtml += `
          <div class="message-image-preview" onclick="window.__openLightbox('${dataUrl}', '${escapeHtml(name)}')">
            <img src="${dataUrl}" alt="${escapeHtml(name)}" loading="lazy">
          </div>
        `;
      } else if (mimeType.startsWith("audio/") && dataUrl) {
        bodyHtml += `
          <div class="audio-player-bubble">
            <button class="audio-play-btn" onclick="window.__toggleAudioPlay(this, '${dataUrl}')">▶</button>
            <input type="range" class="audio-scrubber" value="0" min="0" max="100" step="1">
            <span class="audio-time-label">0:00</span>
          </div>
        `;
      } else {
        bodyHtml += `
          <a class="file-card" href="${dataUrl || `/api/peer/file/${id}`}" download="${escapeHtml(name)}">
            <span class="file-card-icon">${getFileIcon(name)}</span>
            <div class="file-card-meta">
              <span class="file-card-name">${escapeHtml(name)}</span>
              <span class="file-card-size">${sizeStr}</span>
            </div>
            <button class="file-card-download-btn">Download</button>
          </a>
        `;
      }
    }

    // Reactions HTML
    let reactionsHtml = "";
    if (msg.reactions && Object.keys(msg.reactions).length > 0) {
      reactionsHtml += `<div class="reactions-row">`;
      for (const [emoji, users] of Object.entries(msg.reactions)) {
        if (users.length > 0) {
          const reactedByMe = users.includes(state.me.id);
          reactionsHtml += `
            <button class="reaction-pill ${reactedByMe ? "reacted" : ""}" onclick="window.__toggleReaction('${msg.id}', '${emoji}')" title="${users.join(", ")}">
              <span>${emoji}</span>
              <span>${users.length}</span>
            </button>
          `;
        }
      }
      reactionsHtml += `</div>`;
    }

    row.innerHTML = `
      <div class="message-avatar">${msg.senderAvatar || "👤"}</div>
      <div class="message-content-col">
        <div class="message-meta">
          <span class="sender-name ${isMe ? "is-me" : ""}">${escapeHtml(msg.senderName || "Unknown")}</span>
          <span class="message-time">${timeStr}</span>
        </div>
        ${bodyHtml}
        ${reactionsHtml}
      </div>
      <div class="message-actions-bar">
        <button class="action-bar-btn" onclick="window.__toggleReaction('${msg.id}', '👍')">👍</button>
        <button class="action-bar-btn" onclick="window.__toggleReaction('${msg.id}', '❤️')">❤️</button>
        <button class="action-bar-btn" onclick="window.__toggleReaction('${msg.id}', '😂')">😂</button>
        <button class="action-bar-btn" onclick="window.__toggleReaction('${msg.id}', '🚀')">🚀</button>
      </div>
    `;

    return row;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      el.messagesContainer.scrollTop = el.messagesContainer.scrollHeight;
    });
  }

  // Send Message Action
  function sendMessage() {
    try {
      const text = el.messageInput.value.trim();
      if (!text && !state.stagedFile) return;

      const payload = {
        id: generateUUID(),
        channelId: state.activeChannel,
        content: text,
        type: state.stagedFile
          ? (state.stagedFile.type.startsWith("image/") ? "image" : "file")
          : "text",
      };

      if (state.stagedFile) {
        payload.fileInfo = {
          id: generateUUID(),
          name: state.stagedFile.name,
          size: state.stagedFile.size,
          mimeType: state.stagedFile.type,
          dataUrl: state.stagedFile.dataUrl,
        };
        clearStagedFile();
      }

      // Ensure WebSocket connection is live
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn("[Send] WebSocket not connected (readyState=" + (ws ? ws.readyState : "null") + "). Reconnecting...");
        alert("Not connected to LAN Host. Reconnecting now...");
        connectWebSocket();
        return;
      }

      ws.send(JSON.stringify({ type: "SEND_MESSAGE", payload }));

      el.messageInput.value = "";
      el.messageInput.style.height = "auto";
      sendTypingIndicator(false);
    } catch (err) {
      console.error("[Send] Failed to send message:", err);
      alert("Error sending message: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  // Typing Notification Logic
  function handleTypingNotification({ peerId, peerName, channelId, isTyping }) {
    if (peerId === state.me.id) return;
    if (!state.typingPeers.has(channelId)) {
      state.typingPeers.set(channelId, new Set());
    }
    const set = state.typingPeers.get(channelId);
    if (isTyping) {
      set.add(peerName);
    } else {
      set.delete(peerName);
    }

    if (channelId === state.activeChannel) {
      updateTypingBar();
    }
  }

  function updateTypingBar() {
    const set = state.typingPeers.get(state.activeChannel);
    if (!set || set.size === 0) {
      el.typingIndicatorBar.classList.add("hidden");
      return;
    }

    const names = Array.from(set).join(", ");
    el.typingText.textContent = `${names} ${set.size === 1 ? "is" : "are"} typing...`;
    el.typingIndicatorBar.classList.remove("hidden");
  }

  function sendTypingIndicator(isTyping) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "SEND_TYPING",
          payload: { channelId: state.activeChannel, isTyping },
        }),
      );
    }
  }

  // Reaction Notification Logic
  function handleReactionNotification({ messageId, emoji, peerId, channelId }) {
    const list = state.messages.get(channelId) || [];
    const msg = list.find((m) => m.id === messageId);
    if (msg) {
      if (!msg.reactions) msg.reactions = {};
      if (!msg.reactions[emoji]) msg.reactions[emoji] = [];

      const idx = msg.reactions[emoji].indexOf(peerId);
      if (idx > -1) {
        msg.reactions[emoji].splice(idx, 1);
        if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
      } else {
        msg.reactions[emoji].push(peerId);
      }

      if (state.activeChannel === channelId) {
        renderMessages();
      }
    }
  }

  globalThis.__toggleReaction = (messageId, emoji) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "SEND_REACTION",
          payload: { messageId, emoji, channelId: state.activeChannel },
        }),
      );
    }
  };

  // Audio Playback in Chat Bubble
  globalThis.__toggleAudioPlay = (btn, audioUrl) => {
    const bubble = btn.closest(".audio-player-bubble");
    const scrubber = bubble.querySelector(".audio-scrubber");
    const label = bubble.querySelector(".audio-time-label");

    if (btn._audio && !btn._audio.paused) {
      btn._audio.pause();
      btn.textContent = "▶";
      return;
    }

    if (!btn._audio) {
      const audio = new Audio(audioUrl);
      btn._audio = audio;

      audio.ontimeupdate = () => {
        if (audio.duration) {
          scrubber.value = String((audio.currentTime / audio.duration) * 100);
          label.textContent = formatDuration(audio.currentTime);
        }
      };

      audio.onended = () => {
        btn.textContent = "▶";
        scrubber.value = "0";
        label.textContent = "0:00";
      };

      scrubber.oninput = () => {
        if (audio.duration) {
          audio.currentTime = (scrubber.value / 100) * audio.duration;
        }
      };
    }

    btn._audio.play();
    btn.textContent = "⏸";
  };

  // Voice Note Recording
  async function startVoiceRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.mediaRecorder = new MediaRecorder(stream);
      state.audioChunks = [];

      state.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) state.audioChunks.push(e.data);
      };

      state.mediaRecorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const audioBlob = new Blob(state.audioChunks, { type: "audio/webm" });
        const reader = new FileReader();
        reader.onloadend = () => {
          sendVoiceClip(reader.result);
        };
        reader.readAsDataURL(audioBlob);
      };

      state.mediaRecorder.start();
      state.isRecordingVoice = true;
      state.recordingStartTime = Date.now();
      el.voiceRecordingBar.classList.remove("hidden");

      state.recordingTimerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - state.recordingStartTime) / 1000);
        el.recordingTimer.textContent = formatDuration(elapsed);
      }, 500);
    } catch (err) {
      alert("Microphone permission denied or audio device not found: " + err.message);
    }
  }

  function stopVoiceRecording(discard = false) {
    if (!state.isRecordingVoice || !state.mediaRecorder) return;
    clearInterval(state.recordingTimerInterval);
    el.voiceRecordingBar.classList.add("hidden");
    state.isRecordingVoice = false;

    if (discard) {
      state.mediaRecorder.ondataavailable = null;
      state.mediaRecorder.onstop = null;
      state.mediaRecorder.stop();
    } else {
      state.mediaRecorder.stop();
    }
  }

  function sendVoiceClip(dataUrl) {
    try {
      const payload = {
        id: generateUUID(),
        channelId: state.activeChannel,
        content: "",
        type: "audio",
        fileInfo: {
          id: generateUUID(),
          name: `voice-note-${Date.now()}.webm`,
          size: Math.round((dataUrl.length * 3) / 4),
          mimeType: "audio/webm",
          dataUrl,
        },
      };

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        alert("Not connected to LAN Host. Reconnecting...");
        connectWebSocket();
        return;
      }

      ws.send(JSON.stringify({ type: "SEND_MESSAGE", payload }));
    } catch (err) {
      console.error("[Send] Failed to send voice clip:", err);
      alert("Error sending voice note: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  // Staging Files (File picker & Drag and drop)
  function stageFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      state.stagedFile = {
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
        dataUrl: e.target.result,
      };

      el.stagingFileName.textContent = file.name;
      el.stagingFileSize.textContent = formatBytes(file.size);
      el.stagingFileIcon.textContent = getFileIcon(file.name);
      el.fileStagingPreview.classList.remove("hidden");
      el.messageInput.focus();
    };
    reader.readAsDataURL(file);
  }

  function clearStagedFile() {
    state.stagedFile = null;
    el.fileStagingPreview.classList.add("hidden");
    el.fileInput.value = "";
  }

  // Lightbox Viewer
  globalThis.__openLightbox = (src, name) => {
    el.lightboxImg.src = src;
    el.lightboxDownloadBtn.href = src;
    el.lightboxDownloadBtn.download = name || "image.png";
    el.imageLightbox.classList.remove("hidden");
  };

  // Subnet Scanner Result Renderer
  function renderScanResults(foundPeers) {
    el.scanStatusText.textContent = `Scan complete. Found ${foundPeers.length} peer(s).`;
    el.scanResultsBox.innerHTML = "";

    if (foundPeers.length === 0) {
      el.scanResultsBox.innerHTML = '<p class="no-results-text">No peers found in /24 subnet range.</p>';
      return;
    }

    for (const p of foundPeers) {
      const div = document.createElement("div");
      div.className = "scan-peer-item";
      div.innerHTML = `
        <span>${p.avatar || "👤"} <strong>${escapeHtml(p.name)}</strong> (${p.ips[0]}:${p.lanPort})</span>
        <button class="btn btn-primary" style="padding: 3px 8px; font-size: 11px;">Chat</button>
      `;
      div.querySelector("button").onclick = () => {
        el.subnetScanModal.classList.add("hidden");
        switchChannel(p.id);
      };
      el.scanResultsBox.appendChild(div);
    }
  }

  // Markdown Formatter (Bold, Italic, Code Blocks, Links)
  function formatMarkdown(text) {
    let escaped = escapeHtml(text);

    // Code blocks with syntax copy button: ```code```
    escaped = escaped.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      return `
        <div class="code-block-wrapper">
          <div class="code-header">
            <span>${lang || "code"}</span>
            <button class="copy-code-btn" onclick="window.__copyText(this, this.closest('.code-block-wrapper').querySelector('pre').innerText)">Copy</button>
          </div>
          <pre><code>${code.trim()}</code></pre>
        </div>
      `;
    });

    // Inline code: `code`
    escaped = escaped.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Bold: **text**
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

    // Italic: *text*
    escaped = escaped.replace(/\*([^*]+)\*/g, "<em>$1</em>");

    // Auto-link URLs
    escaped = escaped.replace(
      /(https?:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
    );

    // Line breaks
    escaped = escaped.replace(/\n/g, "<br>");

    return escaped;
  }

  // Helper Utilities
  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }

  function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
  }

  function formatTimestamp(timestamp) {
    const d = new Date(timestamp);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function getFileIcon(filename) {
    const ext = filename.split(".").pop().toLowerCase();
    if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "🖼️";
    if (["mp3", "wav", "webm", "ogg", "m4a"].includes(ext)) return "🎵";
    if (["mp4", "mov", "avi", "mkv"].includes(ext)) return "🎬";
    if (["zip", "tar", "gz", "7z", "rar"].includes(ext)) return "📦";
    if (["js", "ts", "py", "rs", "go", "json", "html", "css"].includes(ext)) return "💻";
    if (["pdf"].includes(ext)) return "📕";
    return "📄";
  }

  // Populate Emoji Grid
  const emojis = [
    "🦕", "👍", "❤️", "🔥", "😂", "🎉", "🚀",
    "💻", "💡", "✨", "👏", "⚡", "👀", "☕",
    "🙌", "🥳", "🍕", "🎯", "🛠️", "🏖️", "🤖",
  ];
  for (const emo of emojis) {
    const b = document.createElement("button");
    b.className = "emoji-btn";
    b.textContent = emo;
    b.onclick = () => {
      el.messageInput.value += emo;
      el.emojiPopover.classList.add("hidden");
      el.messageInput.focus();
    };
    el.emojiGrid.appendChild(b);
  }

  // Event Listeners Setup
  function setupEventListeners() {
    // Channel clicks
    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.onclick = () => switchChannel(btn.dataset.channel);
    });

    // Send button & Input shortcuts
    let lastSendTimestamp = 0;
    const triggerSend = (e) => {
      if (e) e.preventDefault();
      const now = Date.now();
      if (now - lastSendTimestamp < 250) return;
      lastSendTimestamp = now;
      sendMessage();
    };

    if (el.sendMessageBtn) {
      el.sendMessageBtn.onclick = triggerSend;
      el.sendMessageBtn.addEventListener("pointerdown", triggerSend);
    }
    el.messageInput.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      } else {
        // Send typing heartbeat
        if (!typingTimeout) {
          sendTypingIndicator(true);
        }
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
          sendTypingIndicator(false);
          typingTimeout = null;
        }, 1800);
      }
    };

    // Auto-grow textarea
    el.messageInput.oninput = () => {
      el.messageInput.style.height = "auto";
      el.messageInput.style.height = Math.min(el.messageInput.scrollHeight, 130) + "px";
    };

    // Attach File
    el.attachFileBtn.onclick = () => el.fileInput.click();
    el.fileInput.onchange = (e) => {
      if (e.target.files && e.target.files[0]) {
        stageFile(e.target.files[0]);
      }
    };
    el.cancelStageBtn.onclick = clearStagedFile;

    // Voice Recording
    el.recordVoiceBtn.onclick = () => {
      if (state.isRecordingVoice) {
        stopVoiceRecording(false);
      } else {
        startVoiceRecording();
      }
    };
    el.cancelRecordingBtn.onclick = () => stopVoiceRecording(true);
    el.sendRecordingBtn.onclick = () => stopVoiceRecording(false);

    // Emoji Popover
    el.emojiPickerBtn.onclick = (e) => {
      e.stopPropagation();
      el.emojiPopover.classList.toggle("hidden");
    };
    document.addEventListener("click", (e) => {
      if (!el.emojiPopover.contains(e.target) && e.target !== el.emojiPickerBtn) {
        el.emojiPopover.classList.add("hidden");
      }
    });

    // Theme Toggle
    el.themeToggleBtn.onclick = () => {
      const nextTheme = state.theme === "dark" ? "light" : "dark";
      state.theme = nextTheme;
      document.documentElement.setAttribute("data-theme", nextTheme);
      el.themeIcon.textContent = nextTheme === "dark" ? "🌙" : "☀️";
      localStorage.setItem("lan_theme", nextTheme);
    };

    // Sound Toggle
    el.soundToggleBtn.onclick = () => {
      state.soundEnabled = !state.soundEnabled;
      el.soundIcon.textContent = state.soundEnabled ? "🔔" : "🔕";
      localStorage.setItem("lan_sound", String(state.soundEnabled));
      if (state.soundEnabled) playAudioChime("incoming");
    };

    // Profile & Settings Modal
    el.openSettingsBtn.onclick = () => el.settingsModal.classList.remove("hidden");
    el.closeSettingsBtn.onclick = () => el.settingsModal.classList.add("hidden");
    el.cancelSettingsBtn.onclick = () => el.settingsModal.classList.add("hidden");

    document.querySelectorAll(".avatar-choice").forEach((choice) => {
      choice.onclick = () => {
        document.querySelectorAll(".avatar-choice").forEach((c) => c.classList.remove("selected"));
        choice.classList.add("selected");
      };
    });

    el.saveSettingsBtn.onclick = () => {
      const name = el.displayNameInput.value.trim() || state.me.name;
      const status = el.statusSelect.value;
      const statusMessage = el.statusMessageInput.value.trim();
      const selectedAvatarEl = document.querySelector(".avatar-choice.selected");
      const avatar = selectedAvatarEl ? selectedAvatarEl.dataset.avatar : state.me.avatar;

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "UPDATE_PROFILE",
            payload: { name, avatar, status, statusMessage },
          }),
        );
      }
      el.settingsModal.classList.add("hidden");
    };

    // Direct Connect Modal
    el.openDirectConnectBtn.onclick = () => {
      el.connectFeedback.classList.add("hidden");
      el.directConnectModal.classList.remove("hidden");
      el.peerAddressInput.focus();
    };
    el.closeDirectConnectBtn.onclick = () => el.directConnectModal.classList.add("hidden");
    el.cancelDirectConnectBtn.onclick = () => el.directConnectModal.classList.add("hidden");

    el.confirmDirectConnectBtn.onclick = () => {
      const target = el.peerAddressInput.value.trim();
      if (!target) return;
      el.connectFeedback.textContent = "Connecting to peer...";
      el.connectFeedback.className = "connect-feedback";
      el.connectFeedback.classList.remove("hidden");

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "MANUAL_CONNECT",
            payload: { target },
          }),
        );
      }
    };

    // Subnet Scan Modal
    el.openSubnetScanBtn.onclick = () => el.subnetScanModal.classList.remove("hidden");
    el.closeSubnetScanBtn.onclick = () => el.subnetScanModal.classList.add("hidden");
    el.doneSubnetScanBtn.onclick = () => el.subnetScanModal.classList.add("hidden");

    el.startSubnetScanBtn.onclick = () => {
      el.scanStatusText.textContent = "Scanning /24 subnet... please wait";
      el.scanResultsBox.innerHTML = '<p class="no-results-text">Probing LAN subnet hosts...</p>';
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "START_SCAN", payload: {} }));
      }
    };

    // Search Toggle
    el.toggleSearchBtn.onclick = () => {
      el.searchBarContainer.classList.toggle("hidden");
      if (!el.searchBarContainer.classList.contains("hidden")) {
        el.searchInput.focus();
      } else {
        state.searchQuery = "";
        renderMessages();
      }
    };

    el.closeSearchBtn.onclick = () => {
      el.searchBarContainer.classList.add("hidden");
      state.searchQuery = "";
      renderMessages();
    };

    el.searchInput.oninput = (e) => {
      state.searchQuery = e.target.value;
      renderMessages();
    };

    // Export Chat Transcript
    el.exportChatBtn.onclick = () => {
      const list = state.messages.get(state.activeChannel) || [];
      const lines = list.map((m) => {
        const time = new Date(m.timestamp).toLocaleString();
        return `[${time}] ${m.senderName}: ${m.content || (m.fileInfo ? `[File: ${m.fileInfo.name}]` : "")}`;
      });
      const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `lan-chat-${state.activeChannel}-${Date.now()}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    };

    // Clear Chat
    el.clearChatBtn.onclick = () => {
      if (confirm(`Clear chat messages in #${state.activeChannel}?`)) {
        state.messages.set(state.activeChannel, []);
        saveMessagesToStorage();
        renderMessages();
      }
    };

    // Lightbox Close
    el.closeLightboxBtn.onclick = () => el.imageLightbox.classList.add("hidden");
    el.imageLightbox.onclick = (e) => {
      if (e.target === el.imageLightbox) el.imageLightbox.classList.add("hidden");
    };

    // Help Modal
    el.helpInfoBtn.onclick = () => el.helpModal.classList.remove("hidden");
    el.closeHelpBtn.onclick = () => el.helpModal.classList.add("hidden");
    el.doneHelpBtn.onclick = () => el.helpModal.classList.add("hidden");

    // Drag and Drop Files over Entire Window
    globalThis.addEventListener("dragenter", (e) => {
      e.preventDefault();
      el.dragDropOverlay.classList.remove("hidden");
    });
    el.dragDropOverlay.addEventListener("dragover", (e) => e.preventDefault());
    el.dragDropOverlay.addEventListener("dragleave", (e) => {
      e.preventDefault();
      el.dragDropOverlay.classList.add("hidden");
    });
    el.dragDropOverlay.addEventListener("drop", (e) => {
      e.preventDefault();
      el.dragDropOverlay.classList.add("hidden");
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        stageFile(e.dataTransfer.files[0]);
      }
    });

    // Copy network address on badge click
    el.networkBadge.onclick = () => {
      const urlToCopy = el.networkAddressText.dataset.fullUrl || `http://${el.networkAddressText.textContent}`;
      copyToClipboard(urlToCopy);
      const original = el.networkAddressText.textContent;
      el.networkAddressText.textContent = "Copied URL!";
      setTimeout(() => (el.networkAddressText.textContent = original), 1500);
    };

    // Mobile slide-over drawer sidebar controls
    if (el.mobileSidebarToggleBtn) {
      el.mobileSidebarToggleBtn.onclick = (e) => {
        e.stopPropagation();
        openMobileSidebar();
      };
    }
    if (el.mobileSidebarCloseBtn) {
      el.mobileSidebarCloseBtn.onclick = (e) => {
        e.stopPropagation();
        closeMobileSidebar();
      };
    }
    if (el.sidebarBackdrop) {
      el.sidebarBackdrop.onclick = () => {
        closeMobileSidebar();
      };
    }

    // Global Key Shortcuts
    globalThis.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        el.settingsModal.classList.add("hidden");
        el.directConnectModal.classList.add("hidden");
        el.subnetScanModal.classList.add("hidden");
        el.imageLightbox.classList.add("hidden");
        el.helpModal.classList.add("hidden");
        el.emojiPopover.classList.add("hidden");
        if (!el.searchBarContainer.classList.contains("hidden")) {
          el.searchBarContainer.classList.add("hidden");
          state.searchQuery = "";
          renderMessages();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        el.toggleSearchBtn.click();
      }
    });
  }

  // App Initialization
  function init() {
    restoreLocalData();
    setupEventListeners();
    connectWebSocket();

    // Mobile View Setup
    if (globalThis.innerWidth <= 768) {
      setMobileView("sidebar");
    } else {
      el.appContainer.classList.remove("mobile-sidebar-view", "mobile-chat-view");
    }

    globalThis.addEventListener("resize", () => {
      if (globalThis.innerWidth > 768) {
        el.appContainer.classList.remove("mobile-sidebar-view", "mobile-chat-view");
      } else {
        if (!el.appContainer.classList.contains("mobile-chat-view") && !el.appContainer.classList.contains("mobile-sidebar-view")) {
          setMobileView("sidebar");
        }
      }
    });

    // Touch devices: tap on a message to toggle reaction action bar
    document.addEventListener("click", (e) => {
      const row = e.target.closest(".message-row");
      document.querySelectorAll(".message-row.active-row").forEach((r) => {
        if (r !== row) r.classList.remove("active-row");
      });
      if (row && !e.target.closest(".action-bar-btn")) {
        row.classList.toggle("active-row");
      }
    });
  }

  globalThis.addEventListener("DOMContentLoaded", init);
})();
