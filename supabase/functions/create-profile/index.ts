import { corsHeaders, getAuthedClient, getServiceClient, hashPassword, json, randomKey } from "../_shared/utils.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const authed = getAuthedClient(req);
  const service = getServiceClient();
  const { data: { user } } = await authed.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const { profileId, name, password, displayName } = await req.json();
  const passwordHash = await hashPassword(password);

  const { error: pErr } = await service.from("profiles").insert({ id: profileId, name, password_hash: passwordHash, view_key: randomKey(), created_by: user.id });
  if (pErr) return json({ error: pErr.message }, 400);

  await service.from("profile_members").insert({ profile_id: profileId, user_id: user.id, display_name: displayName, role: "admin" });

  const { data: overlay } = await service.from("overlays").insert({ profile_id: profileId, name: "Standard Overlay" }).select("id,name").single();
  const emptyScene = { canvas: { w: 1920, h: 1080 }, nodes: [] };
  const { data: draft } = await service.from("overlay_versions").insert({ overlay_id: overlay!.id, kind: "draft", data: emptyScene, created_by: user.id }).select("id").single();
  const { data: published } = await service.from("overlay_versions").insert({ overlay_id: overlay!.id, kind: "published", data: emptyScene, created_by: user.id }).select("id").single();
  await service.from("overlay_version_pointers").insert({ overlay_id: overlay!.id, current_draft_version_id: draft!.id, current_published_version_id: published!.id });
  await service.from("profiles").update({ active_overlay_id: overlay!.id }).eq("id", profileId);

  return json({ membership: { role: "admin" }, profile: { id: profileId, name, active_overlay_id: overlay!.id, pending_active_overlay_id: null }, overlays: [overlay], members: [{ user_id: user.id, display_name: displayName, role: "admin" }] });
});
