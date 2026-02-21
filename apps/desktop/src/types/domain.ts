import type { SceneData, Role } from "@overlay/shared";

export interface Membership {
  profile_id: string;
  user_id: string;
  display_name: string;
  role: Role;
}

export interface OverlaySummary {
  id: string;
  name: string;
}

export interface OverlayBundle {
  overlay: OverlaySummary;
  scene: SceneData;
}

export interface ProfileMeta {
  id: string;
  name: string;
  view_key: string;
  active_overlay_id: string | null;
  pending_active_overlay_id: string | null;
}
