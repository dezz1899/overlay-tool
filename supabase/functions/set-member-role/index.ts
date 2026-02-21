import { corsHeaders, getAuthedClient, getServiceClient, json } from "../_shared/utils.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const authed = getAuthedClient(req); const service = getServiceClient();
  const { data: { user } } = await authed.auth.getUser(); if (!user) return json({ error: "unauthorized" }, 401);
  const { profileId, memberUserId, role } = await req.json();
  const { data: me } = await service.from("profile_members").select("role").eq("profile_id", profileId).eq("user_id", user.id).single();
  if (!me) return json({ error: "forbidden" }, 403);
  if (role === "streamer" && me.role !== "admin") return json({ error: "only admin can grant streamer" }, 403);
  if (role === "moderator" && !["admin","streamer"].includes(me.role)) return json({ error: "forbidden" }, 403);
  await service.from("profile_members").update({ role }).eq("profile_id", profileId).eq("user_id", memberUserId);
  return json({ ok: true });
});
