/** Public types for `@narai/connector-hub`. */

import type { ResolvedConnector, LoadOptions, ResolvedConfig } from "narai-primitives/config";
import type { ResolvedAgentCli } from "narai-primitives/toolkit";

export interface GatherInput {
  prompt: string;
  consumer?: string;
  environment?: string;
  extraContext?: string;
}

export interface PlanStep {
  connector: string;
  action: string;
  params: Record<string, unknown>;
}

export interface DispatchError {
  code: string;
  message: string;
}

export interface DispatchResult {
  step: number;
  connector: string;
  action: string;
  params: Record<string, unknown>;
  envelope?: unknown;
  error?: DispatchError;
}

export interface GatherOutput {
  plan: PlanStep[];
  results: DispatchResult[];
}

/** Pluggable planner — an implementation that returns a raw LLM response string. */
export interface Planner {
  plan(systemPrompt: string, userPrompt: string): Promise<string>;
}

/** A resolved connector + the bin needed to invoke it + its SKILL.md content. */
export interface PreparedConnector {
  name: string;
  binCommand: string;
  binArgs: string[];
  skillContent: string;
  slice: ResolvedConnector;
}

/** Options for `child_process.spawn`-style injection. */
export interface SpawnOpts {
  env?: NodeJS.ProcessEnv;
}

/** Minimal handle returned by an injected spawn fn. */
export interface SpawnedHandle {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: "exit", listener: (code: number | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: SpawnOpts,
) => SpawnedHandle;

export type ConfigLoader = (opts: LoadOptions) => Promise<ResolvedConfig>;

/** Resolves a connector's CLI bin from its short name. Defaults to `resolveAgentCli`. */
export type CliResolver = (name: string) => ResolvedAgentCli | null;

export interface GatherDeps {
  planner?: Planner;
  spawnProcess?: SpawnFn;
  configLoader?: ConfigLoader;
  /** Override the default `resolveAgentCli` (used by tests). */
  cliResolver?: CliResolver;
}
