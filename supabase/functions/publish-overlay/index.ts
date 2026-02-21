import { corsHeaders, getAuthedClient, getServiceClient, json } from "../_shared/utils.ts";
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const authed = getAuthedClient(req); const service = getServiceClient();
  const { data: { user } } = await authed.auth.getUser(); if (!user) return json({ error: "unauthorized" }, 401);
  const { profileId, overlayId } = await req.json();
  const { data: me } = await service.from("profile_members").select("role").eq("profile_id", profileId).eq("user_id", user.id).single();
  if (!me || !["admin","streamer"].includes(me.role)) return json({ error: "forbidden" }, 403);
  const { data: pointer } = await service.from("overlay_version_pointers").select("current_draft_version_id").eq("overlay_id", overlayId).single();
  const { data: draft } = await service.from("overlay_versions").select("data").eq("id", pointer!.current_draft_version_id).single();
  const { data: p } = await service.from("overlay_versions").insert({ overlay_id: overlayId, kind: "published", data: draft!.data, created_by: user.id }).select("id").single();
  await service.from("overlay_version_pointers").update({ current_published_version_id: p!.id, updated_at: new Date().toISOString() }).eq("overlay_id", overlayId);
  return json({ ok: true });
});
