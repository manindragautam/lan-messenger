/**
 * LAN Messenger - Deno Desktop Application
 * Powered by Deno 2.9 (deno desktop)
 *
 * Zero external package dependencies - pure Deno runtime.
 * Provides real-time peer discovery via UDP broadcast and direct LAN HTTP/WebSocket messaging.
 */

import dgram from "node:dgram";
import { Buffer } from "node:buffer";

// Types
export interface PeerProfile {
  id: string;
  name: string;
  avatar: string;
  status: "online" | "away" | "busy" | "offline";
  statusMessage: string;
  lanPort: number;
  ips: string[];
  mdnsHost?: string;
  mdnsUrl?: string;
  lastSeen?: number;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  senderId: string;
  senderName: string;
  senderAvatar: string;
  content: string;
  type: "text" | "file" | "image" | "audio" | "system";
  timestamp: number;
  fileInfo?: {
    id: string;
    name: string;
    size: number;
    mimeType: string;
    dataUrl?: string;
  };
  reactions?: Record<string, string[]>;
}

// Global Application State
const DISCOVERY_UDP_PORT = 45450;
const DEFAULT_LAN_HTTP_PORT = 4545;
const PEER_TIMEOUT_MS = 14000; // mark offline after 14s of silence

// Generate or restore peer ID
const myPeerId = crypto.randomUUID();
let myDisplayName = "DenoUser-" + myPeerId.slice(0, 4).toUpperCase();
let myAvatar = "🦕";
let myStatus: "online" | "away" | "busy" | "offline" = "online";
let myStatusMessage = "Chatting on LAN via Deno Desktop";

// In-memory peer directory
const discoveredPeers = new Map<string, PeerProfile>();

// In-memory shared files cache (id -> { name, size, mimeType, data: Uint8Array })
const sharedFiles = new Map<string, { name: string; size: number; mimeType: string; data: Uint8Array }>();

// Connected client sessions (Desktop webview + any remote web browsers)
export interface ClientSession {
  ws: WebSocket;
  id: string;
  name: string;
  avatar: string;
  status: "online" | "away" | "busy" | "offline";
  statusMessage: string;
  isHost: boolean;
  lastSeen: number;
}

const clientSessions = new Map<WebSocket, ClientSession>();

// Local network interface discovery
function getLocalIPv4Addresses(): { address: string; netmask: string; broadcast: string }[] {
  const results: { address: string; netmask: string; broadcast: string }[] = [];
  try {
    const interfaces = Deno.networkInterfaces();
    for (const iface of interfaces) {
      if (iface.family === "IPv4" && iface.address !== "127.0.0.1" && !iface.address.startsWith("169.254")) {
        const netmask = iface.netmask || "255.255.255.0";
        const broadcast = calculateBroadcast(iface.address, netmask);
        results.push({ address: iface.address, netmask, broadcast });
      }
    }
  } catch (err) {
    console.warn("[Network] Could not query network interfaces:", err);
  }
  return results;
}

function calculateBroadcast(ip: string, netmask: string): string {
  try {
    const ipParts = ip.split(".").map(Number);
    const maskParts = netmask.split(".").map(Number);
    if (ipParts.length !== 4 || maskParts.length !== 4) return "255.255.255.255";
    const broadcastParts = ipParts.map((part, i) => (part | (~maskParts[i] & 255)));
    return broadcastParts.join(".");
  } catch {
    return "255.255.255.255";
  }
}

// Find a free TCP port for LAN listening
function findFreePort(startPort: number): number {
  for (let port = startPort; port < startPort + 50; port++) {
    try {
      const listener = Deno.listen({ port, hostname: "0.0.0.0" });
      listener.close();
      return port;
    } catch {
      // Port in use, continue search
    }
  }
  // Fallback to random free port
  const listener = Deno.listen({ port: 0, hostname: "0.0.0.0" });
  const addr = listener.addr as Deno.NetAddr;
  const freePort = addr.port;
  listener.close();
  return freePort;
}

// Broadcast updates to all connected local desktop & webview clients
function notifyLocalUI(event: { type: string; payload: unknown }, excludeWs?: WebSocket) {
  const json = JSON.stringify(event);
  for (const [ws] of clientSessions.entries()) {
    if (excludeWs && ws === excludeWs) continue;
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    } catch {
      clientSessions.delete(ws);
    }
  }
}

// Helper to get mDNS host name for this device
function getMdnsHost(): { host: string; rawName: string } {
  try {
    const raw = Deno.hostname();
    const host = raw.endsWith(".local") ? raw : `${raw}.local`;
    return { host, rawName: raw };
  } catch {
    return { host: "localhost", rawName: "localhost" };
  }
}

// Assemble local profile
function getMyProfile(lanPort: number): PeerProfile {
  const ifaces = getLocalIPv4Addresses();
  const ips = ifaces.map((i) => i.address);
  if (ips.length === 0) ips.push("127.0.0.1");

  const { host: mdnsHost } = getMdnsHost();
  const mdnsUrl = `http://${mdnsHost}:${lanPort}`;

  return {
    id: myPeerId,
    name: myDisplayName,
    avatar: myAvatar,
    status: myStatus,
    statusMessage: myStatusMessage,
    lanPort,
    ips,
    mdnsHost,
    mdnsUrl,
  };
}

// Main application runner
function main() {
  console.log("🦕 Starting Deno Desktop LAN Messenger...");

  // 1. Determine LAN Port (support PORT env variable and --port CLI argument)
  let preferredPort = DEFAULT_LAN_HTTP_PORT;
  const envPort = Deno.env.get("PORT");
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0) preferredPort = parsed;
  }
  for (let i = 0; i < Deno.args.length; i++) {
    if (Deno.args[i] === "--port" && Deno.args[i + 1]) {
      const parsed = parseInt(Deno.args[i + 1], 10);
      if (!isNaN(parsed) && parsed > 0) preferredPort = parsed;
    } else if (Deno.args[i].startsWith("--port=")) {
      const parsed = parseInt(Deno.args[i].split("=")[1], 10);
      if (!isNaN(parsed) && parsed > 0) preferredPort = parsed;
    }
  }

  const lanPort = findFreePort(preferredPort);
  const { host: mdnsHost, rawName: rawDeviceName } = getMdnsHost();
  const mdnsUrl = `http://${mdnsHost}:${lanPort}`;

  console.log(`[LAN] Local Peer Server listening on port: ${lanPort}`);
  console.log(`[mDNS] Device hostname: ${mdnsHost}`);
  console.log(`[mDNS] Direct access URL: ${mdnsUrl}`);

  const localInterfaces = getLocalIPv4Addresses();
  console.log(`[LAN] Detected IPv4 addresses:`, localInterfaces.map((i) => `${i.address} (bcast: ${i.broadcast})`));

  // 2. Set up UDP Broadcast Discovery
  let udpSocket: dgram.Socket | null = null;
  try {
    udpSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });

    udpSocket.on("error", (err) => {
      console.warn("[UDP] Discovery socket error (non-fatal):", err.message);
    });

    udpSocket.on("message", (msgBuffer, rinfo) => {
      try {
        const text = msgBuffer.toString("utf-8");
        const data = JSON.parse(text);

        if (data.type === "ANNOUNCE" || data.type === "HELLO") {
          const peer = data.peer as PeerProfile;
          if (!peer || peer.id === myPeerId) return;

          // Prefer remote IP if reported IP doesn't match
          if (!peer.ips || peer.ips.length === 0 || !peer.ips.includes(rinfo.address)) {
            peer.ips = [rinfo.address, ...(peer.ips || [])];
          }

          const isNew = !discoveredPeers.has(peer.id);
          peer.lastSeen = Date.now();
          discoveredPeers.set(peer.id, peer);

          if (isNew) {
            console.log(`[Discovery] New peer discovered: ${peer.name} (${peer.ips[0]}:${peer.lanPort})`);
            // If peer sent HELLO, send immediate announcement back
            if (data.type === "HELLO" && udpSocket) {
              sendAnnouncement(udpSocket, lanPort, "ANNOUNCE", rinfo.address);
            }
          }

          notifyLocalUI({
            type: "PEER_UPDATE",
            payload: { peers: Array.from(discoveredPeers.values()) },
          });
        } else if (data.type === "BYE") {
          const peerId = data.peerId;
          if (peerId && discoveredPeers.has(peerId)) {
            const peer = discoveredPeers.get(peerId)!;
            peer.status = "offline";
            peer.lastSeen = Date.now();
            console.log(`[Discovery] Peer disconnected: ${peer.name}`);
            notifyLocalUI({
              type: "PEER_UPDATE",
              payload: { peers: Array.from(discoveredPeers.values()) },
            });
          }
        }
      } catch {
        // Ignore malformed packets
      }
    });

    const currentSocket = udpSocket;
    udpSocket.bind(DISCOVERY_UDP_PORT, () => {
      try {
        currentSocket.setBroadcast(true);
        console.log(`[UDP] Discovery listening on 0.0.0.0:${DISCOVERY_UDP_PORT}`);
        // Initial HELLO broadcast
        sendAnnouncement(currentSocket, lanPort, "HELLO");
      } catch (err) {
        console.warn("[UDP] Failed to set broadcast flag:", err);
      }
    });
  } catch (err) {
    console.warn("[UDP] UDP Socket initialization failed (falling back to HTTP discovery):", err);
  }

  // Periodic announcement (every 4 seconds)
  setInterval(() => {
    if (udpSocket) {
      sendAnnouncement(udpSocket, lanPort, "ANNOUNCE");
    }

    // Check for offline peers
    const now = Date.now();
    let hasChanged = false;
    for (const peer of discoveredPeers.values()) {
      if (peer.status !== "offline" && peer.lastSeen && now - peer.lastSeen > PEER_TIMEOUT_MS) {
        peer.status = "offline";
        hasChanged = true;
      }
    }
    if (hasChanged) {
      notifyLocalUI({
        type: "PEER_UPDATE",
        payload: { peers: Array.from(discoveredPeers.values()) },
      });
    }
  }, 4000);

  function sendAnnouncement(sock: dgram.Socket, port: number, type: "ANNOUNCE" | "HELLO", directHost?: string) {
    try {
      const payload = JSON.stringify({
        type,
        peer: getMyProfile(port),
      });
      const buffer = Buffer.from(payload);

      if (directHost) {
        sock.send(buffer, DISCOVERY_UDP_PORT, directHost);
        return;
      }

      // Broadcast to all local subnet broadcast addresses and general broadcast
      const targets = new Set<string>(["255.255.255.255", "127.0.0.1"]);
      for (const iface of getLocalIPv4Addresses()) {
        if (iface.broadcast) targets.add(iface.broadcast);
      }

      for (const target of targets) {
        sock.send(buffer, DISCOVERY_UDP_PORT, target, (err) => {
          if (err && (err as { code?: string }).code !== "EPERM") {
            // Silently ignore expected broadcast restrictions
          }
        });
      }
    } catch {
      // Ignore broadcast errors
    }
  }

  // 3. Request Handler for UI & LAN Peer Endpoints
  async function handleHttpRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // CORS Headers for LAN communication
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // --- Webview & Web Client WebSocket ---
    if (url.pathname === "/ws") {
      if (req.headers.get("upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 400 });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);

      socket.onopen = () => {
        // Will complete registration upon receiving CLIENT_HELLO
      };

      socket.onmessage = async (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "CLIENT_HELLO") {
            const payload = (msg.payload || {}) as Record<string, unknown>;
            const isActuallyHost = Boolean(payload.isHost);
            const clientId = isActuallyHost ? myPeerId : String(payload.id || ("web_" + crypto.randomUUID().slice(0, 8)));
            const clientName = String(payload.name || (isActuallyHost ? myDisplayName : ("WebUser-" + clientId.slice(-4))));
            const clientAvatar = String(payload.avatar || (isActuallyHost ? myAvatar : "🌐"));
            const clientStatus = (payload.status || "online") as "online" | "away" | "busy" | "offline";
            const clientStatusMsg = String(payload.statusMessage || (isActuallyHost ? myStatusMessage : "Connected via Web Browser"));

            const session: ClientSession = {
              ws: socket,
              id: clientId,
              name: clientName,
              avatar: clientAvatar,
              status: clientStatus,
              statusMessage: clientStatusMsg,
              isHost: isActuallyHost,
              lastSeen: Date.now(),
            };
            clientSessions.set(socket, session);

            // If it's a non-host web client, register as peer so desktop app and others see them!
            if (!isActuallyHost) {
              discoveredPeers.set(session.id, {
                id: session.id,
                name: session.name,
                avatar: session.avatar,
                status: session.status,
                statusMessage: session.statusMessage,
                lanPort,
                ips: getLocalIPv4Addresses().map((i) => i.address),
                lastSeen: Date.now(),
              });
            }

            // Build peer list visible to this client
            const peersForClient = Array.from(discoveredPeers.values()).filter((p) => p.id !== session.id);
            // If this client is a web client, ensure the desktop host is included in their peers list
            if (!isActuallyHost && !peersForClient.some((p) => p.id === myPeerId)) {
              peersForClient.unshift(getMyProfile(lanPort));
            }

            socket.send(
              JSON.stringify({
                type: "INIT",
                payload: {
                  me: {
                    id: session.id,
                    name: session.name,
                    avatar: session.avatar,
                    status: session.status,
                    statusMessage: session.statusMessage,
                    lanPort,
                    ips: getLocalIPv4Addresses().map((i) => i.address),
                    isHost: isActuallyHost,
                  },
                  peers: peersForClient,
                },
              }),
            );

            // Notify all other clients of updated peer roster
            notifyLocalUI({
              type: "PEER_UPDATE",
              payload: { peers: Array.from(discoveredPeers.values()) },
            }, socket);
            return;
          }

          const session = clientSessions.get(socket);
          await handleLocalUiMessage(msg, lanPort, socket, session);
        } catch (err) {
          console.error("[WS] Error handling message:", err);
        }
      };

      socket.onclose = () => {
        const session = clientSessions.get(socket);
        clientSessions.delete(socket);
        if (session && !session.isHost) {
          const p = discoveredPeers.get(session.id);
          if (p) {
            p.status = "offline";
            p.lastSeen = Date.now();
          }
          notifyLocalUI({
            type: "PEER_UPDATE",
            payload: { peers: Array.from(discoveredPeers.values()) },
          });
        }
      };

      return response;
    }

    // --- Peer-to-Peer LAN API ---

    // 1. Peer info / Ping
    if (url.pathname === "/api/info" && req.method === "GET") {
      return Response.json(getMyProfile(lanPort), { headers: corsHeaders });
    }

    // 2. Incoming message from a peer
    if (url.pathname === "/api/peer/message" && req.method === "POST") {
      try {
        const body: ChatMessage = await req.json();

        // Update sender last seen
        if (body.senderId && discoveredPeers.has(body.senderId)) {
          const p = discoveredPeers.get(body.senderId)!;
          p.lastSeen = Date.now();
          p.status = "online";
        }

        // Deliver message to desktop UI
        notifyLocalUI({
          type: "INCOMING_MESSAGE",
          payload: body,
        });

        return Response.json({ ok: true, messageId: body.id }, { headers: corsHeaders });
      } catch (err) {
        return Response.json({ ok: false, error: String(err) }, { status: 400, headers: corsHeaders });
      }
    }

    // 3. Incoming typing notification from a peer
    if (url.pathname === "/api/peer/typing" && req.method === "POST") {
      try {
        const body = await req.json();
        notifyLocalUI({
          type: "PEER_TYPING",
          payload: body,
        });
        return Response.json({ ok: true }, { headers: corsHeaders });
      } catch {
        return Response.json({ ok: false }, { status: 400, headers: corsHeaders });
      }
    }

    // 4. Incoming reaction from a peer
    if (url.pathname === "/api/peer/reaction" && req.method === "POST") {
      try {
        const body = await req.json();
        notifyLocalUI({
          type: "PEER_REACTION",
          payload: body,
        });
        return Response.json({ ok: true }, { headers: corsHeaders });
      } catch {
        return Response.json({ ok: false }, { status: 400, headers: corsHeaders });
      }
    }

    // 5. File upload / transfer endpoint
    if (url.pathname === "/api/peer/file" && req.method === "POST") {
      try {
        const body = await req.json();
        const { id, name, mimeType, dataBase64 } = body;
        if (!id || !dataBase64) {
          return Response.json({ ok: false, error: "Missing data" }, { status: 400, headers: corsHeaders });
        }

        // Decode base64
        const binaryString = atob(dataBase64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        sharedFiles.set(id, {
          name: name || "file",
          size: bytes.byteLength,
          mimeType: mimeType || "application/octet-stream",
          data: bytes,
        });

        return Response.json({ ok: true, fileId: id }, { headers: corsHeaders });
      } catch (err) {
        return Response.json({ ok: false, error: String(err) }, { status: 500, headers: corsHeaders });
      }
    }

    // 6. File download endpoint
    if (url.pathname.startsWith("/api/peer/file/") && req.method === "GET") {
      const fileId = url.pathname.replace("/api/peer/file/", "");
      const file = sharedFiles.get(fileId);
      if (!file) {
        return new Response("File not found or expired", { status: 404, headers: corsHeaders });
      }

      return new Response(file.data as unknown as BodyInit, {
        headers: {
          ...corsHeaders,
          "Content-Type": file.mimeType,
          "Content-Length": String(file.size),
          "Content-Disposition": `inline; filename="${encodeURIComponent(file.name)}"`,
        },
      });
    }

    // 7. Manual subnet scan trigger from UI
    if (url.pathname === "/api/scan" && req.method === "POST") {
      const peersFound = await performSubnetScan(lanPort);
      return Response.json({ ok: true, found: peersFound }, { headers: corsHeaders });
    }

    // --- Static Frontend Files Serving ---
    let filePath = url.pathname;
    if (filePath === "/" || filePath === "") filePath = "/index.html";

    try {
      const fileUrl = new URL(`.${filePath}`, import.meta.url);
      let content: Uint8Array;
      try {
        content = await Deno.readFile(fileUrl);
      } catch {
        content = await Deno.readFile(`.${filePath}`);
      }
      let contentType = "text/plain";
      if (filePath.endsWith(".html")) contentType = "text/html; charset=utf-8";
      else if (filePath.endsWith(".css")) contentType = "text/css; charset=utf-8";
      else if (filePath.endsWith(".js")) contentType = "application/javascript; charset=utf-8";
      else if (filePath.endsWith(".json")) contentType = "application/json";
      else if (filePath.endsWith(".svg")) contentType = "image/svg+xml";
      else if (filePath.endsWith(".png")) contentType = "image/png";

      return new Response(content as unknown as BodyInit, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "no-cache",
        },
      });
    } catch {
      // Fallback for SPA routing
      try {
        const fallback = await Deno.readFile(new URL("./index.html", import.meta.url));
        return new Response(fallback as unknown as BodyInit, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      } catch (_err) {
        return new Response(`Not Found: ${url.pathname}`, { status: 404 });
      }
    }
  }

  // Handle messages sent from the local Webview UI or connected Web Clients
  async function handleLocalUiMessage(
    msg: { type: string; payload: Record<string, unknown> },
    currentLanPort: number,
    senderWs: WebSocket,
    session?: ClientSession,
  ) {
    const senderId = session ? session.id : myPeerId;
    const senderName = session ? session.name : myDisplayName;
    const senderAvatar = session ? session.avatar : myAvatar;

    if (msg.type === "UPDATE_PROFILE") {
      const { name, avatar, status, statusMessage } = msg.payload as {
        name?: string;
        avatar?: string;
        status?: "online" | "away" | "busy" | "offline";
        statusMessage?: string;
      };

      if (session) {
        if (name) session.name = name.trim();
        if (avatar) session.avatar = avatar;
        if (status) session.status = status;
        if (statusMessage !== undefined) session.statusMessage = statusMessage.trim();

        if (session.isHost) {
          myDisplayName = session.name;
          myAvatar = session.avatar;
          myStatus = session.status;
          myStatusMessage = session.statusMessage;
          if (udpSocket) {
            sendAnnouncement(udpSocket, currentLanPort, "ANNOUNCE");
          }
        } else {
          // Update in discovered peers directory
          const p = discoveredPeers.get(session.id);
          if (p) {
            p.name = session.name;
            p.avatar = session.avatar;
            p.status = session.status;
            p.statusMessage = session.statusMessage;
          }
          notifyLocalUI({
            type: "PEER_UPDATE",
            payload: { peers: Array.from(discoveredPeers.values()) },
          });
        }

        senderWs.send(
          JSON.stringify({
            type: "PROFILE_UPDATED",
            payload: {
              id: session.id,
              name: session.name,
              avatar: session.avatar,
              status: session.status,
              statusMessage: session.statusMessage,
              lanPort: currentLanPort,
              ips: getLocalIPv4Addresses().map((i) => i.address),
            },
          }),
        );
      }
    } else if (msg.type === "SEND_MESSAGE") {
      const message = msg.payload as unknown as ChatMessage;
      message.senderId = senderId;
      message.senderName = senderName;
      message.senderAvatar = senderAvatar;
      message.timestamp = Date.now();

      // If file included, cache it locally so peers can download it
      if (message.fileInfo && message.fileInfo.dataUrl) {
        try {
          const dataUrl = message.fileInfo.dataUrl;
          const commaIndex = dataUrl.indexOf(",");
          if (commaIndex > -1) {
            const base64 = dataUrl.slice(commaIndex + 1);
            const binaryString = atob(base64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            sharedFiles.set(message.fileInfo.id, {
              name: message.fileInfo.name,
              size: message.fileInfo.size,
              mimeType: message.fileInfo.mimeType,
              data: bytes,
            });
          }
        } catch (e) {
          console.warn("[File] Could not cache file data:", e);
        }
      }

      // 1. Echo back to sender
      senderWs.send(
        JSON.stringify({
          type: "MESSAGE_SENT",
          payload: message,
        }),
      );

      // 2. Deliver to all other connected local clients (Desktop app or other web browser tabs)
      for (const [wsClient, client] of clientSessions.entries()) {
        if (wsClient !== senderWs && wsClient.readyState === WebSocket.OPEN) {
          const isPublic =
            message.channelId.startsWith("#") ||
            message.channelId === "general" ||
            message.channelId === "random" ||
            message.channelId === "announcements";

          const isDirectMatch =
            message.channelId === client.id ||
            (client.isHost && (message.channelId === myPeerId || message.channelId === "host"));

          if (isPublic || isDirectMatch) {
            wsClient.send(
              JSON.stringify({
                type: "INCOMING_MESSAGE",
                payload: message,
              }),
            );
          }
        }
      }

      // 3. Deliver to remote LAN peer instances (other computers running LAN Messenger)
      const isPublic =
        message.channelId.startsWith("#") ||
        message.channelId === "general" ||
        message.channelId === "random" ||
        message.channelId === "announcements";

      if (isPublic) {
        for (const peer of discoveredPeers.values()) {
          const isLocalSession = Array.from(clientSessions.values()).some((c) => c.id === peer.id);
          if (peer.id !== myPeerId && !isLocalSession && peer.status !== "offline") {
            sendPeerHttpRequest(peer, "/api/peer/message", message).catch(() => {});
          }
        }
      } else {
        const isLocalSession = Array.from(clientSessions.values()).some((c) => c.id === message.channelId);
        if (!isLocalSession && message.channelId !== myPeerId && message.channelId !== "host") {
          const targetPeer = discoveredPeers.get(message.channelId);
          if (targetPeer) {
            sendPeerHttpRequest(targetPeer, "/api/peer/message", message).catch((err) => {
              console.warn(`[Send] Failed to deliver direct message to ${targetPeer.name}:`, err);
            });
          }
        }
      }
    } else if (msg.type === "SEND_TYPING") {
      const channelId = String(msg.payload.channelId || "general");
      const isTyping = Boolean(msg.payload.isTyping);
      const typingPayload = {
        peerId: senderId,
        peerName: senderName,
        channelId,
        isTyping,
      };

      // Deliver to other local clients
      for (const [wsClient] of clientSessions.entries()) {
        if (wsClient !== senderWs && wsClient.readyState === WebSocket.OPEN) {
          wsClient.send(
            JSON.stringify({
              type: "PEER_TYPING",
              payload: typingPayload,
            }),
          );
        }
      }

      // Deliver to remote LAN peers
      const isPublicTyping =
        channelId.startsWith("#") ||
        channelId === "general" ||
        channelId === "random" ||
        channelId === "announcements";

      if (isPublicTyping) {
        for (const peer of discoveredPeers.values()) {
          const isLocalSession = Array.from(clientSessions.values()).some((c) => c.id === peer.id);
          if (peer.id !== myPeerId && !isLocalSession && peer.status !== "offline") {
            sendPeerHttpRequest(peer, "/api/peer/typing", typingPayload).catch(() => {});
          }
        }
      } else {
        const isLocalSession = Array.from(clientSessions.values()).some((c) => c.id === channelId);
        if (!isLocalSession && channelId !== myPeerId && channelId !== "host") {
          const targetPeer = discoveredPeers.get(channelId);
          if (targetPeer) {
            sendPeerHttpRequest(targetPeer, "/api/peer/typing", typingPayload).catch(() => {});
          }
        }
      }
    } else if (msg.type === "SEND_REACTION") {
      const reactionPayload = {
        ...msg.payload,
        peerId: senderId,
      };

      for (const [wsClient] of clientSessions.entries()) {
        if (wsClient !== senderWs && wsClient.readyState === WebSocket.OPEN) {
          wsClient.send(
            JSON.stringify({
              type: "PEER_REACTION",
              payload: reactionPayload,
            }),
          );
        }
      }

      for (const peer of discoveredPeers.values()) {
        const isLocalSession = Array.from(clientSessions.values()).some((c) => c.id === peer.id);
        if (peer.id !== myPeerId && !isLocalSession && peer.status !== "offline") {
          sendPeerHttpRequest(peer, "/api/peer/reaction", reactionPayload).catch(() => {});
        }
      }
    } else if (msg.type === "MANUAL_CONNECT") {
      const target = String(msg.payload.target || ""); // e.g. "192.168.1.50:4545" or "192.168.1.50"
      try {
        let host = target.trim();
        let port = DEFAULT_LAN_HTTP_PORT;
        if (host.includes(":")) {
          const parts = host.split(":");
          host = parts[0];
          port = parseInt(parts[1], 10) || DEFAULT_LAN_HTTP_PORT;
        }

        const res = await fetch(`http://${host}:${port}/api/info`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const peer: PeerProfile = await res.json();
          peer.lastSeen = Date.now();
          peer.status = "online";
          if (!peer.ips.includes(host)) peer.ips.unshift(host);
          discoveredPeers.set(peer.id, peer);

          notifyLocalUI({
            type: "PEER_UPDATE",
            payload: { peers: Array.from(discoveredPeers.values()) },
          });

          notifyLocalUI({
            type: "CONNECT_SUCCESS",
            payload: { peer },
          });
        } else {
          notifyLocalUI({
            type: "CONNECT_ERROR",
            payload: { error: `HTTP ${res.status}: Not a LAN Messenger peer` },
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        notifyLocalUI({
          type: "CONNECT_ERROR",
          payload: { error: `Connection failed: ${errMsg}` },
        });
      }
    } else if (msg.type === "START_SCAN") {
      const found = await performSubnetScan(currentLanPort);
      notifyLocalUI({
        type: "SCAN_COMPLETE",
        payload: { found, peers: Array.from(discoveredPeers.values()) },
      });
    }
  }

  // Active Subnet Scanner (fallback when UDP broadcast is blocked)
  async function performSubnetScan(currentLanPort: number): Promise<PeerProfile[]> {
    const interfaces = getLocalIPv4Addresses();
    const foundList: PeerProfile[] = [];

    for (const iface of interfaces) {
      const parts = iface.address.split(".");
      if (parts.length !== 4) continue;
      const baseSubnet = `${parts[0]}.${parts[1]}.${parts[2]}`;

      const promises: Promise<void>[] = [];

      // Scan ports 4545 to 4548 on common hosts (1 to 254)
      // Limit to 40 concurrent probes to avoid socket starvation
      for (let hostId = 1; hostId <= 254; hostId++) {
        const targetIp = `${baseSubnet}.${hostId}`;
        for (const portToTry of [DEFAULT_LAN_HTTP_PORT, DEFAULT_LAN_HTTP_PORT + 1, DEFAULT_LAN_HTTP_PORT + 2]) {
          if (targetIp === iface.address && portToTry === currentLanPort) continue;

          promises.push(
            (async () => {
              try {
                const res = await fetch(`http://${targetIp}:${portToTry}/api/info`, {
                  signal: AbortSignal.timeout(600),
                });
                if (res.ok) {
                  const peer: PeerProfile = await res.json();
                  if (peer && peer.id !== myPeerId) {
                    peer.lastSeen = Date.now();
                    peer.status = "online";
                    if (!peer.ips.includes(targetIp)) peer.ips.unshift(targetIp);
                    discoveredPeers.set(peer.id, peer);
                    foundList.push(peer);
                  }
                }
              } catch {
                // Ignore unreachable hosts
              }
            })(),
          );
        }
      }

      await Promise.allSettled(promises);
    }

    if (foundList.length > 0) {
      notifyLocalUI({
        type: "PEER_UPDATE",
        payload: { peers: Array.from(discoveredPeers.values()) },
      });
    }

    return foundList;
  }

  // HTTP Helper to send payload to a remote peer
  async function sendPeerHttpRequest(peer: PeerProfile, endpoint: string, body: unknown) {
    const targets = peer.ips.map((ip) => `http://${ip}:${peer.lanPort}${endpoint}`);
    let sent = false;

    for (const url of targets) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(3500),
        });
        if (res.ok) {
          sent = true;
          break;
        }
      } catch {
        // Try next IP
      }
    }

    if (!sent) {
      throw new Error(`Could not deliver to peer ${peer.name}`);
    }
  }

  // 4. Start Servers
  // In Deno Desktop mode, DENO_SERVE_ADDRESS is set and routes internal webviews to loopback.
  // We start the desktop server first, then remove DENO_SERVE_ADDRESS so our LAN server binds to 0.0.0.0!
  const desktopAddr = Deno.env.get("DENO_SERVE_ADDRESS");
  const denoGlobal = Deno as unknown as { BrowserWindow?: new (opts: Record<string, unknown>) => unknown };
  const hasBrowserWindow = typeof denoGlobal.BrowserWindow !== "undefined";
  const isDesktopMode = Boolean(desktopAddr) || hasBrowserWindow;

  let desktopServer: Deno.HttpServer | null = null;
  if (desktopAddr) {
    // Start desktop UI server for Deno Desktop internal webview
    desktopServer = Deno.serve(handleHttpRequest);
    console.log(`[Desktop] Internal UI webview connected to ${desktopAddr}`);
    // Remove DENO_SERVE_ADDRESS to prevent it from forcing secondary servers to loopback
    Deno.env.delete("DENO_SERVE_ADDRESS");
  }

  // Start public LAN Server on 0.0.0.0:lanPort so external network devices can access it!
  const lanServer = Deno.serve({ port: lanPort, hostname: "0.0.0.0" }, handleHttpRequest);

  // 5. Initialize Native Desktop Window if in Deno Desktop mode
  if (hasBrowserWindow && denoGlobal.BrowserWindow) {
    try {
      const _win = new denoGlobal.BrowserWindow({
        title: `LAN Messenger (${mdnsHost}) 🦕`,
        width: 1100,
        height: 760,
        minWidth: 850,
        minHeight: 580,
      });
      console.log("[Desktop] Initialized Deno.BrowserWindow successfully");
    } catch (err) {
      console.warn("[Desktop] BrowserWindow init note:", err);
    }
  }

  // 6. Register Bonjour / mDNS service advertisement (on macOS via dns-sd)
  let dnsSdProcess: Deno.ChildProcess | null = null;
  if (Deno.build.os === "darwin") {
    try {
      const cmd = new Deno.Command("dns-sd", {
        args: ["-R", `LAN Messenger (${rawDeviceName})`, "_http._tcp", "local", String(lanPort)],
        stdout: "null",
        stderr: "null",
      });
      dnsSdProcess = cmd.spawn();
      console.log(`[mDNS/Bonjour] Advertising mDNS service: ${mdnsUrl}`);
    } catch {
      // dns-sd not permitted or not present
    }
  }

  console.log(`\n======================================================`);
  console.log(`🚀 LAN Messenger is running!`);
  console.log(`🖥️  Desktop App Mode:    ${isDesktopMode ? "Active" : "Web fallback"}`);
  console.log(`🏷️  mDNS Device Address: ${mdnsUrl}`);
  for (const iface of localInterfaces) {
    console.log(`📱 LAN IPv4 Address:    http://${iface.address}:${lanPort}`);
  }
  console.log(`💻 Local Machine:       http://localhost:${lanPort}`);
  console.log(`📡 UDP Peer Discovery:  active on port ${DISCOVERY_UDP_PORT}`);
  console.log(`======================================================\n`);

  // Graceful shutdown handling
  const cleanup = () => {
    console.log("\n[Shutdown] Leaving LAN...");
    if (dnsSdProcess) {
      try {
        dnsSdProcess.kill();
      } catch {
        // Process already exited
      }
    }
    if (udpSocket) {
      try {
        const byePayload = JSON.stringify({ type: "BYE", peerId: myPeerId });
        udpSocket.send(Buffer.from(byePayload), DISCOVERY_UDP_PORT, "255.255.255.255");
        udpSocket.close();
      } catch {
        // Socket closed
      }
    }
    lanServer.shutdown();
    if (desktopServer) desktopServer.shutdown();
  };

  try {
    Deno.addSignalListener("SIGINT", () => {
      cleanup();
      Deno.exit(0);
    });
  } catch {
    // Signal handling not available in some environments
  }
}

// Execute
if (import.meta.main) {
  try {
    main();
  } catch (err) {
    console.error("Fatal startup error:", err);
  }
}
