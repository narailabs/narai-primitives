/**
 * fetch_attachment — single-call primitive that fetches a URL, reads the
 * bytes (under a size cap), dispatches to `extractBinary` or UTF-8 decode
 * based on content-type, and returns a structured envelope.
 *
 * Used by REST connectors (Confluence/Notion/Jira/GitHub) to implement
 * `get_attachment` actions without each reimplementing the fetch +
 * extract + checksum pipeline.
 *
 * Contract:
 *   - Never throws on unsupported mime types or missing optional extraction
 *     deps. Surfaces `extracted.format = "skipped"` + a populated `warning`.
 *   - Throws on invalid URL scheme (anything but http/https) before
 *     making the network call.
 *   - Throws when response body exceeds `maxBytes`.
 *   - Returns `{ rawBytes, contentType, filename, checksum, extracted,
 *     sizeBytes, sourceUrl }`. Filename is sanitized via `sanitizeLabel`.
 *
 * For tests, `fetchImpl` can be injected to bypass the real network.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { validateUrl, sanitizeLabel } from "./security_check.js";
import { FETCH_MAX_BYTES_DEFAULT, FETCH_TIMEOUT_MS_DEFAULT, FetchCapExceeded } from "./fetch_helper.js";
import { extract as extractBinary, FORMAT_MAP, type BinaryFormat } from "./extract_binary.js";

export interface FetchAttachmentOptions {
  maxBytes?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export interface FetchAttachmentResult {
  rawBytes: Uint8Array;
  contentType: string;
  filename: string;
  checksum: string;
  extracted: {
    format: "pdf" | "docx" | "pptx" | "text" | "skipped";
    text: string | null;
    warning?: string;
  };
  sizeBytes: number;
  sourceUrl: string;
}

const MIME_TO_FORMAT: Readonly<Record<string, BinaryFormat>> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
};

function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  // Handle quoted: `attachment; filename="a.txt"` and unquoted: `attachment; filename=a.txt`.
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  return match && match[1] ? match[1].trim() : null;
}

function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const tail = u.pathname.split("/").filter(Boolean).pop();
    return tail ?? "attachment";
  } catch {
    return "attachment";
  }
}

function formatExtension(fmt: BinaryFormat): string {
  if (fmt === "pdf") return ".pdf";
  if (fmt === "docx") return ".docx";
  return ".pptx";
}

export async function fetchAttachment(
  url: string,
  opts: FetchAttachmentOptions = {},
): Promise<FetchAttachmentResult> {
  if (!validateUrl(url)) {
    throw new Error(
      `fetchAttachment: invalid URL scheme for '${url}' (only http/https allowed)`,
    );
  }

  const maxBytes = opts.maxBytes ?? FETCH_MAX_BYTES_DEFAULT;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS_DEFAULT;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const init: RequestInit = { signal: controller.signal };
  if (opts.headers !== undefined) {
    init.headers = opts.headers;
  }

  let response: Response;
  try {
    response = await doFetch(url, init);
  } finally {
    clearTimeout(timer);
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new FetchCapExceeded(maxBytes, contentLength, url);
  }

  const buffer = await response.arrayBuffer();
  const rawBytes = new Uint8Array(buffer);
  if (rawBytes.byteLength > maxBytes) {
    throw new FetchCapExceeded(maxBytes, rawBytes.byteLength, url);
  }

  const contentType = (
    response.headers.get("content-type") ?? "application/octet-stream"
  )
    .split(";")[0]
    ?.trim()
    .toLowerCase() ?? "application/octet-stream";

  const dispositionFilename = parseContentDispositionFilename(
    response.headers.get("content-disposition"),
  );
  const rawFilename = dispositionFilename ?? filenameFromUrl(url);
  const filename = sanitizeLabel(rawFilename, 255);

  const checksum = createHash("sha256").update(rawBytes).digest("hex");

  let extracted: FetchAttachmentResult["extracted"];

  if (contentType.startsWith("text/")) {
    extracted = {
      format: "text",
      text: new TextDecoder("utf-8").decode(rawBytes),
    };
  } else if (contentType in MIME_TO_FORMAT) {
    const fmt = MIME_TO_FORMAT[contentType] as BinaryFormat;
    const ext = formatExtension(fmt);
    const tmp = path.join(os.tmpdir(), `toolkit-attach-${randomUUID()}${ext}`);
    try {
      fs.writeFileSync(tmp, rawBytes);
      const r = await extractBinary(tmp, fmt, { maxBytes });
      extracted = { format: r.format, text: r.text };
    } catch (e) {
      extracted = {
        format: "skipped",
        text: null,
        warning: e instanceof Error ? e.message : String(e),
      };
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* best-effort cleanup */
      }
    }
  } else if (FORMAT_MAP[path.extname(filename).toLowerCase()]) {
    // Server advertised a generic mime (octet-stream etc.) but the filename
    // extension is one we can extract — still try.
    const fmt = FORMAT_MAP[path.extname(filename).toLowerCase()] as BinaryFormat;
    const tmp = path.join(
      os.tmpdir(),
      `toolkit-attach-${randomUUID()}${formatExtension(fmt)}`,
    );
    try {
      fs.writeFileSync(tmp, rawBytes);
      const r = await extractBinary(tmp, fmt, { maxBytes });
      extracted = { format: r.format, text: r.text };
    } catch (e) {
      extracted = {
        format: "skipped",
        text: null,
        warning: e instanceof Error ? e.message : String(e),
      };
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* best-effort cleanup */
      }
    }
  } else {
    extracted = {
      format: "skipped",
      text: null,
      warning: `Unsupported mime type '${contentType}' — no extractor configured`,
    };
  }

  return {
    rawBytes,
    contentType,
    filename,
    checksum,
    extracted,
    sizeBytes: rawBytes.byteLength,
    sourceUrl: url,
  };
}
