#!/usr/bin/env node
/**
 * Binary file extraction: PDF, DOCX, PPTX to markdown.
 *
 * TypeScript port of the doc-wiki extract_binary.ts, with additions:
 *   - `maxBytes` size cap (default 50 MiB) enforced before read, raising
 *     `ExtractCapExceeded` so callers can surface the cap in an envelope.
 *   - `extract()` returns a structured `ExtractResult` instead of a bare
 *     string, carrying `{ format, text, sizeBytes }`. The per-format
 *     helpers (`extractPdf` / `extractDocx` / `extractPptx`) continue to
 *     return `string`; the wrapping happens in `extract()`.
 *   - CLI emits JSON instead of plain text so it stays pipe-parseable.
 *
 * Usage as a library:
 *     import { extract, extractPdf } from "./extract_binary.js";
 *     const { text, format, sizeBytes } = await extract("report.pdf");
 *
 * Usage as a script:
 *     node extract_binary.js report.pdf
 *     node extract_binary.js slides.pptx --format pptx
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { importOptional } from "./_optional.js";

// ── Format registry ────────────────────────────────────────────────

export const FORMAT_MAP: Readonly<Record<string, "pdf" | "docx" | "pptx">> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".pptx": "pptx",
};

export type BinaryFormat = "pdf" | "docx" | "pptx";

export { importOptional };

// ── Size cap ───────────────────────────────────────────────────────

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export interface ExtractOptions {
  maxBytes?: number;
}

export interface ExtractResult {
  format: BinaryFormat;
  text: string;
  sizeBytes: number;
}

export class ExtractCapExceeded extends Error {
  constructor(
    public readonly sizeBytes: number,
    public readonly maxBytes: number,
  ) {
    super(`File size ${sizeBytes} exceeds cap ${maxBytes}`);
    this.name = "ExtractCapExceeded";
  }
}

// ── Whitespace normalization ───────────────────────────────────────

/**
 * Normalize extracted plain text so PDF / DOCX / PPTX outputs share the
 * same shape as the Python pipeline:
 *   - strip per-line trailing whitespace
 *   - collapse 3+ consecutive newlines down to exactly 2
 *   - trim leading/trailing whitespace overall
 */
export function normalizeExtracted(text: string): string {
  const stripped = text
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v]+$/, ""))
    .join("\n");
  const collapsed = stripped.replace(/\n{3,}/g, "\n\n");
  return collapsed.trim();
}

// ── PDF extraction ─────────────────────────────────────────────────

interface PdfTextItem {
  str: string;
  hasEOL?: boolean;
}
interface PdfTextContent {
  items: ReadonlyArray<PdfTextItem | { type?: string }>;
}
interface PdfPageProxy {
  getTextContent(): Promise<PdfTextContent>;
}
interface PdfDocumentProxy {
  numPages: number;
  getPage(n: number): Promise<PdfPageProxy>;
  destroy(): Promise<void>;
}
interface PdfLoadingTask {
  promise: Promise<PdfDocumentProxy>;
}
interface PdfJsModule {
  getDocument(src: {
    data: Uint8Array;
    verbosity?: number;
  }): PdfLoadingTask;
  VerbosityLevel?: { ERRORS: number; WARNINGS: number; INFOS: number };
}

/**
 * Extract text from a PDF file using pdfjs-dist's legacy build (Node-safe).
 * Per-format helpers return raw strings; `extract()` wraps into ExtractResult.
 */
export async function extractPdf(filePath: string): Promise<string> {
  const pdfjs = await importOptional<PdfJsModule>(
    "pdfjs-dist/legacy/build/pdf.mjs",
  );
  const data = fs.readFileSync(filePath);
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(data);
  const doc = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const parts: string[] = [];
      for (const item of tc.items) {
        if ("str" in item) {
          parts.push(item.str);
          if (item.hasEOL) parts.push("\n");
        }
      }
      const joined = parts.join("").trim();
      if (joined.length > 0) pages.push(joined);
    }
    return normalizeExtracted(pages.join("\n\n"));
  } finally {
    await doc.destroy();
  }
}

// ── DOCX extraction ────────────────────────────────────────────────

interface MammothResult {
  value: string;
  messages: ReadonlyArray<unknown>;
}
interface MammothModule {
  default?: {
    convertToMarkdown(input: { buffer: Buffer }): Promise<MammothResult>;
  };
  convertToMarkdown?: (input: { buffer: Buffer }) => Promise<MammothResult>;
}

/** Extract text from a DOCX file using mammoth's undocumented `convertToMarkdown`. */
export async function extractDocx(filePath: string): Promise<string> {
  const mod = await importOptional<MammothModule>("mammoth");
  const convertToMarkdown =
    mod.convertToMarkdown ?? mod.default?.convertToMarkdown;
  if (typeof convertToMarkdown !== "function") {
    throw new Error(
      "Missing optional dependency 'mammoth'. Install with: npm install mammoth",
    );
  }
  const buffer = fs.readFileSync(filePath);
  const result = await convertToMarkdown({ buffer });
  const unescaped = result.value
    .replace(/\\([`*_{}\[\]()#+\-.!])/g, "$1")
    .replace(/\\\\/g, "\\");
  return normalizeExtracted(unescaped);
}

// ── PPTX extraction ────────────────────────────────────────────────

interface JsZipObject {
  async(type: "string"): Promise<string>;
}
interface JsZipInstance {
  files: Record<string, JsZipObject>;
  file(path: string): JsZipObject | null;
}
interface JsZipModule {
  default?: { loadAsync(data: Buffer): Promise<JsZipInstance> };
  loadAsync?: (data: Buffer) => Promise<JsZipInstance>;
}

interface XmlParserModule {
  XMLParser: new (opts: Record<string, unknown>) => {
    parse(xml: string): unknown;
  };
}

function collectPptxParagraphs(node: unknown): string[] {
  const paragraphs: string[] = [];

  function visit(n: unknown): void {
    if (n === null || n === undefined) return;
    if (Array.isArray(n)) {
      for (const item of n) visit(item);
      return;
    }
    if (typeof n !== "object") return;

    const obj = n as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (key === "a:p") {
        const paras = Array.isArray(value) ? value : [value];
        for (const p of paras) {
          paragraphs.push(collectRuns(p));
        }
      } else {
        visit(value);
      }
    }
  }

  function collectRuns(p: unknown): string {
    if (p === null || p === undefined) return "";
    if (typeof p !== "object") return "";
    const out: string[] = [];

    function walkRuns(n: unknown): void {
      if (n === null || n === undefined) return;
      if (Array.isArray(n)) {
        for (const item of n) walkRuns(item);
        return;
      }
      if (typeof n !== "object") return;
      const obj = n as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (k === "a:t") {
          const items = Array.isArray(v) ? v : [v];
          for (const item of items) {
            if (typeof item === "string") {
              out.push(item);
            } else if (item !== null && typeof item === "object") {
              const txt = (item as Record<string, unknown>)["#text"];
              if (typeof txt === "string") out.push(txt);
              else if (typeof txt === "number") out.push(String(txt));
            } else if (typeof item === "number") {
              out.push(String(item));
            }
          }
        } else if (k !== "#text" && k !== ":@") {
          walkRuns(v);
        }
      }
    }

    walkRuns(p);
    return out.join("");
  }

  visit(node);
  return paragraphs;
}

/** Extract text from a PPTX file using JSZip + fast-xml-parser. */
export async function extractPptx(filePath: string): Promise<string> {
  const jszipMod = await importOptional<JsZipModule>("jszip");
  const xmlMod = await importOptional<XmlParserModule>("fast-xml-parser");

  const loadAsync = jszipMod.loadAsync ?? jszipMod.default?.loadAsync;
  if (typeof loadAsync !== "function") {
    throw new Error(
      "Missing optional dependency 'jszip'. Install with: npm install jszip",
    );
  }

  const buf = fs.readFileSync(filePath);
  const zip = await loadAsync(buf);

  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => slideIndex(a) - slideIndex(b));

  const parser = new xmlMod.XMLParser({
    ignoreAttributes: true,
    textNodeName: "#text",
    parseTagValue: false,
    trimValues: false,
  });

  const sections: string[] = [];
  for (let i = 0; i < slidePaths.length; i++) {
    const slidePath = slidePaths[i];
    if (slidePath === undefined) continue;
    const entry = zip.file(slidePath);
    if (entry === null) continue;
    const xml = await entry.async("string");
    const tree = parser.parse(xml);
    const paragraphs = collectPptxParagraphs(tree)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const slideText = paragraphs.join("\n\n");
    sections.push(`## Slide ${i + 1}\n\n${slideText}`);
  }
  return normalizeExtracted(sections.join("\n\n"));
}

function slideIndex(p: string): number {
  const m = /slide(\d+)\.xml$/.exec(p);
  return m && m[1] ? parseInt(m[1], 10) : 0;
}

// ── Dispatch ───────────────────────────────────────────────────────

/**
 * Extract text from a binary file to markdown, returning `ExtractResult`.
 *
 * Enforces a size cap (default 50 MiB) before reading the file; throws
 * `ExtractCapExceeded` when exceeded. If `fmt` is not given, auto-detects
 * from the file extension.
 */
export async function extract(
  inputPath: string,
  fmt: BinaryFormat | null = null,
  opts?: ExtractOptions,
): Promise<ExtractResult> {
  let format: BinaryFormat | undefined =
    fmt === null || fmt === undefined ? undefined : fmt;
  if (format === undefined) {
    const ext = path.extname(inputPath).toLowerCase();
    format = FORMAT_MAP[ext];
    if (format === undefined) {
      const supported = Object.keys(FORMAT_MAP).sort().join(", ");
      throw new Error(
        `Unsupported format for '${path.basename(inputPath)}'. ` +
          `Supported extensions: ${supported}`,
      );
    }
  }

  const stat = fs.statSync(inputPath);
  const cap = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  if (stat.size > cap) {
    throw new ExtractCapExceeded(stat.size, cap);
  }

  let text: string;
  if (format === "pdf") text = await extractPdf(inputPath);
  else if (format === "docx") text = await extractDocx(inputPath);
  else if (format === "pptx") text = await extractPptx(inputPath);
  else throw new Error(`Unsupported format: ${format}`);

  return { format, text, sizeBytes: stat.size };
}

// ── CLI ────────────────────────────────────────────────────────────

const HELP_TEXT = `usage: extract_binary.js [-h] [--format {pdf,docx,pptx}] input_file

Extract text from binary files (PDF, DOCX, PPTX). Emits JSON on stdout
containing { format, text, sizeBytes }.

positional arguments:
  input_file            Path to the binary file

options:
  -h, --help            show this help message and exit
  --format {pdf,docx,pptx}
                        Force format (auto-detected if omitted)
`;

interface CliArgs {
  inputFile?: string;
  format?: BinaryFormat;
  help?: boolean;
}

function parseCli(argv: readonly string[]): CliArgs {
  const out: CliArgs = {};
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
    if (a === "--format") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new Error("argument --format: expected one argument");
      }
      out.format = coerceFormat(v);
      i += 2;
      continue;
    }
    if (a.startsWith("--format=")) {
      out.format = coerceFormat(a.slice("--format=".length));
      i++;
      continue;
    }
    if (a.startsWith("-")) {
      throw new Error(`unrecognized arguments: ${a}`);
    }
    if (out.inputFile !== undefined) {
      throw new Error(`unrecognized arguments: ${a}`);
    }
    out.inputFile = a;
    i++;
  }
  return out;
}

function coerceFormat(v: string): BinaryFormat {
  if (v === "pdf" || v === "docx" || v === "pptx") return v;
  throw new Error(
    `argument --format: invalid choice: '${v}' (choose from 'pdf', 'docx', 'pptx')`,
  );
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCli(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (args.inputFile === undefined) {
    process.stderr.write("the following arguments are required: input_file\n");
    return 2;
  }

  const result = await extract(args.inputFile, args.format ?? null);
  process.stdout.write(JSON.stringify(result) + "\n");
  return 0;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${(e as Error).message}\n`);
      process.exit(1);
    },
  );
}
