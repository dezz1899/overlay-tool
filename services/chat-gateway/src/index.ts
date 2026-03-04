import "dotenv/config";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import type { RawData } from "ws";
import { createClient } from "@supabase/supabase-js";

const PORT = Number(process.env.PORT ?? 8080);

// ===== Supabase (server-only) =====
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const hasSupabase = !!SUPABASE_URL && !!SUPABASE_SERVICE_ROLE_KEY;
const supabase = hasSupabase ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null;

// ===== Twitch defaults =====
const TWITCH_DEFAULT_CHANNEL = String(process.env.TWITCH_DEFAULT_CHANNEL ?? "").trim().toLowerCase(); // optional
const POLL_MS = Math.max(3000, Number(process.env.TWITCH_POLL_MS ?? 8000)); // poll profile config for reconnect/channel change

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

const app = express();

app.get("/health", async (_req, res) => {
  let supabaseOk = false;
  let supabaseError: string | null = null;

  if (supabase) {
    const { error } = await supabase.from("profiles").select("id").limit(1);
    supabaseOk = !error;
    supabaseError = error ? (error.message || JSON.stringify(error)) : null;
  }

  res.json({ ok: true, hasSupabase, supabaseOk, supabaseError, twitchDefaultChannel: TWITCH_DEFAULT_CHANNEL || null });
});

const server = app.listen(PORT, () => {
  console.log(`[chat-gateway] listening on :${PORT}`);
});
server.on("error", (err) => console.error("[chat-gateway] server error", err));

// ============================
// ONE WS server + path routing
// ============================

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  try {
    const u = new URL(req.url ?? "", "http://localhost");
    const p = u.pathname;

    // only accept our ws paths
    if (p !== "/ws" && p !== "/ws/chat") {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket as any, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } catch {
    socket.destroy();
  }
});

wss.on("connection", async (socket, req) => {
  const u = new URL(req.url ?? "", "http://localhost");
  const p = u.pathname;

  // ---- /ws (debug hello/echo) ----
  if (p === "/ws") {
    sendJSON(socket as any, { type: "hello", ts: Date.now() });
    (socket as any).on("message", (raw: RawData) => {
      sendJSON(socket as any, { type: "echo", raw: raw.toString() });
    });
    return;
  }

  // ---- /ws/chat (twitch chat) ----
  if (p === "/ws/chat") {
    const profileId = String(u.searchParams.get("profileId") ?? "").trim();
    const key = String(u.searchParams.get("key") ?? "").trim();

    let channel = "";

    if (profileId) {
      const cfg = await fetchProfileConfig(profileId);
      if (!cfg) {
        sendJSON(socket as any, { type: "error", msg: "profile not found" });
        (socket as any).close();
        return;
      }

      if (!keyMatches(cfg, key)) {
        sendJSON(socket as any, { type: "error", msg: "forbidden (bad key)" });
        (socket as any).close();
        return;
      }

      channel = String(cfg.twitch_channel ?? "").trim().toLowerCase();
      if (!channel) {
        sendJSON(socket as any, { type: "error", msg: "no twitch_channel configured for this profile" });
        (socket as any).close();
        return;
      }

      const conn = ensureConn(channel);
      if (!conn) {
        sendJSON(socket as any, { type: "error", msg: "invalid channel" });
        (socket as any).close();
        return;
      }

      conn.clients.add(socket as any);
      conn.lastNonce = Number(cfg.twitch_reconnect_nonce ?? 0);
      await ensureProfilePolling(conn, profileId);

      sendJSON(socket as any, { type: "info", msg: `subscribed #${channel} (profile)` });

      (socket as any).on("close", () => {
        conn.clients.delete(socket as any);
        stopConnIfIdle(conn);
      });

      return;
    }

    // fallback mode (default channel)
    channel = TWITCH_DEFAULT_CHANNEL;
    if (!channel) {
      sendJSON(socket as any, { type: "error", msg: "no profileId/key and no TWITCH_DEFAULT_CHANNEL set" });
      (socket as any).close();
      return;
    }

    const conn = ensureConn(channel);
    if (!conn) {
      sendJSON(socket as any, { type: "error", msg: "invalid channel" });
      (socket as any).close();
      return;
    }

    conn.clients.add(socket as any);
    sendJSON(socket as any, { type: "info", msg: `subscribed #${channel} (default)` });

    (socket as any).on("close", () => {
      conn.clients.delete(socket as any);
      stopConnIfIdle(conn);
    });

    return;
  }

  // safety
  try {
    (socket as any).close();
  } catch { }
});

// ============================
// Twitch Chat WS (/ws/chat)
// ============================

type ProfileConfig = {
  profileId: string;
  twitch_channel: string | null;
  twitch_reconnect_nonce: number;
  view_key?: string | null;
  obs_view_key?: string | null;
};

async function fetchProfileConfig(profileId: string): Promise<ProfileConfig | null> {
  if (!supabase) return null;

  // select * to be resilient against schema naming differences
  const { data, error } = await supabase.from("profiles").select("*").eq("id", profileId).maybeSingle();
  if (error || !data) return null;

  return {
    profileId,
    twitch_channel: (data as any).twitch_channel ?? null,
    twitch_reconnect_nonce: Number((data as any).twitch_reconnect_nonce ?? 0),
    view_key: (data as any).view_key ?? (data as any).viewKey ?? null,
    obs_view_key: (data as any).obs_view_key ?? (data as any).obsViewKey ?? (data as any).key ?? null,
  };
}

function keyMatches(cfg: ProfileConfig, key: string) {
  const k = String(key || "");
  return !!k && (k === String(cfg.view_key ?? "") || k === String(cfg.obs_view_key ?? ""));
}

type TwitchConn = {
  channel: string;
  irc: WebSocket | null;
  buf: string;
  clients: Set<WebSocket>;
  connecting: boolean;
  closed: boolean;
  profileId?: string;
  lastNonce?: number;
  pollTimer?: NodeJS.Timeout;
};

const conns = new Map<string, TwitchConn>();

function sendJSON(ws: WebSocket, obj: any) {
  try {
    ws.send(JSON.stringify(obj));
  } catch { }
}

function broadcast(conn: TwitchConn, obj: any) {
  const msg = JSON.stringify(obj);
  for (const c of conn.clients) {
    try {
      c.send(msg);
    } catch { }
  }
}

function stopConnIfIdle(conn: TwitchConn) {
  if (conn.clients.size > 0) return;
  // no clients -> close IRC + stop polling
  try {
    conn.irc?.close();
  } catch { }
  conn.irc = null;

  if (conn.pollTimer) {
    clearInterval(conn.pollTimer);
    conn.pollTimer = undefined;
  }
}

function parseTags(tagStr: string) {
  const out: Record<string, string> = {};
  const parts = tagStr.split(";");
  for (const p of parts) {
    const [k, v] = p.split("=");
    out[k] = v ?? "";
  }
  return out;
}

function connectTwitch(conn: TwitchConn) {
  if (conn.connecting || conn.closed) return;
  conn.connecting = true;

  const url = "wss://irc-ws.chat.twitch.tv:443";
  const irc = new WebSocket(url);
  conn.irc = irc;
  conn.buf = "";

  const nick = `justinfan${Math.floor(10000 + Math.random() * 89999)}`;

  irc.onopen = () => {
    // tags/commands/membership gives display-name, color, etc.
    irc.send("CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership");
    irc.send("PASS SCHMOOPIIE");
    irc.send(`NICK ${nick}`);
    irc.send(`JOIN #${conn.channel}`);
    conn.connecting = false;

    broadcast(conn, { type: "info", msg: `connected to #${conn.channel}` });
  };

  irc.onmessage = (ev: any) => {
    const chunk = String(ev.data ?? "");
    conn.buf += chunk;

    const lines = conn.buf.split("\r\n");
    conn.buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line) continue;

      if (line.startsWith("PING ")) {
        // PING :tmi.twitch.tv
        const payload = line.slice(5);
        try {
          irc.send("PONG " + payload);
        } catch { }
        continue;
      }

      // We want PRIVMSG
      // Format: @tags :prefix PRIVMSG #channel :message
      let tags: Record<string, string> = {};
      let rest = line;

      if (rest.startsWith("@")) {
        const sp = rest.indexOf(" ");
        const tagStr = rest.slice(1, sp);
        tags = parseTags(tagStr);
        rest = rest.slice(sp + 1);
      }

      // prefix
      let prefix = "";
      if (rest.startsWith(":")) {
        const sp = rest.indexOf(" ");
        prefix = rest.slice(1, sp);
        rest = rest.slice(sp + 1);
      }

      if (!rest.includes("PRIVMSG")) continue;

      // Example: PRIVMSG #channel :hello
      const msgIdx = rest.indexOf(" :");
      if (msgIdx < 0) continue;

      const head = rest.slice(0, msgIdx);
      const text = rest.slice(msgIdx + 2);

      const headParts = head.split(" ");
      const cmd = headParts[0];
      if (cmd !== "PRIVMSG") continue;

      const display = tags["display-name"] || (prefix.split("!")[0] || "user");
      const color = tags["color"] || undefined;

      broadcast(conn, {
        type: "chat",
        id: uid(),
        user: display,
        text,
        color,
        ts: Date.now(),

        // ✅ wichtig für Twitch-Emotes (Positions im Text)
        emotes: tags["emotes"] || "",

        // (optional für später: badges)
        badges: tags["badges"] || "",
        badge_info: tags["badge-info"] || "",
        user_id: tags["user-id"] || "",
        room_id: tags["room-id"] || "",
      });
    }
  };

  irc.onerror = () => {
    broadcast(conn, { type: "warn", msg: "twitch connection error" });
  };

  irc.onclose = () => {
    broadcast(conn, { type: "warn", msg: "twitch disconnected, retrying..." });
    conn.irc = null;
    conn.connecting = false;

    // retry if still has clients
    if (!conn.closed && conn.clients.size > 0) {
      setTimeout(() => connectTwitch(conn), 1500);
    }
  };
}

function ensureConn(channel: string) {
  const ch = channel.trim().toLowerCase().replace(/^#/, "");
  if (!ch) return null;

  let conn = conns.get(ch);
  if (!conn) {
    conn = {
      channel: ch,
      irc: null,
      buf: "",
      clients: new Set<WebSocket>(),
      connecting: false,
      closed: false,
    };
    conns.set(ch, conn);
  }

  if (!conn.irc && !conn.connecting) {
    connectTwitch(conn);
  }

  return conn;
}

async function ensureProfilePolling(conn: TwitchConn, profileId: string) {
  if (!supabase) return;
  conn.profileId = profileId;

  if (conn.pollTimer) return;

  conn.pollTimer = setInterval(async () => {
    if (!conn.profileId) return;
    if (conn.clients.size === 0) return;

    const cfg = await fetchProfileConfig(conn.profileId);
    if (!cfg) return;

    const nextCh = String(cfg.twitch_channel ?? "").trim().toLowerCase();
    const nextNonce = Number(cfg.twitch_reconnect_nonce ?? 0);

    // channel changed
    if (nextCh && nextCh !== conn.channel) {
      broadcast(conn, { type: "info", msg: `channel changed -> #${nextCh}` });

      // move clients to new connection
      const newConn = ensureConn(nextCh);
      if (!newConn) return;

      // transfer clients
      for (const c of conn.clients) {
        newConn.clients.add(c);
        sendJSON(c, { type: "info", msg: `switched to #${nextCh}` });
      }
      conn.clients.clear();

      stopConnIfIdle(conn);
      return;
    }

    // reconnect marker changed
    if (conn.lastNonce === undefined) conn.lastNonce = nextNonce;
    if (nextNonce !== conn.lastNonce) {
      conn.lastNonce = nextNonce;
      broadcast(conn, { type: "info", msg: "reconnect triggered" });
      try {
        conn.irc?.close();
      } catch { }
    }
  }, POLL_MS);
}

