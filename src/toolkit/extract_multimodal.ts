#!/usr/bin/env node
/**
 * extract_multimodal.ts — optional extraction path for images, audio,
 * video, and YouTube URLs.
 *
 * Unlike `extract_binary.ts` which uses npm optional deps (`pdfjs-dist`,
 * `mammoth`, `jszip`), this module treats its external tools as
 * optional-on-PATH:
 *
 *   - **Vision** (`.png .jpg .jpeg .webp .gif .svg`): no tool. Claude
 *     Code's orchestrator reads the image directly via `Read` (native
 *     multimodal). This module just flags the handoff.
 *   - **Audio/video** (`.mp4 .mov .mkv .webm .avi .m4v .mp3 .wav .m4a
 *     .ogg`): needs `faster-whisper` on `PATH`. Missing → skip with
 *     install-hint warning.
 *   - **YouTube / remote AV** (`youtu.be/*`, `youtube.com/watch?v=*`):
 *     needs `yt-dlp` + `faster-whisper`. Either missing → skip.
 *
 * Gated by `multimodal.enabled` config: `"off"` (always skip),
 * `"optional"` (probe PATH), `"on"` (same as optional but the caller
 * asserts tools should be present; still skips rather than raises).
 *
 * CLI: emits JSON on stdout; the warning, if any, also goes to stderr.
 * Exits 0 on success/skip, 2 on CLI misuse.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isBinaryOnPath } from "./_optional.js";

// ── Feature flag ────────────────────────────────────────────────────

export type MultimodalMode = "on" | "optional" | "off";

function normalizeMode(raw: unknown): MultimodalMode {
  if (raw === "on" || raw === true) return "on";
  if (raw === "off" || raw === false) return "off";
  return "optional";
}

// ── Dispatch shape ──────────────────────────────────────────────────

export type MultimodalFormat = "vision" | "audio_video" | "youtube" | "skipped";

export interface MultimodalResult {
  format: MultimodalFormat;
  warning?: string;
  handoff?: string;
  input?: string;
}

// ── Extension classification ────────────────────────────────────────

export const VISION_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".svg",
]);

export const AUDIO_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".avi",
  ".m4v",
  ".mp3",
  ".wav",
  ".m4a",
  ".ogg",
]);

const YOUTUBE_URL_RE =
  /^https?:\/\/(?:www\.)?(?:youtu\.be\/|youtube\.com\/watch\?v=)/i;

function isYoutubeUrl(s: string): boolean {
  return YOUTUBE_URL_RE.test(s);
}

function extOf(s: string): string {
  return path.extname(s).toLowerCase();
}

// ── Warning strings (standardized — callers may grep for these) ─────

const WARN_PREFIX = "multimodal:";

function warnDisabled(): string {
  return `${WARN_PREFIX} disabled in config (multimodal.enabled: off). Set to "optional" or "on" to re-enable.`;
}

function warnMissingWhisper(): string {
  return `${WARN_PREFIX} faster-whisper not on PATH. Install with 'pipx install faster-whisper' (or 'pip install faster-whisper').`;
}

function warnMissingYtDlp(): string {
  return `${WARN_PREFIX} yt-dlp not on PATH. Install with 'brew install yt-dlp' or 'pipx install yt-dlp', then re-run.`;
}

function warnMissingBoth(): string {
  return `${WARN_PREFIX} both yt-dlp and faster-whisper missing on PATH. YouTube ingest needs both. Install: 'brew install yt-dlp && pipx install faster-whisper'.`;
}

function warnUnknownFormat(input: string): string {
  return `${WARN_PREFIX} '${input}' does not match any multimodal extension or URL pattern. Supported: ${[...VISION_EXTENSIONS].join(", ")} (vision); ${[...AUDIO_VIDEO_EXTENSIONS].join(", ")} (audio/video); YouTube URLs.`;
}

// ── Dispatch ────────────────────────────────────────────────────────

export interface MultimodalConfig {
  enabled?: unknown;
}

/**
 * Route an input (file path or URL) to the right multimodal handler.
 * Never throws. `format === "skipped"` + populated `warning` is the
 * universal "nothing happened" signal.
 */
export function dispatchMultimodal(
  input: string,
  cfg: MultimodalConfig = {},
): MultimodalResult {
  const mode = normalizeMode(cfg.enabled);
  if (mode === "off") {
    return { format: "skipped", warning: warnDisabled() };
  }

  if (isYoutubeUrl(input)) {
    const hasYtDlp = isBinaryOnPath("yt-dlp");
    const hasWhisper = isBinaryOnPath("faster-whisper");
    if (!hasYtDlp && !hasWhisper) {
      return { format: "skipped", warning: warnMissingBoth() };
    }
    if (!hasYtDlp) {
      return { format: "skipped", warning: warnMissingYtDlp() };
    }
    if (!hasWhisper) {
      return { format: "skipped", warning: warnMissingWhisper() };
    }
    return {
      format: "youtube",
      handoff: "yt-dlp -x --audio-format wav | faster-whisper",
      input,
    };
  }

  const ext = extOf(input);

  if (VISION_EXTENSIONS.has(ext)) {
    return {
      format: "vision",
      handoff: "orchestrator-reads-image",
      input,
    };
  }

  if (AUDIO_VIDEO_EXTENSIONS.has(ext)) {
    if (!isBinaryOnPath("faster-whisper")) {
      return { format: "skipped", warning: warnMissingWhisper() };
    }
    return {
      format: "audio_video",
      handoff: "faster-whisper",
      input,
    };
  }

  return { format: "skipped", warning: warnUnknownFormat(input) };
}

// ── CLI ─────────────────────────────────────────────────────────────

interface ParsedArgs {
  input?: string;
  enabled?: string;
  help?: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {};
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === undefined) {
      i++;
      continue;
    }
    if (a === "-h" || a === "--help") {
      out.help = true;
      i++;
      continue;
    }
    if (a === "--enabled") {
      out.enabled = argv[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (a.startsWith("--enabled=")) {
      out.enabled = a.slice("--enabled=".length);
      i++;
      continue;
    }
    if (a.startsWith("--")) {
      throw new Error(`unrecognized argument: ${a}`);
    }
    if (out.input === undefined) {
      out.input = a;
      i++;
      continue;
    }
    throw new Error(`unexpected extra positional: ${a}`);
  }
  return out;
}

const HELP_TEXT = `usage: extract_multimodal.js <input> [--enabled on|off|optional]

Classify an image / audio / video / YouTube URL and probe for the
required external tool. Returns JSON describing the dispatch result.

positional arguments:
  <input>               File path or URL

options:
  --enabled MODE        Override multimodal.enabled (on|off|optional)
  -h, --help            Show this help and exit
`;

export function main(
  argv: readonly string[] = process.argv.slice(2),
): number {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  if (args.input === undefined || args.input === "") {
    process.stderr.write("required: <input> (file path or URL)\n");
    return 2;
  }

  const cfg: MultimodalConfig = {};
  if (args.enabled !== undefined && args.enabled !== "") {
    cfg.enabled = args.enabled;
  }
  const result = dispatchMultimodal(args.input, cfg);

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (result.warning !== undefined) {
    process.stderr.write(`${result.warning}\n`);
  }
  return 0;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  process.exit(main());
}
