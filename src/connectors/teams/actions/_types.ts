/**
 * Shared types and the `ContentInput` schema used by every Teams action
 * module.
 *
 * `ContentInput` is the canonical body shape for any action that posts
 * Teams message content. Senders pick one of three formats:
 *   - `plain`     → Graph `body.contentType = "text"`
 *   - `markdown`  → rendered to HTML via `markdownToHtml`, then `"html"`
 *   - `html`      → trusted as-is (no v0 sanitization)
 */
import type { ActionSpec } from "narai-primitives/toolkit";
import { z } from "zod";
import type { TeamsClient } from "../lib/teams_client.js";
import { markdownToHtml } from "../../_m365/markdown_to_html.js";

export type TeamsActions = Record<string, ActionSpec<any, TeamsClient>>;

export const contentInput = z.union([
  z.object({ format: z.literal("plain"), value: z.string() }),
  z.object({ format: z.literal("markdown"), value: z.string() }),
  z.object({ format: z.literal("html"), value: z.string() }),
]);

export type ContentInput = z.infer<typeof contentInput>;

/**
 * Convert a `ContentInput` into the Graph `body` shape:
 * `{ contentType: "text" | "html", content: string }`.
 */
export function contentInputToGraphBody(
  input: ContentInput,
): { contentType: "text" | "html"; content: string } {
  if (input.format === "plain") {
    return { contentType: "text", content: input.value };
  }
  if (input.format === "markdown") {
    return { contentType: "html", content: markdownToHtml(input.value) };
  }
  return { contentType: "html", content: input.value };
}
