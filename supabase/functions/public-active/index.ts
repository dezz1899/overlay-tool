import { corsHeaders, getServiceClient, json } from "../_shared/utils.ts";
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const service = getServiceClient();
  const url = new URL(req.url);
  const profileId = url.searchParams.get("profileId");
  const key = url.searchParams.get("key");
  if (!profileId || !key) return json({ error: "missing params" }, 400);

  const { data: profile } = await service.from("profiles").select("id,name,view_key,active_overlay_id").eq("id", profileId).single();
  if (!profile || profile.view_key !== key) return json({ error: "invalid key" }, 403);
  if (!profile.active_overlay_id) return json({ error: "no active overlay" }, 404);

  const { data: o } = await service.from("overlays").select("id,name").eq("id", profile.active_overlay_id).single();
  const { data: pointer } = await service.from("overlay_version_pointers").select("current_published_version_id,updated_at").eq("overlay_id", profile.active_overlay_id).single();
  const { data: published } = await service.from("overlay_versions").select("data,created_at").eq("id", pointer!.current_published_version_id).single();

  return json({ overlayId: o!.id, overlayName: o!.name, updatedAt: pointer!.updated_at ?? published!.created_at, sceneData: published!.data });
});
