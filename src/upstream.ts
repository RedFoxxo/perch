import { z } from 'zod'

// The parts of computer-use-linux's answers perch reads. Everything else is ignored,
// so new upstream fields never break perch; a renamed field fails the parse loudly.

export const Outcome = z.object({ ok: z.boolean().optional(), message: z.string().optional() }).loose()

export const Window = z
  .object({
    window_id: z.number(),
    app_id: z.string().nullish(),
    title: z.string().nullish(),
    pid: z.number().nullish(),
    focused: z.boolean().nullish(),
    hidden: z.boolean().nullish(),
    workspace: z.union([z.string(), z.number()]).nullish(),
    bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullish(),
  })
  .loose()
export type Window = z.infer<typeof Window>

export const WindowList = z.object({ windows: z.array(Window), note: z.string().nullish() }).loose()

export const TreeNode = z
  .object({
    index: z.number(),
    parent_index: z.number().nullish(),
    role: z.string(),
    name: z.string().nullish(),
    states: z.array(z.string()).nullish(),
    /** Action names, first is the primary one. */
    actions: z.array(z.string()).nullish(),
    text: z.object({ content: z.string().nullish() }).loose().nullish(),
    value: z.object({ text: z.string().nullish(), current: z.number().nullish() }).loose().nullish(),
  })
  .loose()
export type TreeNode = z.infer<typeof TreeNode>

export const AppState = z
  .object({
    snapshot_id: z.string().nullish(),
    accessibility_tree: z.array(TreeNode).nullish(),
    accessibility_tree_spill: z.object({ path: z.string() }).loose().nullish(),
    accessibility_error: z.string().nullish(),
    window_error: z.string().nullish(),
  })
  .loose()

export const ScreenshotMeta = z
  .object({
    width: z.number(),
    height: z.number(),
    scale: z.number(),
    file_path: z.string().nullish(),
  })
  .loose()

export const Doctor = z
  .object({
    readiness: z
      .object({
        can_build_accessibility_tree: z.boolean(),
        can_send_development_input: z.boolean(),
        can_query_windows: z.boolean(),
        blockers: z.array(z.string()),
      })
      .loose(),
  })
  .loose()
