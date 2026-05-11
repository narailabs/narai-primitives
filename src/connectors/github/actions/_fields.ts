/**
 * Zod field schemas shared across action modules. Each constraint
 * mirrors what GitHub's API expects so that errors surface at the
 * connector boundary rather than as 422s from upstream.
 */
import { z } from "zod";

export const ownerRepoField = z
  .string()
  .regex(
    /^[a-zA-Z0-9_.-]+$/,
    "owner/repo: alphanumeric, dots, dashes, underscores only",
  );

export const issueNumberField = z.coerce.number().int().positive();
export const pullNumberField = z.coerce.number().int().positive();

export const branchField = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._/+-]+$/, "Invalid branch name");

export const tagField = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._/+-]+$/, "Invalid tag");

/**
 * PR head ref — accepts the local `branch` form AND the cross-repo
 * `owner:branch` form GitHub uses for fork-originated pull requests.
 * Use this only for the `head` field of create_pull_request.
 */
export const prHeadField = z
  .string()
  .min(1)
  .regex(
    /^[A-Za-z0-9._/+-]+(:[A-Za-z0-9._/+-]+)?$/,
    "Invalid PR head — must be 'branch' or 'owner:branch'",
  );
