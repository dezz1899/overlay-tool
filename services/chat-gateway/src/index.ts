import "dotenv/config";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import type { RawData } from "ws";
import { createClient } from "@supabase/supabase-js";

console.log("[chat-gateway] ASSETS BUILD ACTIVE");

const PORT = Number(process.env.PORT ?? 8080);

// ===== Supabase (server-only) =====
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const hasSupabase = !!SUPABASE_URL && !!SUPABASE_SERVICE_ROLE_KEY;
const supabase = hasSupabase ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null;

// ===== Twitch defaults =====
const TWITCH_DEFAULT_CHANNEL = String(process.env.TWITCH_DEFAULT_CHANNEL ?? "").trim().toLowerCase(); // optional
const POLL_MS = Math.max(3000, Number(process.env.TWITCH_POLL_MS ?? 8000)); // reconnect/channel change polling
const ASSET_TTL_MS = Math.max(60_000, Number(process.env.ASSET_TTL_MS ?? 10 * 60 * 1000)); // 10min default
const UA = "overlay-tool-chat-gateway/1.0";

// ---------- types ----------
type Roleless = any;

type ProfileConfig = {
  profileId: string;
  twitch_channel: string | null;
  twitch_reconnect_nonce: number;
  view_key?: string | null;
  obs_view_key?: string | null;
};

type ExtProvider = "bttv" | "ffz" | "7tv";
type EmoteEntry = { url: string; provider: ExtProvider };
type EmoteMap = Record<string, EmoteEntry>;
type BadgeMap = Record<string, string>; // "set/version" -> image_url_2x

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

  twitchId?: string; // twitch channel id (room-id)
  assets?: EmoteMap;
  assetsLoadedAt?: number;
  assetsLoading?: boolean;
};

// ---------- helpers ----------
function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

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

function httpsify(u: string) {
  if (!u) return "";
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("http://")) return "https://" + u.slice("http://".length);
  if (u.startsWith("https://")) return u;
  return "https://" + u;
}

async function httpJson(url: string) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`fetch failed ${res.status} ${url}`);
  return res.json();
}

function parseBadgeSetsToMap(j: any): BadgeMap {
  // badges.twitch.tv returns { badge_sets: { set: { versions: { "1": { image_url_2x ... } } } } }
  const out: BadgeMap = {};
  const sets = j?.badge_sets ?? {};
  for (const [setName, setObj] of Object.entries<any>(sets)) {
    const versions = setObj?.versions ?? {};
    for (const [ver, vObj] of Object.entries<any>(versions)) {
      const url = String(vObj?.image_url_2x ?? vObj?.image_url_1x ?? "");
      if (!url) continue;
      out[`${setName}/${ver}`] = url;
    }
  }
  return out;
}

async function loadGlobalBadges(): Promise<BadgeMap> {
  const j: any = await httpJson("https://badges.twitch.tv/v1/badges/global/display?language=en");
  return parseBadgeSetsToMap(j);
}

async function loadChannelBadges(roomId: string): Promise<BadgeMap> {
  const j: any = await httpJson(`https://badges.twitch.tv/v1/badges/channels/${encodeURIComponent(roomId)}/display?language=en`);
  return parseBadgeSetsToMap(j);
}

async function ensureBadgesForChannel(channel: string, roomId?: string): Promise<BadgeMap> {
  const now = Date.now();

  // global cache
  if (!globalBadges.loadedAt || now - globalBadges.loadedAt >= ASSET_TTL_MS) {
    try {
      globalBadges.map = await loadGlobalBadges();
      globalBadges.loadedAt = now;
    } catch {
      // keep old cache on failure
    }
  }

  // channel cache (optional, needs roomId)
  let chMap: BadgeMap = {};
  const cached = channelBadges.get(channel);
  if (roomId) {
    if (cached?.loadedAt && now - cached.loadedAt < ASSET_TTL_MS && cached.roomId === roomId) {
      chMap = cached.map;
    } else {
      try {
        chMap = await loadChannelBadges(roomId);
        channelBadges.set(channel, { loadedAt: now, map: chMap, roomId });
      } catch {
        // keep old if present
        if (cached?.map) chMap = cached.map;
      }
    }
  }

  // merge: channel overrides global
  return { ...globalBadges.map, ...chMap };
}

async function fetchProfileConfig(profileId: string): Promise<ProfileConfig | null> {
  if (!supabase) return null;

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

// ---------- assets cache ----------
const globalAssets: { loadedAt: number; map: EmoteMap } = { loadedAt: 0, map: {} };
const channelAssets = new Map<string, { loadedAt: number; map: EmoteMap; twitchId?: string }>();
const globalBadges: { loadedAt: number; map: BadgeMap } = { loadedAt: 0, map: {} };
const channelBadges = new Map<string, { loadedAt: number; map: BadgeMap; roomId?: string }>();

function mergeEmotes(into: EmoteMap, from: EmoteMap) {
  for (const [code, v] of Object.entries(from)) {
    // channel emotes sollen global überschreiben -> wir lassen "from" gewinnen
    into[code] = v;
  }
}

async function loadBTTVGlobal(): Promise<EmoteMap> {
  // https://api.betterttv.net/3/cached/emotes/global :contentReference[oaicite:3]{index=3}
  const arr: any[] = await httpJson("https://api.betterttv.net/3/cached/emotes/global");
  const out: EmoteMap = {};
  for (const e of arr || []) {
    const code = String(e?.code ?? "").trim();
    const id = String(e?.id ?? "").trim();
    if (!code || !id) continue;
    out[code] = { provider: "bttv", url: `https://cdn.betterttv.net/emote/${id}/2x` };
  }
  return out;
}

async function loadBTTVChannel(twitchId: string): Promise<EmoteMap> {
  // https://api.betterttv.net/3/cached/users/twitch/<id> :contentReference[oaicite:4]{index=4}
  const j: any = await httpJson(`https://api.betterttv.net/3/cached/users/twitch/${encodeURIComponent(twitchId)}`);
  const out: EmoteMap = {};

  const push = (e: any) => {
    const code = String(e?.code ?? "").trim();
    const id = String(e?.id ?? "").trim();
    if (!code || !id) return;
    out[code] = { provider: "bttv", url: `https://cdn.betterttv.net/emote/${id}/2x` };
  };

  for (const e of (j?.channelEmotes ?? [])) push(e);
  for (const e of (j?.sharedEmotes ?? [])) push(e);
  return out;
}

async function loadFFZGlobal(): Promise<EmoteMap> {
  // https://api.frankerfacez.com/v1/set/global :contentReference[oaicite:5]{index=5}
  const j: any = await httpJson("https://api.frankerfacez.com/v1/set/global");
  const out: EmoteMap = {};

  const sets = j?.sets ?? {};
  const defaultSets: any[] = j?.default_sets ?? [];

  for (const setId of defaultSets) {
    const set = sets?.[String(setId)];
    const emoticons = set?.emoticons ?? [];
    for (const em of emoticons) {
      const code = String(em?.name ?? "").trim();
      const urls = em?.urls ?? {};
      const url = httpsify(String(urls["2"] ?? urls["1"] ?? urls["4"] ?? ""));
      if (!code || !url) continue;
      out[code] = { provider: "ffz", url };
    }
  }

  return out;
}

async function loadFFZRoom(channel: string): Promise<{ twitchId?: string; map: EmoteMap }> {
  // https://api.frankerfacez.com/v1/room/<name> :contentReference[oaicite:6]{index=6}
  const j: any = await httpJson(`https://api.frankerfacez.com/v1/room/${encodeURIComponent(channel)}`);
  const room = j?.room;
  const twitchId = room?.twitch_id ? String(room.twitch_id) : undefined;
  const setId = room?.set ? String(room.set) : "";
  const set = j?.sets?.[setId];

  const out: EmoteMap = {};
  const emoticons = set?.emoticons ?? [];
  for (const em of emoticons) {
    const code = String(em?.name ?? "").trim();
    const urls = em?.urls ?? {};
    const url = httpsify(String(urls["2"] ?? urls["1"] ?? urls["4"] ?? ""));
    if (!code || !url) continue;
    out[code] = { provider: "ffz", url };
  }

  return { twitchId, map: out };
}

function parse7tvSetToMap(j: any): EmoteMap {
  // expects v3 emote set shape: { emotes: [ { name, data: { host: { url, files:[{name,format,...}] } } } ] }
  const out: EmoteMap = {};
  const emotes = Array.isArray(j?.emotes) ? j.emotes : [];

  for (const e of emotes) {
    const code = String(e?.name ?? "").trim();
    const host = e?.data?.host ?? e?.data?.host ?? e?.host;
    const hostUrlRaw = String(host?.url ?? "");
    const hostUrl = httpsify(hostUrlRaw);

    const files: any[] = Array.isArray(host?.files) ? host.files : [];
    if (!code || !hostUrl || files.length === 0) continue;

    // pick best file: prefer webp, prefer "2x"
    const byFormat = (fmt: string) => files.filter((f) => String(f?.format ?? "").toLowerCase() === fmt);

    const pickFrom = (arr: any[]) =>
      arr.find((f) => String(f?.name ?? "").includes("2x")) ||
      arr.find((f) => String(f?.name ?? "").includes("3x")) ||
      arr[0];

    const f =
      pickFrom(byFormat("webp")) ||
      pickFrom(byFormat("avif")) ||
      pickFrom(byFormat("gif")) ||
      pickFrom(files);

    const fileName = String(f?.name ?? "");
    if (!fileName) continue;

    out[code] = { provider: "7tv", url: `${hostUrl}/${fileName}` };
  }

  return out;
}

async function load7TVGlobal(): Promise<EmoteMap> {
  // https://7tv.io/v3/emote-sets/global :contentReference[oaicite:7]{index=7}
  const j: any = await httpJson("https://7tv.io/v3/emote-sets/global");
  return parse7tvSetToMap(j);
}

async function load7TVChannel(twitchId: string): Promise<EmoteMap> {
  // https://7tv.io/v3/users/twitch/<id> :contentReference[oaicite:8]{index=8}
  const user: any = await httpJson(`https://7tv.io/v3/users/twitch/${encodeURIComponent(twitchId)}`);
  const setId =
    user?.emote_set?.id ||
    user?.emote_set_id ||
    user?.emoteSet?.id ||
    user?.emoteSetId;

  if (!setId) return {};

  const set: any = await httpJson(`https://7tv.io/v3/emote-sets/${encodeURIComponent(String(setId))}`);
  return parse7tvSetToMap(set);
}

async function ensureGlobalAssetsFresh(): Promise<EmoteMap> {
  const now = Date.now();
  if (globalAssets.loadedAt && now - globalAssets.loadedAt < ASSET_TTL_MS) return globalAssets.map;

  try {
    const [bttvG, ffzG, stvG] = await Promise.all([
      loadBTTVGlobal().catch(() => ({} as EmoteMap)),
      loadFFZGlobal().catch(() => ({} as EmoteMap)),
      load7TVGlobal().catch(() => ({} as EmoteMap)),
    ]);

    const combined: EmoteMap = {};
    mergeEmotes(combined, ffzG);
    mergeEmotes(combined, bttvG);
    mergeEmotes(combined, stvG);

    globalAssets.map = combined;
    globalAssets.loadedAt = now;
    return combined;
  } catch {
    // keep old cache on failure
    return globalAssets.map;
  }
}

async function ensureAssetsForChannel(channel: string, twitchId?: string): Promise<EmoteMap> {
  const now = Date.now();
  const cached = channelAssets.get(channel);
  if (cached && cached.loadedAt && now - cached.loadedAt < ASSET_TTL_MS) return cached.map;

  const globals = await ensureGlobalAssetsFresh();

  // get twitch id via FFZ room if not provided
  let tid = twitchId;
  let ffzRoom: { twitchId?: string; map: EmoteMap } = { map: {} };

  try {
    ffzRoom = await loadFFZRoom(channel);
    if (!tid) tid = ffzRoom.twitchId;
  } catch { }

  const [bttvC, stvC] = await Promise.all([
    tid ? loadBTTVChannel(tid).catch(() => ({} as EmoteMap)) : Promise.resolve({} as EmoteMap),
    tid ? load7TVChannel(tid).catch(() => ({} as EmoteMap)) : Promise.resolve({} as EmoteMap),
  ]);

  const combined: EmoteMap = {};
  mergeEmotes(combined, globals);

  // channel-specific wins
  mergeEmotes(combined, ffzRoom.map);
  mergeEmotes(combined, bttvC);
  mergeEmotes(combined, stvC);

  channelAssets.set(channel, { loadedAt: now, map: combined, twitchId: tid });
  return combined;
}

async function pushAssetsToClient(conn: TwitchConn, ws: WebSocket) {
  // load only once per connection/ttl
  const now = Date.now();
  if (conn.assets && conn.assetsLoadedAt && now - conn.assetsLoadedAt < ASSET_TTL_MS) {
    sendJSON(ws, { type: "assets", emotes: conn.assets, ts: Date.now() });
    return;
  }

  if (conn.assetsLoading) return;
  conn.assetsLoading = true;

  try {
    const map = await ensureAssetsForChannel(conn.channel, conn.twitchId);
    conn.assets = map;
    conn.assetsLoadedAt = Date.now();
    const badges = await ensureBadgesForChannel(conn.channel, conn.twitchId);
    sendJSON(ws, { type: "assets", emotes: map, badges, ts: Date.now() });
  } finally {
    conn.assetsLoading = false;
  }
}

async function broadcastAssets(conn: TwitchConn) {
  const now = Date.now();
  if (conn.assets && conn.assetsLoadedAt && now - conn.assetsLoadedAt < ASSET_TTL_MS) {
    broadcast(conn, { type: "assets", emotes: conn.assets, ts: Date.now() });
    return;
  }
  if (conn.assetsLoading) return;

  conn.assetsLoading = true;
  try {
    const map = await ensureAssetsForChannel(conn.channel, conn.twitchId);
    conn.assets = map;
    conn.assetsLoadedAt = Date.now();
    const badges = await ensureBadgesForChannel(conn.channel, conn.twitchId);
    broadcast(conn, { type: "assets", emotes: map, badges, ts: Date.now() });
  } finally {
    conn.assetsLoading = false;
  }
}

// ---------- twitch IRC ----------
const conns = new Map<string, TwitchConn>();

function connectTwitch(conn: TwitchConn) {
  if (conn.connecting || conn.closed) return;
  conn.connecting = true;

  const url = "wss://irc-ws.chat.twitch.tv:443";
  const irc = new WebSocket(url);
  conn.irc = irc;
  conn.buf = "";

  const nick = `justinfan${Math.floor(10000 + Math.random() * 89999)}`;

  irc.onopen = () => {
    irc.send("CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership");
    irc.send("PASS SCHMOOPIIE");
    irc.send(`NICK ${nick}`);
    irc.send(`JOIN #${conn.channel}`);
    conn.connecting = false;

    broadcast(conn, { type: "info", msg: `connected to #${conn.channel}` });

    // preload assets (best effort)
    void broadcastAssets(conn);
  };

  irc.onmessage = (ev: any) => {
    const chunk = String(ev.data ?? "");
    conn.buf += chunk;

    const lines = conn.buf.split("\r\n");
    conn.buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line) continue;

      if (line.startsWith("PING ")) {
        const payload = line.slice(5);
        try {
          irc.send("PONG " + payload);
        } catch { }
        continue;
      }

      let tags: Record<string, string> = {};
      let rest = line;

      if (rest.startsWith("@")) {
        const sp = rest.indexOf(" ");
        const tagStr = rest.slice(1, sp);
        tags = parseTags(tagStr);
        rest = rest.slice(sp + 1);
      }

      let prefix = "";
      if (rest.startsWith(":")) {
        const sp = rest.indexOf(" ");
        prefix = rest.slice(1, sp);
        rest = rest.slice(sp + 1);
      }

      // update twitch id if present
      const roomId = tags["room-id"];
      if (roomId && !conn.twitchId) {
        conn.twitchId = String(roomId);
        void broadcastAssets(conn);
      }

      if (!rest.includes("PRIVMSG")) continue;

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

        emotes: tags["emotes"] || "",
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

  if (!conn.irc && !conn.connecting) connectTwitch(conn);
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

      const newConn = ensureConn(nextCh);
      if (!newConn) return;

      for (const c of conn.clients) {
        newConn.clients.add(c);
        sendJSON(c, { type: "info", msg: `switched to #${nextCh}` });
        void pushAssetsToClient(newConn, c);
      }
      conn.clients.clear();
      stopConnIfIdle(conn);
      return;
    }

    // reconnect marker changed
    if (conn.lastNonce === undefined) conn.lastNonce = nextNonce;
    if (nextNonce !== conn.lastNonce) {
      conn.lastNonce = nextNonce;

      // invalidate assets so next push reloads
      conn.assetsLoadedAt = 0;
      void broadcastAssets(conn);

      try {
        conn.irc?.close();
      } catch { }
    }
  }, POLL_MS);
}

// ---------- HTTP server ----------
const app = express();

app.get("/health", async (_req, res) => {
  let supabaseOk = false;
  let supabaseError: string | null = null;

  if (supabase) {
    const { error } = await supabase.from("profiles").select("id").limit(1);
    supabaseOk = !error;
    supabaseError = error ? (error.message || JSON.stringify(error)) : null;
  }

  res.json({
    ok: true,
    hasSupabase,
    supabaseOk,
    supabaseError,
    twitchDefaultChannel: TWITCH_DEFAULT_CHANNEL || null,
    assetTTLms: ASSET_TTL_MS,
  });
});

const server = app.listen(PORT, () => {
  console.log(`[chat-gateway] listening on :${PORT}`);
});
server.on("error", (err) => console.error("[chat-gateway] server error", err));

// ---------- ONE WS server + path routing ----------
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  try {
    const u = new URL(req.url ?? "", "http://localhost");
    const p = u.pathname;
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

  // ---- /ws (debug) ----
  if (p === "/ws") {
    sendJSON(socket as any, { type: "hello", ts: Date.now() });
    (socket as any).on("message", (raw: RawData) => {
      sendJSON(socket as any, { type: "echo", raw: raw.toString() });
    });
    return;
  }

  // ---- /ws/chat ----
  if (p === "/ws/chat") {
    const profileId = String(u.searchParams.get("profileId") ?? "").trim();
    const key = String(u.searchParams.get("key") ?? "").trim();

    // profile mode
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

      const channel = String(cfg.twitch_channel ?? "").trim().toLowerCase();
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

      // send assets to this client
      await pushAssetsToClient(conn, socket as any);

      (socket as any).on("close", () => {
        conn.clients.delete(socket as any);
        stopConnIfIdle(conn);
      });

      return;
    }

    // default mode (editor preview)
    const channel = TWITCH_DEFAULT_CHANNEL;
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
    await pushAssetsToClient(conn, socket as any);

    (socket as any).on("close", () => {
      conn.clients.delete(socket as any);
      stopConnIfIdle(conn);
    });

    return;
  }

  try {
    (socket as any).close();
  } catch { }
});