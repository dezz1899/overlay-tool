import "dotenv/config";
import express from "express";
import { WebSocketServer } from "ws";
import { createClient } from "@supabase/supabase-js";

const PORT = Number(process.env.PORT ?? 8080);

// Server-only
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const hasSupabase = !!SUPABASE_URL && !!SUPABASE_SERVICE_ROLE_KEY;
const supabase = hasSupabase ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null;

const app = express();

app.get("/health", async (_req, res) => {
  // simple health + supabase connectivity check
  let supabaseOk = false;
  if (supabase) {
    const { error } = await supabase.from("profiles").select("id").limit(1);
    supabaseOk = !error;
  }
  res.json({ ok: true, supabaseOk });
});

const server = app.listen(PORT, () => {
  console.log(`[chat-gateway] listening on http://localhost:${PORT}`);
});
server.on("error", (err) => console.error("[chat-gateway] server error", err));

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "hello", ts: Date.now() }));

  socket.on("message", (raw) => {
    // echo for debugging
    socket.send(JSON.stringify({ type: "echo", raw: raw.toString() }));
  });
});