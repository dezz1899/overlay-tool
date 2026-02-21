import { corsHeaders, getAuthedClient, getServiceClient, json } from "../_shared/utils.ts";
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const authed = getAuthedClient(req); const service = getServiceClient();
  const { data: { user } } = await authed.auth.getUser(); if (!user) return json({ error: "unauthorized" }, 401);
  const { profileId, overlayId } = await req.json();
  const { data: me } = await service.from("profile_members").select("role").eq("profile_id", profileId).eq("user_id", user.id).single();
  if (!me || !["admin","streamer"].includes(me.role)) return json({ error: "forbidden" }, 403);
  await service.from("profiles").update({ pending_active_overlay_id: overlayId }).eq("id", profileId);
  return json({ ok: true });
});
