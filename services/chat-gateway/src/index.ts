import "dotenv/config";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import type { RawData } from "ws";
import { createClient } from "@supabase/supabase-js";

console.log("[chat-gateway] ASSETS BUILD ACTIVE");
const BUILD_ID = "badges-fix-2026-03-04-01";

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
const TWITCH_CLIENT_ID = String(process.env.TWITCH_CLIENT_ID ?? "").trim();
const TWITCH_CLIENT_SECRET = String(process.env.TWITCH_CLIENT_SECRET ?? "").trim();

let twitchAppToken: string | null = null;
let twitchTokenExpMs = 0;
let lastBadgeError: string | null = null;
let lastBadgeGlobalCount = 0;
let lastBadgeChannelCount = 0;

const DEBUG_7TV_USER_ID = String(process.env.DEBUG_7TV_USER_ID ?? "").trim();
const DEBUG_7TV_WS = String(process.env.DEBUG_7TV_WS ?? "").trim() === "1";

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

type PaintPayload =
  | null
  | {
    kind: "linear";
    angle: number;
    stops: { at: number; color: string }[];
    shadow?: string;
  };

type SevenTVBadge = {
  id?: string;
  name?: string;
  url: string;     // final image URL
  tooltip?: string;
};

type CosmeticsPayload = {
  paint: PaintPayload;
  stvBadges: SevenTVBadge[];
};

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

function pick7tvBestFile(host: any): string {
  const hostUrlRaw = String(host?.url ?? "");
  const hostUrl = httpsify(hostUrlRaw);
  const files: any[] = Array.isArray(host?.files) ? host.files : [];
  if (!hostUrl || files.length === 0) return "";

  const byFmt = (fmt: string) => files.filter((f) => String(f?.format ?? "").toLowerCase() === fmt);

  const pickFrom = (arr: any[]) =>
    arr.find((f) => String(f?.name ?? "").includes("2x")) ||
    arr.find((f) => String(f?.name ?? "").includes("3x")) ||
    arr[0];

  const f =
    pickFrom(byFmt("webp")) ||
    pickFrom(byFmt("avif")) ||
    pickFrom(byFmt("gif")) ||
    pickFrom(files);

  const fileName = String(f?.name ?? "");
  if (!fileName) return "";

  return `${hostUrl}/${fileName}`;
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

function isDebug7tvUser(userId?: string | null): boolean {
  return !!DEBUG_7TV_USER_ID && String(userId ?? "") === DEBUG_7TV_USER_ID;
}

function objectKeys(value: unknown, limit = 20): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).slice(0, limit);
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function firstNonNull<T>(...values: Array<T | null | undefined>): T | null {
  for (const v of values) {
    if (v != null) return v;
  }
  return null;
}

function summarizeNode(value: unknown): string {
  if (value == null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") {
    return `object(${Object.keys(value as Record<string, unknown>).slice(0, 8).join(",")})`;
  }
  if (typeof value === "string") return `string(${value.slice(0, 48)})`;
  return String(value);
}

function collectInteresting7tvPaths(
  value: unknown,
  path = "$",
  depth = 0,
  out: string[] = [],
): string[] {
  if (depth > 5 || out.length >= 30 || value == null || typeof value !== "object") return out;

  if (Array.isArray(value)) {
    for (let i = 0; i < Math.min(value.length, 3); i += 1) {
      collectInteresting7tvPaths(value[i], `${path}[${i}]`, depth + 1, out);
      if (out.length >= 30) break;
    }
    return out;
  }

  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const next = `${path}.${k}`;

    if (/(paint|badge|cosmetic|entitlement|style|active|selected|connection)/i.test(k)) {
      out.push(`${next} => ${summarizeNode(v)}`);
      if (out.length >= 30) break;
    }

    collectInteresting7tvPaths(v, next, depth + 1, out);
    if (out.length >= 30) break;
  }

  return out;
}

function build7tvDebugSummary(raw: any) {
  return {
    topLevelKeys: objectKeys(raw),
    styleKeys: objectKeys(raw?.style),
    cosmeticsKeys: objectKeys(raw?.cosmetics),
    userKeys: objectKeys(raw?.user),
    entitlementsSummary: Array.isArray(raw?.entitlements)
      ? raw.entitlements.slice(0, 5).map((x: any) => ({
        keys: objectKeys(x),
        kind: x?.kind ?? x?.type ?? null,
        id: x?.id ?? null,
      }))
      : null,
    connectionsSummary: Array.isArray(raw?.connections)
      ? raw.connections.slice(0, 3).map((x: any) => ({
        keys: objectKeys(x),
        id: x?.id ?? x?.connection_id ?? x?.platform_id ?? null,
        platform: x?.platform ?? x?.kind ?? x?.type ?? null,
      }))
      : null,
    interestingPaths: collectInteresting7tvPaths(raw),
  };
}

function log7tvDebug(userId: string, stage: string, raw: any, extra: Record<string, unknown> = {}) {
  if (!isDebug7tvUser(userId)) return;
  console.log(
    "[7TV][DEBUG]",
    JSON.stringify({
      userId,
      stage,
      ...extra,
      summary: build7tvDebugSummary(raw),
    }),
  );
}

function normalizePaintPayload(paintObj: any): PaintPayload {
  if (!paintObj) return null;

  const angle = Number(paintObj?.angle ?? 0);
  const stopsRaw = paintObj?.gradient?.stops || paintObj?.stops || null;

  const stops: { at: number; color: string }[] = Array.isArray(stopsRaw)
    ? stopsRaw
      .map((s: any) => ({
        at: Math.max(0, Math.min(1, Number(s?.at ?? s?.position ?? 0))),
        color: String(s?.color ?? s?.value ?? ""),
      }))
      .filter((s: any) => s.color)
    : [];

  const single = String(paintObj?.color ?? "");
  const normalizedStops =
    stops.length > 0
      ? stops
      : single
        ? [{ at: 0, color: single }, { at: 1, color: single }]
        : [];

  if (normalizedStops.length === 0) return null;

  const shadowColor = String(paintObj?.shadow_color ?? paintObj?.shadowColor ?? "");
  const shadow = shadowColor ? `0 0 10px ${shadowColor}` : undefined;

  return {
    kind: "linear",
    angle: Number.isFinite(angle) ? angle : 0,
    stops: normalizedStops,
    shadow,
  };
}

function normalize7tvBadge(b: any): SevenTVBadge | null {
  if (!b) return null;

  const host =
    b?.host ||
    b?.data?.host ||
    b?.badge?.host ||
    b?.data?.badge?.host ||
    b?.cosmetic?.host ||
    b?.item?.host ||
    null;

  const url =
    (host ? pick7tvBestFile(host) : "") ||
    httpsify(
      String(
        b?.url ??
        b?.image_url_4x ??
        b?.image_url_2x ??
        b?.image_url_1x ??
        b?.image_url ??
        b?.data?.url ??
        "",
      ),
    );

  if (!url) return null;

  return {
    id: b?.id ? String(b.id) : undefined,
    name: b?.name ? String(b.name) : undefined,
    tooltip: b?.tooltip ? String(b.tooltip) : (b?.name ? String(b.name) : undefined),
    url,
  };
}

async function httpJsonWithDebug(url: string, debugUserId?: string): Promise<{ ok: boolean; status: number; json: any | null; textSnippet: string }> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
    },
  });

  const text = await res.text();
  let json: any = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (debugUserId && isDebug7tvUser(debugUserId)) {
    console.log(
      "[7TV][HTTP_PROBE]",
      JSON.stringify({
        userId: debugUserId,
        url,
        status: res.status,
        jsonTopLevelKeys: objectKeys(json),
        textSnippet: text.slice(0, 180),
      }),
    );
  }

  return {
    ok: res.ok,
    status: res.status,
    json,
    textSnippet: text.slice(0, 180),
  };
}

function extractPaintLikeObject(raw: any): any | null {
  return firstNonNull(
    raw?.paint,
    raw?.data?.paint,
    raw?.object?.paint,
    raw?.item?.paint,
    raw?.cosmetic?.paint,
    raw?.data,
    raw?.object,
    raw?.item,
    raw?.cosmetic,
    raw,
  );
}

function extractBadgeLikeObject(raw: any): any | null {
  return firstNonNull(
    raw?.badge,
    raw?.data?.badge,
    raw?.object?.badge,
    raw?.item?.badge,
    raw?.cosmetic?.badge,
    raw?.data,
    raw?.object,
    raw?.item,
    raw?.cosmetic,
    raw,
  );
}

async function resolve7tvPaintById(paintId: string, debugUserId?: string): Promise<PaintPayload> {
  const id = String(paintId || "").trim();
  if (!id) return null;

  const candidates = [
    `https://7tv.io/v3/paints/${encodeURIComponent(id)}`,
    `https://7tv.io/v3/cosmetics/${encodeURIComponent(id)}`,
  ];

  for (const url of candidates) {
    try {
      const r = await httpJsonWithDebug(url, debugUserId);
      if (!r.ok || !r.json) continue;

      const raw = extractPaintLikeObject(r.json);
      const paint = normalizePaintPayload(raw);
      if (paint) {
        if (debugUserId && isDebug7tvUser(debugUserId)) {
          console.log(
            "[7TV][PAINT_RESOLVED]",
            JSON.stringify({
              userId: debugUserId,
              paintId: id,
              url,
            }),
          );
        }
        return paint;
      }
    } catch (e: any) {
      if (debugUserId && isDebug7tvUser(debugUserId)) {
        console.log(
          "[7TV][PAINT_RESOLVE_ERROR]",
          JSON.stringify({
            userId: debugUserId,
            paintId: id,
            url,
            error: String(e?.message ?? e),
          }),
        );
      }
    }
  }

  if (debugUserId && isDebug7tvUser(debugUserId)) {
    console.log(
      "[7TV][PAINT_RESOLVE_MISS]",
      JSON.stringify({
        userId: debugUserId,
        paintId: id,
      }),
    );
  }

  return null;
}

async function resolve7tvBadgeById(badgeId: string, debugUserId?: string): Promise<SevenTVBadge | null> {
  const id = String(badgeId || "").trim();
  if (!id) return null;

  const candidates = [
    `https://7tv.io/v3/badges/${encodeURIComponent(id)}`,
    `https://7tv.io/v3/cosmetics/${encodeURIComponent(id)}`,
  ];

  for (const url of candidates) {
    try {
      const r = await httpJsonWithDebug(url, debugUserId);
      if (!r.ok || !r.json) continue;

      const raw = extractBadgeLikeObject(r.json);
      const badge = normalize7tvBadge(raw);
      if (badge) {
        if (debugUserId && isDebug7tvUser(debugUserId)) {
          console.log(
            "[7TV][BADGE_RESOLVED]",
            JSON.stringify({
              userId: debugUserId,
              badgeId: id,
              url,
              badgeName: badge.name ?? badge.tooltip ?? null,
            }),
          );
        }
        return badge;
      }
    } catch (e: any) {
      if (debugUserId && isDebug7tvUser(debugUserId)) {
        console.log(
          "[7TV][BADGE_RESOLVE_ERROR]",
          JSON.stringify({
            userId: debugUserId,
            badgeId: id,
            url,
            error: String(e?.message ?? e),
          }),
        );
      }
    }
  }

  if (debugUserId && isDebug7tvUser(debugUserId)) {
    console.log(
      "[7TV][BADGE_RESOLVE_MISS]",
      JSON.stringify({
        userId: debugUserId,
        badgeId: id,
      }),
    );
  }

  return null;
}

function collectPaintCandidates(raw: any): any[] {
  const out: any[] = [];

  const push = (v: any) => {
    if (v) out.push(v);
  };

  push(raw?.style?.paint);
  push(raw?.style?.active_paint);
  push(raw?.style?.activePaint);

  push(raw?.cosmetics?.paint);
  push(raw?.cosmetics?.active_paint);
  push(raw?.cosmetics?.activePaint);

  push(raw?.paint);

  push(raw?.user?.style?.paint);
  push(raw?.user?.style?.active_paint);
  push(raw?.user?.style?.activePaint);
  push(raw?.user?.cosmetics?.paint);
  push(raw?.user?.cosmetics?.active_paint);
  push(raw?.user?.cosmetics?.activePaint);
  push(raw?.user?.paint);

  for (const c of asArray(raw?.connections)) {
    push(c?.style?.paint);
    push(c?.style?.active_paint);
    push(c?.style?.activePaint);
    push(c?.cosmetics?.paint);
    push(c?.cosmetics?.active_paint);
    push(c?.cosmetics?.activePaint);
    push(c?.user?.style?.paint);
    push(c?.user?.style?.active_paint);
    push(c?.user?.style?.activePaint);
  }

  for (const ent of [
    ...asArray(raw?.entitlements),
    ...asArray(raw?.cosmetics?.entitlements),
    ...asArray(raw?.user?.entitlements),
  ]) {
    const kind = String(ent?.kind ?? ent?.type ?? "").toLowerCase();
    const data = ent?.data ?? ent?.object ?? ent?.item ?? ent?.cosmetic ?? ent;

    if (kind.includes("paint")) {
      push(data?.paint ?? data);
    } else {
      push(data?.paint);
      push(data?.style?.paint);
      push(data?.style?.active_paint);
      push(data?.style?.activePaint);
    }
  }

  return out.filter(Boolean);
}

function collectBadgeCandidates(raw: any): any[] {
  const out: any[] = [];

  const pushMany = (v: any) => {
    if (Array.isArray(v)) out.push(...v.filter(Boolean));
    else if (v) out.push(v);
  };

  pushMany(raw?.style?.badges);
  pushMany(raw?.style?.badge);
  pushMany(raw?.style?.active_badge);
  pushMany(raw?.style?.activeBadge);

  pushMany(raw?.cosmetics?.badges);
  pushMany(raw?.cosmetics?.badge);

  pushMany(raw?.badges);
  pushMany(raw?.badge);

  pushMany(raw?.user?.style?.badges);
  pushMany(raw?.user?.style?.badge);
  pushMany(raw?.user?.cosmetics?.badges);
  pushMany(raw?.user?.cosmetics?.badge);
  pushMany(raw?.user?.badges);
  pushMany(raw?.user?.badge);

  for (const c of asArray(raw?.connections)) {
    pushMany(c?.style?.badges);
    pushMany(c?.style?.badge);
    pushMany(c?.cosmetics?.badges);
    pushMany(c?.cosmetics?.badge);
    pushMany(c?.user?.style?.badges);
    pushMany(c?.user?.style?.badge);
  }

  for (const ent of [
    ...asArray(raw?.entitlements),
    ...asArray(raw?.cosmetics?.entitlements),
    ...asArray(raw?.user?.entitlements),
  ]) {
    const kind = String(ent?.kind ?? ent?.type ?? "").toLowerCase();
    const data = ent?.data ?? ent?.object ?? ent?.item ?? ent?.cosmetic ?? ent;

    if (kind.includes("badge")) {
      pushMany(data?.badge ?? data?.badges ?? data);
    } else {
      pushMany(data?.badge);
      pushMany(data?.badges);
      pushMany(data?.style?.badge);
      pushMany(data?.style?.badges);
    }
  }

  return out.filter(Boolean);
}

async function fetch7TVCosmeticsForTwitchUser(twitchUserId: string): Promise<CosmeticsPayload> {
  const url = `https://7tv.io/v3/users/twitch/${encodeURIComponent(twitchUserId)}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
    },
  });

  const rawText = await res.text();

  let j: any = null;
  try {
    j = rawText ? JSON.parse(rawText) : null;
  } catch (e: any) {
    if (isDebug7tvUser(twitchUserId)) {
      console.log(
        "[7TV][PARSE_ERROR]",
        JSON.stringify({
          userId: twitchUserId,
          status: res.status,
          bodySnippet: rawText.slice(0, 400),
          error: String(e?.message ?? e),
        }),
      );
    }
    throw new Error(`7tv parse failed ${res.status} ${url}`);
  }

  if (!res.ok) {
    if (isDebug7tvUser(twitchUserId)) {
      console.log(
        "[7TV][HTTP_ERROR]",
        JSON.stringify({
          userId: twitchUserId,
          status: res.status,
          bodySnippet: rawText.slice(0, 400),
        }),
      );
    }
    throw new Error(`7tv user fetch failed ${res.status} ${url}`);
  }

  log7tvDebug(twitchUserId, "user-payload", j, { status: res.status });

  const stylePaintId = String(
    j?.user?.style?.paint_id ??
    j?.style?.paint_id ??
    "",
  ).trim();

  const styleBadgeId = String(
    j?.user?.style?.badge_id ??
    j?.style?.badge_id ??
    "",
  ).trim();

  const styleRoleIds = Array.isArray(j?.user?.role_ids)
    ? j.user.role_ids.map((x: any) => String(x))
    : Array.isArray(j?.role_ids)
      ? j.role_ids.map((x: any) => String(x))
      : [];

  if (isDebug7tvUser(twitchUserId)) {
    console.log(
      "[7TV][STYLE_IDS]",
      JSON.stringify({
        userId: twitchUserId,
        stylePaintId: stylePaintId || null,
        styleBadgeId: styleBadgeId || null,
        styleRoleIds,
      }),
    );
  }
  if (isDebug7tvUser(twitchUserId)) {
    console.log(
      "[7TV][CONNECTIONS]",
      JSON.stringify({
        userId: twitchUserId,
        topLevelId: j?.id ?? null,
        userId7tv: j?.user?.id ?? null,
        connections: Array.isArray(j?.user?.connections)
          ? j.user.connections.map((c: any) => ({
            keys: Object.keys(c ?? {}).slice(0, 20),
            id: c?.id ?? null,
            platform: c?.platform ?? null,
            platformId: c?.platform_id ?? c?.platformId ?? null,
            username: c?.username ?? c?.display_name ?? null,
            linkedId: c?.linked_id ?? c?.linkedId ?? null,
            connectionId: c?.connection_id ?? null,
          }))
          : [],
      }),
    );
  }

  let paint: PaintPayload = null;
  for (const candidate of collectPaintCandidates(j)) {
    paint = normalizePaintPayload(candidate);
    if (paint) break;
  }

  if (!paint && stylePaintId) {
    paint = await resolve7tvPaintById(stylePaintId, twitchUserId);
  }

  const stvBadges: SevenTVBadge[] = [];
  const seen = new Set<string>();

  for (const badgeNode of collectBadgeCandidates(j)) {
    const normalized = normalize7tvBadge(badgeNode);
    if (!normalized) continue;

    const dedupeKey = normalized.id || normalized.url;
    if (!dedupeKey || seen.has(dedupeKey)) continue;

    seen.add(dedupeKey);
    stvBadges.push(normalized);
  }

  if (stvBadges.length === 0 && styleBadgeId) {
    const resolvedBadge = await resolve7tvBadgeById(styleBadgeId, twitchUserId);
    if (resolvedBadge) {
      const dedupeKey = resolvedBadge.id || resolvedBadge.url;
      if (dedupeKey && !seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        stvBadges.push(resolvedBadge);
      }
    }
  }

  if (isDebug7tvUser(twitchUserId)) {
    console.log(
      "[7TV][PARSED]",
      JSON.stringify({
        userId: twitchUserId,
        paintFound: !!paint,
        badgeCount: stvBadges.length,
        badgeNames: stvBadges.slice(0, 5).map((b) => b.name ?? b.tooltip ?? b.id ?? "badge"),
      }),
    );

    if (!paint && stylePaintId) {
      console.log(
        "[7TV][PAINT_ID_ONLY]",
        JSON.stringify({
          userId: twitchUserId,
          paintId: stylePaintId,
          note: "User payload exposes paint_id, not an embedded paint object. A second lookup is required.",
        }),
      );
    }

    if (stvBadges.length === 0) {
      console.log(
        "[7TV][BADGE_STATUS]",
        JSON.stringify({
          userId: twitchUserId,
          badgeId: styleBadgeId || null,
          note: styleBadgeId
            ? "badge_id exists but badge object was not resolved"
            : "no badge_id visible in this payload",
        }),
      );
    }
  }

  return { paint, stvBadges };
}

async function getTwitchAppToken(): Promise<string> {
  const now = Date.now();
  if (twitchAppToken && now < twitchTokenExpMs - 60_000) return twitchAppToken; // refresh 60s early

  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    throw new Error("Missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET");
  }

  const body = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    client_secret: TWITCH_CLIENT_SECRET,
    grant_type: "client_credentials",
  });

  const res = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", body });
  const j: any = await res.json().catch(() => ({}));

  if (!res.ok) throw new Error(`token fetch failed ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);

  const token = String(j.access_token ?? "");
  const expiresIn = Number(j.expires_in ?? 0);
  if (!token) throw new Error("token missing in response");

  twitchAppToken = token;
  twitchTokenExpMs = Date.now() + Math.max(300, expiresIn) * 1000;
  return token;
}

async function helixJson(path: string): Promise<any> {
  const token = await getTwitchAppToken();

  const res = await fetch(`https://api.twitch.tv/helix/${path}`, {
    headers: {
      "Client-Id": TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`helix ${path} failed ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

function parseBadgeSetsToMap(j: any): BadgeMap {
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

function parseHelixBadgesToMap(j: any): BadgeMap {
  // helix shape: { data: [ { set_id, versions:[{id, image_url_2x, image_url_1x ...}]} ] }
  const out: BadgeMap = {};
  const data = Array.isArray(j?.data) ? j.data : [];
  for (const set of data) {
    const setId = String(set?.set_id ?? "");
    const versions = Array.isArray(set?.versions) ? set.versions : [];
    for (const v of versions) {
      const ver = String(v?.id ?? "");
      const url = String(v?.image_url_2x ?? v?.image_url_1x ?? "");
      if (!setId || !ver || !url) continue;
      out[`${setId}/${ver}`] = url;
    }
  }
  return out;
}

async function loadGlobalBadges(): Promise<BadgeMap> {
  const j = await helixJson("chat/badges/global");
  const map = parseHelixBadgesToMap(j);
  if (Object.keys(map).length === 0) throw new Error("helix global badges parsed 0 keys");
  return map;
}

async function loadChannelBadges(roomId: string): Promise<BadgeMap> {
  // roomId kommt aus IRC tag "room-id" und ist Twitch broadcaster_id
  const j = await helixJson(`chat/badges?broadcaster_id=${encodeURIComponent(roomId)}`);
  return parseHelixBadgesToMap(j);
}

async function ensureBadgesForChannel(channel: string, roomId?: string): Promise<BadgeMap> {
  const now = Date.now();

  // global cache refresh (✅ treat empty map as stale)
  const globalKeyCount = Object.keys(globalBadges.map || {}).length;
  lastBadgeGlobalCount = globalKeyCount;

  const needGlobalReload =
    !globalBadges.loadedAt ||
    now - globalBadges.loadedAt >= ASSET_TTL_MS ||
    globalKeyCount === 0;

  if (needGlobalReload) {
    try {
      globalBadges.map = await loadGlobalBadges();
      globalBadges.loadedAt = now;
      lastBadgeGlobalCount = Object.keys(globalBadges.map).length;
      lastBadgeError = null;
    } catch (e: any) {
      lastBadgeError = String(e?.message ?? e);
      globalBadges.loadedAt = 0; // ✅ force retry next time
    }
  }

  // channel cache refresh (only if we have roomId)
  let chMap: BadgeMap = {};
  if (roomId) {
    const cached = channelBadges.get(channel);
    if (cached?.loadedAt && now - cached.loadedAt < ASSET_TTL_MS && cached.roomId === roomId) {
      chMap = cached.map;
      lastBadgeChannelCount = Object.keys(chMap).length;
    } else {
      try {
        chMap = await loadChannelBadges(roomId);
        channelBadges.set(channel, { loadedAt: now, map: chMap, roomId });
        lastBadgeChannelCount = Object.keys(chMap).length;
      } catch {
        if (cached?.map) {
          chMap = cached.map;
          lastBadgeChannelCount = Object.keys(chMap).length;
        }
      }
    }
  }

  // channel overrides global
  return { ...globalBadges.map, ...chMap };
}

async function ensureCosmetics(userId: string): Promise<CosmeticsPayload> {
  const now = Date.now();
  const cached = cosmeticsCache.get(userId);
  const debugUser = isDebug7tvUser(userId);

  // Debug-User bewusst NICHT aus TTL-Cache bedienen,
  // damit du nach jedem Chat direkt neue 7TV-Logs bekommst.
  if (!debugUser && cached?.loadedAt && now - cached.loadedAt < COSMETICS_TTL_MS) {
    return cached.data;
  }

  if (cosmeticsInflight.has(userId)) {
    return cached?.data ?? { paint: null, stvBadges: [] };
  }

  cosmeticsInflight.add(userId);

  try {
    const data = await fetch7TVCosmeticsForTwitchUser(userId);
    cosmeticsCache.set(userId, { loadedAt: now, data });
    return data;
  } catch (e: any) {
    const errMsg = String(e?.message ?? e);

    if (debugUser || !cached) {
      console.log(
        "[7TV][COSMETICS_ERROR]",
        JSON.stringify({
          userId,
          error: errMsg,
        }),
      );
    }

    const fallback = cached?.data ?? { paint: null, stvBadges: [] };

    // Für den Debug-User bei Fehler nicht “hart” cachen,
    // damit der nächste Chat sofort neu versucht wird.
    cosmeticsCache.set(userId, {
      loadedAt: debugUser ? 0 : now,
      data: fallback,
    });

    return fallback;
  } finally {
    cosmeticsInflight.delete(userId);
  }
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

const cosmeticsCache = new Map<string, { loadedAt: number; data: CosmeticsPayload }>();
const cosmeticsInflight = new Set<string>();
const COSMETICS_TTL_MS = Math.max(60_000, Number(process.env.COSMETICS_TTL_MS ?? 10 * 60 * 1000));

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
    const badges = await ensureBadgesForChannel(conn.channel, conn.twitchId);
    sendJSON(ws, { type: "assets", emotes: conn.assets, badges, ts: Date.now() });
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
    const badges = await ensureBadgesForChannel(conn.channel, conn.twitchId);
    broadcast(conn, { type: "assets", emotes: conn.assets, badges, ts: Date.now() });
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
      const uidTag = tags["user-id"];
      if (uidTag) {
        void (async () => {
          const userId = String(uidTag);
          const data = await ensureCosmetics(userId);

          broadcast(conn, {
            type: "cosmetics",
            user_id: userId,
            paint: data.paint,
            stvBadges: data.stvBadges,
          });

          if (isDebug7tvUser(userId) && DEBUG_7TV_WS && process.env.NODE_ENV !== "production") {
            broadcast(conn, {
              type: "debug_7tv",
              user_id: userId,
              paintFound: !!data.paint,
              stvBadgeCount: data.stvBadges.length,
              badgeNames: data.stvBadges.slice(0, 5).map((b) => b.name ?? b.tooltip ?? b.id ?? "badge"),
            });
          }
        })();
      }
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

  // --- badge probe (only when ?probe=1) ---
  const doProbe = String((_req as any).query?.probe ?? "") === "1";
  let badgeProbeCount: number | null = null;
  let badgeProbeError: string | null = null;

  if (doProbe) {
    try {
      const m = await loadGlobalBadges();
      badgeProbeCount = Object.keys(m).length;
    } catch (e: any) {
      badgeProbeError = String(e?.message ?? e);
    }
  }

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
    badgeGlobalCount: lastBadgeGlobalCount,
    badgeChannelCount: lastBadgeChannelCount,
    badgeLastError: lastBadgeError,
    badgeProbeCount,
    badgeProbeError,
    buildId: BUILD_ID,
  });
});

const server = app.listen(PORT, () => {
  console.log(`[chat-gateway] listening on :${PORT}`);
});
server.on("error", (err) => console.error("[chat-gateway] server error", err));

// ---------- ONE WS server + path routing ----------
const wss = new WebSocketServer({ noServer: true });
const hb = setInterval(() => {
  for (const ws of wss.clients) {
    const anyWs: any = ws as any;
    if (anyWs.isAlive === false) {
      try { ws.terminate(); } catch { }
      continue;
    }
    anyWs.isAlive = false;
    try { ws.ping(); } catch { }
  }
}, 25_000);

wss.on("close", () => clearInterval(hb));

server.on("upgrade", (req, socket, head) => {
  try {
    const u = new URL(req.url ?? "", "http://localhost");
    const p = u.pathname;
    console.log("[upgrade]", p, String(u.searchParams.get("channel") ?? ""), String(u.searchParams.get("profileId") ?? ""));
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

  (socket as any).isAlive = true;

  (socket as any).on("pong", () => {
    (socket as any).isAlive = true;
  });

  // optional: Antworten auf simple "ping" Textmessage (dein Client sendet "ping")
  (socket as any).on("message", (raw: RawData) => {
    const s = raw.toString();
    if (s === "ping") {
      sendJSON(socket as any, { type: "echo", raw: "ping" });
    }
  });

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
    const requested = String(u.searchParams.get("channel") ?? "").trim().toLowerCase();
    const requestedClean = requested.replace(/^#/, "").replace(/[^a-z0-9_]/g, "");
    const channel = requestedClean || TWITCH_DEFAULT_CHANNEL;

    if (!channel) {
      sendJSON(socket as any, { type: "error", msg: "no profileId/key and no channel param and no TWITCH_DEFAULT_CHANNEL set" });
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