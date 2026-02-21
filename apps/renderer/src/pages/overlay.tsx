import { sceneSchema, type SceneNode } from "@overlay/shared";
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";

const renderNode = (node: SceneNode) => {
  const style: React.CSSProperties = {
    position: "absolute", left: node.x, top: node.y, width: node.w, height: node.h,
    background: node.style.backgroundColor, opacity: node.style.backgroundOpacity, borderRadius: node.style.borderRadius,
    padding: node.style.padding, color: node.style.fontColor, fontFamily: node.style.fontFamily, fontSize: node.style.fontSize,
    textAlign: node.style.textAlign as any, overflow: "hidden"
  };
  if (node.type === "CustomWidget") {
    return <iframe key={node.id} sandbox="allow-scripts" style={style} srcDoc={`<style>${node.props.css}</style>${node.props.html}<script>window.addEventListener('message',()=>{});${node.props.js}<'/script>'.replace('<','<')`} />;
  }
  if (node.type === "EmbedWidget") return <iframe key={node.id} style={style} src={node.props.url} title={node.id} />;
  if (node.type === "ChecklistWidget") return <div key={node.id} style={style}>{node.props.items.map((i, idx) => <div key={idx} style={{ textDecoration: i.checked ? "line-through" : "none", opacity: i.checked ? 0.6 : 1 }}>{i.text}</div>)}</div>;
  if (node.type === "CounterWidget") return <div key={node.id} style={style}>{node.props.label ?? "Counter"}: {node.props.initialValue}</div>;
  return <div key={node.id} style={style}>Timer ({node.props.mode})</div>;
};

export const OverlayPage = () => {
  const { profileId } = useParams();
  const [query] = useSearchParams();
  const [scene, setScene] = useState<any>(null);
  const [updatedAt, setUpdatedAt] = useState<string>("");
  const key = query.get("key");

  const fetchActive = async () => {
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_FUNCTIONS_BASE}/public-active?profileId=${profileId}&key=${key}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "fetch failed");
    if (data.updatedAt !== updatedAt) {
      setUpdatedAt(data.updatedAt);
      setScene(sceneSchema.parse(data.sceneData));
    }
  };

  useEffect(() => { fetchActive(); const id = setInterval(fetchActive, 5_000); return () => clearInterval(id); });

  const scale = useMemo(() => Math.min(window.innerWidth / 1920, window.innerHeight / 1080), []);

  if (!key) return <div>Fehlender key Parameter</div>;
  if (!scene) return <div>Lade Overlay…</div>;

  return <div style={{ width: "100vw", height: "100vh", background: "transparent", display: "flex", alignItems: "center", justifyContent: "center" }}>
    <div style={{ width: 1920, height: 1080, transform: `scale(${scale})`, transformOrigin: "center", position: "relative" }}>
      {scene.nodes.sort((a: SceneNode, b: SceneNode) => a.z - b.z).filter((n: SceneNode) => n.visible).map(renderNode)}
    </div>
  </div>;
};
