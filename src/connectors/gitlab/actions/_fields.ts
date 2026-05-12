/**
 * Zod field schemas shared across GitLab action modules. Each constraint
 * mirrors what GitLab's API expects so that errors surface at the
 * connector boundary rather than as 422s from upstream.
 */
import { z } from "zod";

export const namespaceField = z
  .string()
  .regex(
    /^[a-zA-Z0-9_.-][a-zA-Z0-9_./-]*$/,
    "namespace: alphanumeric, dots, dashes, underscores, or slash-separated subgroups (no leading/trailing slash)",
  )
  .refine((v) => !v.includes("//"), {
    message: "namespace: consecutive slashes are not allowed",
  })
  .refine((v) => !v.endsWith("/"), {
    message: "namespace: trailing slash is not allowed",
  });

export const projectField = z
  .string()
  .regex(
    /^[a-zA-Z0-9_.-]+$/,
    "project: alphanumeric, dots, dashes, underscores only",
  );

export const mrIidField = z.coerce.number().int().positive();
export const issueIidField = z.coerce.number().int().positive();
export const pipelineIdField = z.coerce.number().int().positive();
export const jobIdField = z.coerce.number().int().positive();
export const noteIdField = z.coerce.number().int().positive();
export const linkIdField = z.coerce.number().int().positive();

export const releaseTagField = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._/+-]+$/, "Invalid tag");

/** Accepts branch names, tag names, and commit SHAs. */
export const refField = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._/+-]+$/, "Invalid ref — must be a branch, tag, or SHA");

export const shaField = z
  .string()
  .regex(/^[a-f0-9]{7,40}$/, "Invalid SHA — must be 7-40 hex characters");

export const filePathField = z
  .string()
  .min(1, "get_file requires a non-empty 'path'")
  .regex(
    /^[a-zA-Z0-9_./ -]+$/,
    "Invalid path — must be a valid file path",
  )
  .refine((p) => !p.includes(".."), {
    message: "Path traversal not allowed — '..' is forbidden",
  });
