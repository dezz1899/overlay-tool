import { corsHeaders, getAuthedClient, getServiceClient, json, verifyPassword } from "../_shared/utils.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const authed = getAuthedClient(req);
  const service = getServiceClient();
  const { data: { user } } = await authed.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const { profileId, password, displayName } = await req.json();
  const { data: profile } = await service.from("profiles").select("*").eq("id", profileId).single();
  if (!profile) return json({ error: "profile not found" }, 404);
  if (!(await verifyPassword(password, profile.password_hash))) return json({ error: "invalid password" }, 403);

  await service.from("profile_members").upsert({ profile_id: profileId, user_id: user.id, display_name: displayName, role: "roleless" }, { onConflict: "profile_id,user_id", ignoreDuplicates: true });

  const { data: membership } = await service.from("profile_members").select("role").eq("profile_id", profileId).eq("user_id", user.id).single();
  const { data: overlays } = await service.from("overlays").select("id,name").eq("profile_id", profileId).eq("is_deleted", false);
  const { data: members } = await service.from("profile_members").select("user_id,display_name,role").eq("profile_id", profileId);
  return json({ membership, profile, overlays, members });
});
