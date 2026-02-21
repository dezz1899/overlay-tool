import { emptyScene, sceneSchema } from "@overlay/shared";
import { supabase } from "./supabase";

const fn = async <T>(name: string, body: Record<string, unknown>): Promise<T> => {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) throw error;
  return data as T;
};

export const api = {
  googleSignIn: () => supabase.auth.signInWithOAuth({ provider: "google" }),
  getSession: () => supabase.auth.getSession(),
  createProfile: (payload: { profileId: string; name: string; password: string; displayName: string }) => fn("create-profile", payload),
  joinProfile: (payload: { profileId: string; password: string; displayName: string }) => fn("join-profile", payload),
  setPendingActivation: (payload: { profileId: string; overlayId: string | null }) => fn("set-pending-activation", payload),
  publishOverlay: (payload: { profileId: string; overlayId: string }) => fn("publish-overlay", payload),
  publishAndActivate: (payload: { profileId: string; overlayId: string }) => fn("publish-and-activate", payload),
  rotateViewKey: (payload: { profileId: string }) => fn("rotate-view-key", payload),
  removeMember: (payload: { profileId: string; memberUserId: string }) => fn("remove-member", payload),
  setMemberRole: (payload: { profileId: string; memberUserId: string; role: string }) => fn("set-member-role", payload),
  async loadDraft(overlayId: string) {
    const { data, error } = await supabase
      .from("overlay_view")
      .select("draft_data")
      .eq("overlay_id", overlayId)
      .single();
    if (error) throw error;
    return sceneSchema.parse(data?.draft_data ?? emptyScene);
  }
};
