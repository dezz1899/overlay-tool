import { z } from "zod";

export const roleSchema = z.enum(["admin", "streamer", "moderator", "roleless"]);
export type Role = z.infer<typeof roleSchema>;

export const nodeStyleSchema = z.object({
  backgroundColor: z.string().default("#000000"),
  backgroundOpacity: z.number().min(0).max(1).default(0.4),
  borderRadius: z.number().min(0).default(8),
  padding: z.number().min(0).default(12),
  fontFamily: z.string().default("Inter"),
  fontSize: z.number().min(8).default(32),
  fontColor: z.string().default("#ffffff"),
  textAlign: z.enum(["left", "center", "right"]).default("left"),
  headerText: z.string().optional(),
  headerFontSize: z.number().min(8).optional(),
  headerColor: z.string().optional()
});

const baseNodeSchema = z.object({
  id: z.string(),
  type: z.enum(["TimerWidget", "CounterWidget", "ChecklistWidget", "CustomWidget", "EmbedWidget"]),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  z: z.number(),
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
  style: nodeStyleSchema
});

export const timerPropsSchema = z.object({
  mode: z.enum(["countdown", "stopwatch"]),
  countdownDurationSeconds: z.number().nonnegative().default(300),
  displayFormat: z.enum(["HH:MM:SS", "MM:SS"]).default("MM:SS"),
  autostartOnLoad: z.boolean().default(true)
});

export const counterPropsSchema = z.object({
  label: z.string().optional(),
  initialValue: z.number().default(0)
});

export const checklistPropsSchema = z.object({
  header: z.string().optional(),
  autoScroll: z.boolean().default(true),
  items: z.array(z.object({ text: z.string(), checked: z.boolean() })).default([])
});

export const customPropsSchema = z.object({
  html: z.string().default("<div>Custom Widget</div>"),
  css: z.string().default("body { margin: 0; }"),
  js: z.string().default("console.log('custom widget')")
});

export const embedPropsSchema = z.object({
  url: z.string().url()
});

export const sceneNodeSchema = z.discriminatedUnion("type", [
  baseNodeSchema.extend({ type: z.literal("TimerWidget"), props: timerPropsSchema }),
  baseNodeSchema.extend({ type: z.literal("CounterWidget"), props: counterPropsSchema }),
  baseNodeSchema.extend({ type: z.literal("ChecklistWidget"), props: checklistPropsSchema }),
  baseNodeSchema.extend({ type: z.literal("CustomWidget"), props: customPropsSchema }),
  baseNodeSchema.extend({ type: z.literal("EmbedWidget"), props: embedPropsSchema })
]);

export const sceneSchema = z.object({
  canvas: z.object({ w: z.literal(1920), h: z.literal(1080) }),
  nodes: z.array(sceneNodeSchema)
});

export type SceneData = z.infer<typeof sceneSchema>;
export type SceneNode = z.infer<typeof sceneNodeSchema>;

export const emptyScene: SceneData = { canvas: { w: 1920, h: 1080 }, nodes: [] };

export const canEditDraft = (role: Role) => role === "admin" || role === "streamer" || role === "moderator";
export const canManageLive = (role: Role) => role === "admin" || role === "streamer";
