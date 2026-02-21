import { canEditDraft, canManageLive, emptyScene, type SceneData, type SceneNode } from "@overlay/shared";
import { Layer, Rect, Stage, Text, Transformer } from "react-konva";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";

type Role = "admin" | "streamer" | "moderator" | "roleless";
type Overlay = { id: string; name: string };

const snap = (v: number, max: number, threshold: number, disable: boolean) => {
  if (disable) return v;
  if (Math.abs(v) < threshold) return 0;
  if (Math.abs(max - v) < threshold) return max;
  return v;
};

const defaultNode = (): SceneNode => ({
  id: crypto.randomUUID(), type: "CounterWidget", x: 80, y: 80, w: 360, h: 120, z: 1, visible: true, locked: false,
  style: { backgroundColor: "#000000", backgroundOpacity: 0.4, borderRadius: 8, padding: 12, fontFamily: "Inter", fontSize: 40, fontColor: "#ffffff", textAlign: "left" },
  props: { label: "Counter", initialValue: 0 }
});

export const App = () => {
  const [sessionReady, setSessionReady] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [profileId, setProfileId] = useState("");
  const [password, setPassword] = useState("");
  const [profileName, setProfileName] = useState("");
  const [role, setRole] = useState<Role>("roleless");
  const [joined, setJoined] = useState(false);
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const [activeOverlayId, setActiveOverlayId] = useState<string | null>(null);
  const [pendingOverlayId, setPendingOverlayId] = useState<string | null>(null);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [scene, setScene] = useState<SceneData>(emptyScene);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [liveTab, setLiveTab] = useState(false);
  const [members, setMembers] = useState<Array<{ user_id: string; display_name: string; role: Role }>>([]);

  const selectedNode = useMemo(() => scene.nodes.find((n) => n.id === selectedNodeId), [scene, selectedNodeId]);
  const trRef = useRef<any>(null);
  const nodeRef = useRef<any>(null);

  useEffect(() => {
    api.getSession().then(() => setSessionReady(true));
  }, []);

  useEffect(() => {
    if (trRef.current && nodeRef.current) trRef.current.nodes([nodeRef.current]);
  }, [selectedNodeId]);

  const upsertPresence = async () => {
    if (!joined) return;
    await fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/profile_presence`, {
      method: "POST",
      headers: {
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${(await api.getSession()).data.session?.access_token}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates"
      },
      body: JSON.stringify({ profile_id: profileId, display_name: displayName, last_seen_at: new Date().toISOString() })
    });
  };

  useEffect(() => {
    const id = setInterval(upsertPresence, 10_000);
    return () => clearInterval(id);
  });

  const join = async (create = false) => {
    const payload = { profileId, password, displayName };
    const data: any = create ? await api.createProfile({ ...payload, name: profileName }) : await api.joinProfile(payload);
    setRole(data.membership.role);
    setOverlays(data.overlays ?? []);
    setMembers(data.members ?? []);
    setActiveOverlayId(data.profile.active_overlay_id);
    setPendingOverlayId(data.profile.pending_active_overlay_id);
    setSelectedOverlayId(data.overlays?.[0]?.id ?? null);
    setJoined(true);
  };

  const saveDraft = async () => {
    if (!selectedOverlayId) return;
    await fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/rpc/save_draft`, {
      method: "POST",
      headers: {
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${(await api.getSession()).data.session?.access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ p_overlay_id: selectedOverlayId, p_data: scene })
    });
    alert("Draft gespeichert");
  };

  if (!sessionReady) return <div style={{ padding: 24 }}>Lade Session…</div>;

  if (!joined) {
    return <div style={{ maxWidth: 460, margin: "48px auto" }}>
      <h1>Overlay Profile Editor</h1>
      <p>Google Login ist erforderlich.</p>
      <button onClick={() => api.googleSignIn()}>Mit Google anmelden</button>
      <input placeholder="Anzeigename" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      <input placeholder="Profile-ID" value={profileId} onChange={(e) => setProfileId(e.target.value)} />
      <input placeholder="Profile-Passwort" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button onClick={() => join(false)}>Profil beitreten</button>
      <hr />
      <input placeholder="Neuer Profilname" value={profileName} onChange={(e) => setProfileName(e.target.value)} />
      <button onClick={() => join(true)}>Profil erstellen</button>
    </div>;
  }

  return <div className="layout">
    <aside className="panel">
      <h3>{profileName || profileId}</h3>
      <div className="badge">Rolle: {role}</div>
      <h4>Präsenz</h4>
      {members.map((m) => <div key={m.user_id}>{m.display_name} ({m.role})</div>)}
      <h4>Overlays</h4>
      {overlays.map((o) => <button key={o.id} onClick={() => setSelectedOverlayId(o.id)}>{o.name} {o.id === activeOverlayId && "(LIVE)"}</button>)}
      {canEditDraft(role) && <>
        <button onClick={() => setScene((s) => ({ ...s, nodes: [...s.nodes, defaultNode()] }))}>Counter Widget hinzufügen</button>
        <button onClick={saveDraft}>Draft speichern</button>
      </>}
      {canManageLive(role) && <button onClick={() => setLiveTab((v) => !v)}>{liveTab ? "Editor" : "LIVE"} Panel</button>}
    </aside>

    {!liveTab ? <main className="canvas-wrap">
      <Stage width={960} height={540} scaleX={0.5} scaleY={0.5} style={{ background: "#111" }} onMouseDown={() => setSelectedNodeId(null)}>
        <Layer>
          <Rect x={0} y={0} width={1920} height={1080} stroke="#245" strokeWidth={2} />
          {scene.nodes.sort((a, b) => a.z - b.z).map((n) => n.visible && (
            <>
              <Rect
                key={n.id}
                ref={n.id === selectedNodeId ? nodeRef : null}
                x={n.x}
                y={n.y}
                width={n.w}
                height={n.h}
                fill={n.style.backgroundColor}
                opacity={n.style.backgroundOpacity}
                stroke={n.id === selectedNodeId ? "#76c0ff" : "#445"}
                draggable={!n.locked && canEditDraft(role)}
                onClick={(e) => { e.cancelBubble = true; setSelectedNodeId(n.id); }}
                onDragEnd={(e) => setScene((s) => ({ ...s, nodes: s.nodes.map((x) => x.id === n.id ? { ...x, x: snap(e.target.x(), 1920 - n.w, 8, e.evt.altKey), y: snap(e.target.y(), 1080 - n.h, 8, e.evt.altKey) } : x) }))}
                onTransformEnd={(e) => setScene((s) => ({ ...s, nodes: s.nodes.map((x) => x.id === n.id ? { ...x, w: Math.max(40, e.target.width() * e.target.scaleX()), h: Math.max(40, e.target.height() * e.target.scaleY()) } : x) }))}
              />
              <Text key={`${n.id}-t`} x={n.x + 12} y={n.y + 12} text={n.type} fill={n.style.fontColor} fontSize={n.style.fontSize} />
            </>
          ))}
          <Transformer ref={trRef} rotateEnabled={false} />
        </Layer>
      </Stage>
    </main> : <main className="panel" style={{ border: "none" }}>
      <h2>LIVE / Publish</h2>
      <p className="warning">OBS ändert sich nur wenn hier publiziert wird.</p>
      <p>Aktiv: {overlays.find((o) => o.id === activeOverlayId)?.name ?? "-"}</p>
      <p>Pending: {overlays.find((o) => o.id === pendingOverlayId)?.name ?? "-"}</p>
      <select value={pendingOverlayId ?? ""} onChange={(e) => setPendingOverlayId(e.target.value || null)}>
        <option value="">-- Overlay wählen --</option>
        {overlays.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
      <button onClick={async () => pendingOverlayId && confirm("Aktivierung vormerken?") && await api.setPendingActivation({ profileId, overlayId: pendingOverlayId })}>Activate Overlay…</button>
      <button onClick={async () => activeOverlayId && confirm("Aktives Overlay publizieren?") && await api.publishOverlay({ profileId, overlayId: activeOverlayId })}>Publish Active Overlay</button>
      <button onClick={async () => pendingOverlayId && confirm("Pending publizieren und aktivieren?") && await api.publishAndActivate({ profileId, overlayId: pendingOverlayId })}>Publish Pending Activation</button>
      <button onClick={async () => confirm("OBS View Key rotieren?") && await api.rotateViewKey({ profileId })}>Rotate OBS View Key</button>
      <input readOnly value={`${import.meta.env.VITE_RENDERER_BASE}/p/${profileId}?key=<viewKey>`} />
    </main>}

    <aside className="panel right">
      <h3>Eigenschaften</h3>
      {selectedNode ? <>
        <label>X<input type="number" value={selectedNode.x} onChange={(e) => setScene((s) => ({ ...s, nodes: s.nodes.map((n) => n.id === selectedNode.id ? { ...n, x: Number(e.target.value) } : n) }))} /></label>
        <label>Y<input type="number" value={selectedNode.y} onChange={(e) => setScene((s) => ({ ...s, nodes: s.nodes.map((n) => n.id === selectedNode.id ? { ...n, y: Number(e.target.value) } : n) }))} /></label>
        <label>Breite<input type="number" value={selectedNode.w} onChange={(e) => setScene((s) => ({ ...s, nodes: s.nodes.map((n) => n.id === selectedNode.id ? { ...n, w: Number(e.target.value) } : n) }))} /></label>
        <label>Höhe<input type="number" value={selectedNode.h} onChange={(e) => setScene((s) => ({ ...s, nodes: s.nodes.map((n) => n.id === selectedNode.id ? { ...n, h: Number(e.target.value) } : n) }))} /></label>
      </> : <p>Widget auswählen…</p>}
    </aside>
  </div>;
};
