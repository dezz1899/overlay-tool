import { corsHeaders, getAuthedClient, getServiceClient, json, randomKey } from "../_shared/utils.ts";
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const authed = getAuthedClient(req); const service = getServiceClient();
  const { data: { user } } = await authed.auth.getUser(); if (!user) return json({ error: "unauthorized" }, 401);
  const { profileId } = await req.json();
  const { data: me } = await service.from("profile_members").select("role").eq("profile_id", profileId).eq("user_id", user.id).single();
  if (!me || !["admin","streamer"].includes(me.role)) return json({ error: "forbidden" }, 403);
  const view_key = randomKey();
  await service.from("profiles").update({ view_key }).eq("id", profileId);
  return json({ view_key });
});
