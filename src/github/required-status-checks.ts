// Verdict 投稿前に required status checks を検証する。

import type { GitHubClient } from "./client.js";

export interface RequiredStatusCheck {
  context: string;
  integrationId?: number;
}

export interface StatusCheckResult {
  source: "check-run" | "commit-status";
  context: string;
  integrationId?: number;
  id: number;
  state: string;
  conclusion?: string | null;
}

export interface RequiredStatusCheckVerification {
  requiredCheckCount: number;
}

export type RequiredStatusCheckErrorReason =
  | "configuration"
  | "sha_mismatch"
  | "missing"
  | "not_successful";

export class RequiredStatusCheckError extends Error {
  readonly reason: RequiredStatusCheckErrorReason;
  readonly context?: string;

  constructor(
    reason: RequiredStatusCheckErrorReason,
    message: string,
    options: ErrorOptions = {},
    context?: string,
  ) {
    super(message, options);
    this.name = "RequiredStatusCheckError";
    this.reason = reason;
    this.context = context;
  }
}

interface RecordValue {
  [key: string]: unknown;
}

async function request<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (cause) {
    const status = getHttpStatus(cause);
    throw new Error(
      `GitHub API ${operation} failed${status !== undefined ? ` (status ${status})` : ""}`,
      { cause },
    );
  }
}

function getHttpStatus(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  if (typeof error.status === "number") {
    return error.status;
  }
  return getHttpStatus(error.cause);
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configurationError(message: string, cause?: unknown): RequiredStatusCheckError {
  const causeMessage = cause instanceof Error ? `: ${cause.message}` : "";
  return new RequiredStatusCheckError(
    "configuration",
    `Required status-check configuration is unavailable: ${message}${causeMessage}`,
    cause === undefined ? {} : { cause },
  );
}

function readRecord(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) {
    throw configurationError(`${label} must be an object`);
  }
  return value;
}

function readString(record: RecordValue, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw configurationError(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function readOptionalInteger(record: RecordValue, key: string, label: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw configurationError(`${label}.${key} must be a non-negative integer or null`);
  }
  return value;
}

function readOptionalIntegrationId(
  record: RecordValue,
  key: string,
  label: string,
): number | undefined {
  const value = record[key];
  if (value === -1) {
    return undefined;
  }
  return readOptionalInteger(record, key, label);
}

function requiredStatusCheckKey(check: RequiredStatusCheck): string {
  return `${check.context}\u0000${check.integrationId ?? ""}`;
}

function deduplicateRequiredStatusChecks(
  checks: readonly RequiredStatusCheck[],
): RequiredStatusCheck[] {
  const unique = new Map<string, RequiredStatusCheck>();
  for (const check of checks) {
    unique.set(requiredStatusCheckKey(check), check);
  }
  return [...unique.values()];
}

function parseBranchProtectionChecks(data: unknown): RequiredStatusCheck[] {
  if (data === null) {
    return [];
  }
  const protection = readRecord(data, "branch protection response");
  const rawRequired = protection.required_status_checks;
  if (rawRequired === undefined || rawRequired === null) {
    return [];
  }

  const required = readRecord(rawRequired, "branch protection required_status_checks");
  const checks: RequiredStatusCheck[] = [];

  const rawContexts = required.contexts;
  if (rawContexts !== undefined && !Array.isArray(rawContexts)) {
    throw configurationError("branch protection contexts must be an array");
  }
  for (const [index, context] of (rawContexts ?? []).entries()) {
    if (typeof context !== "string" || context.length === 0) {
      throw configurationError(`branch protection contexts[${index}] must be a non-empty string`);
    }
    checks.push({ context });
  }

  const rawChecks = required.checks;
  if (rawChecks !== undefined && !Array.isArray(rawChecks)) {
    throw configurationError("branch protection checks must be an array");
  }
  for (const [index, rawCheck] of (rawChecks ?? []).entries()) {
    const check = readRecord(rawCheck, `branch protection checks[${index}]`);
    checks.push({
      context: readString(check, "context", `branch protection checks[${index}]`),
      integrationId: readOptionalIntegrationId(
        check,
        "app_id",
        `branch protection checks[${index}]`,
      ),
    });
  }

  return checks;
}

function parseRulesetChecks(rules: readonly unknown[]): RequiredStatusCheck[] {
  const checks: RequiredStatusCheck[] = [];
  for (const [index, rawRule] of rules.entries()) {
    const rule = readRecord(rawRule, `branch rules[${index}]`);
    const type = readString(rule, "type", `branch rules[${index}]`);

    if (type === "workflows") {
      throw configurationError(
        `required workflow rules are not supported (branch rules[${index}])`,
      );
    }
    if (type !== "required_status_checks") {
      continue;
    }

    const parameters = readRecord(rule.parameters, `branch rules[${index}].parameters`);
    const rawChecks = parameters.required_status_checks;
    if (!Array.isArray(rawChecks)) {
      throw configurationError(
        `branch rules[${index}].parameters.required_status_checks must be an array`,
      );
    }
    for (const [checkIndex, rawCheck] of rawChecks.entries()) {
      const check = readRecord(
        rawCheck,
        `branch rules[${index}].parameters.required_status_checks[${checkIndex}]`,
      );
      checks.push({
        context: readString(
          check,
          "context",
          `branch rules[${index}].parameters.required_status_checks[${checkIndex}]`,
        ),
        integrationId: readOptionalIntegrationId(
          check,
          "integration_id",
          `branch rules[${index}].parameters.required_status_checks[${checkIndex}]`,
        ),
      });
    }
  }
  return checks;
}

async function getBranchProtection(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
): Promise<unknown | null> {
  try {
    const response = await request("repos.getBranchProtection", () =>
      client.rest.repos.getBranchProtection({ owner, repo, branch }),
    );
    return response.data;
  } catch (error) {
    if (getHttpStatus(error) === 404) {
      return null;
    }
    throw configurationError("failed to read branch protection", error);
  }
}

async function getBranchRules(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
): Promise<unknown[]> {
  try {
    const rules = await request("repos.getBranchRules", () =>
      client.rest.paginate(client.rest.repos.getBranchRules, {
        owner,
        repo,
        branch,
        per_page: 100,
      }),
    );
    return rules as unknown[];
  } catch (error) {
    throw configurationError("failed to read active branch rules", error);
  }
}

async function listCheckRuns(
  client: GitHubClient,
  owner: string,
  repo: string,
  headSha: string,
): Promise<StatusCheckResult[]> {
  let runs: unknown[];
  try {
    runs = (await request("checks.listForRef", () =>
      client.rest.paginate(client.rest.checks.listForRef, {
        owner,
        repo,
        ref: headSha,
        per_page: 100,
      }),
    )) as unknown[];
  } catch (error) {
    throw configurationError("failed to read check-runs", error);
  }

  return runs.map((rawRun, index) => {
    const run = readRecord(rawRun, `check-runs[${index}]`);
    const returnedHeadSha = readString(run, "head_sha", `check-runs[${index}]`);
    if (returnedHeadSha !== headSha) {
      throw new RequiredStatusCheckError(
        "sha_mismatch",
        `Check run returned head SHA ${returnedHeadSha}, expected ${headSha}`,
      );
    }

    const rawApp = run.app;
    const app =
      rawApp === undefined || rawApp === null ? undefined : readRecord(rawApp, "check app");
    return {
      source: "check-run",
      context: readString(run, "name", `check-runs[${index}]`),
      integrationId: app ? readOptionalInteger(app, "id", `check-runs[${index}].app`) : undefined,
      id: readRequiredInteger(run, "id", `check-runs[${index}]`),
      state: readString(run, "status", `check-runs[${index}]`),
      conclusion: readNullableString(run, "conclusion", `check-runs[${index}]`),
    };
  });
}

async function listCommitStatuses(
  client: GitHubClient,
  owner: string,
  repo: string,
  headSha: string,
): Promise<StatusCheckResult[]> {
  let statuses: unknown[];
  try {
    statuses = (await request("repos.listCommitStatusesForRef", () =>
      client.rest.paginate(client.rest.repos.listCommitStatusesForRef, {
        owner,
        repo,
        ref: headSha,
        per_page: 100,
      }),
    )) as unknown[];
  } catch (error) {
    throw configurationError("failed to read commit statuses", error);
  }

  return statuses.map((rawStatus, index) => {
    const status = readRecord(rawStatus, `commit statuses[${index}]`);
    return {
      source: "commit-status",
      context: readString(status, "context", `commit statuses[${index}]`),
      id: readRequiredInteger(status, "id", `commit statuses[${index}]`),
      state: readString(status, "state", `commit statuses[${index}]`),
    };
  });
}

function readRequiredInteger(record: RecordValue, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw configurationError(`${label}.${key} must be a non-negative integer`);
  }
  return value;
}

function readNullableString(record: RecordValue, key: string, label: string): string | null {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw configurationError(`${label}.${key} must be a string or null`);
  }
  return value;
}

function statusResultKey(result: StatusCheckResult): string {
  return `${result.source}\u0000${result.context}\u0000${result.integrationId ?? ""}`;
}

function deduplicateStatusResults(results: readonly StatusCheckResult[]): StatusCheckResult[] {
  const latest = new Map<string, StatusCheckResult>();
  for (const result of results) {
    const key = statusResultKey(result);
    const previous = latest.get(key);
    if (previous === undefined || result.id > previous.id) {
      latest.set(key, result);
    }
  }
  return [...latest.values()];
}

function formatRequiredCheck(check: RequiredStatusCheck): string {
  return check.integrationId === undefined
    ? `\`${check.context}\``
    : `\`${check.context}\` (integration ${check.integrationId})`;
}

function isSuccessful(result: StatusCheckResult): boolean {
  if (result.source === "commit-status") {
    return result.state === "success";
  }
  return result.state === "completed" && result.conclusion === "success";
}

function describeResult(result: StatusCheckResult): string {
  return result.source === "commit-status"
    ? `status=${result.state}`
    : `status=${result.state}, conclusion=${result.conclusion ?? "null"}`;
}

export function assertRequiredStatusChecksSuccessful(
  requiredChecks: readonly RequiredStatusCheck[],
  results: readonly StatusCheckResult[],
  headSha: string,
): void {
  const uniqueRequiredChecks = deduplicateRequiredStatusChecks(requiredChecks);
  const latestResults = deduplicateStatusResults(results);

  for (const requiredCheck of uniqueRequiredChecks) {
    const candidates = latestResults.filter((result) => {
      if (result.context !== requiredCheck.context) {
        return false;
      }
      if (requiredCheck.integrationId === undefined) {
        return true;
      }
      return result.source === "check-run" && result.integrationId === requiredCheck.integrationId;
    });

    if (candidates.length === 0) {
      throw new RequiredStatusCheckError(
        "missing",
        `Required status check ${formatRequiredCheck(requiredCheck)} is missing on ${headSha}`,
        {},
        requiredCheck.context,
      );
    }
    if (!candidates.every(isSuccessful)) {
      throw new RequiredStatusCheckError(
        "not_successful",
        `Required status check ${formatRequiredCheck(requiredCheck)} is not successful on ${headSha}: ${candidates.map(describeResult).join(", ")}`,
        {},
        requiredCheck.context,
      );
    }
  }
}

export async function verifyRequiredStatusChecks(
  client: GitHubClient,
  owner: string,
  repo: string,
  baseBranch: string,
  headSha: string,
): Promise<RequiredStatusCheckVerification> {
  const [branchProtection, branchRules] = await Promise.all([
    getBranchProtection(client, owner, repo, baseBranch),
    getBranchRules(client, owner, repo, baseBranch),
  ]);
  const requiredChecks = deduplicateRequiredStatusChecks([
    ...parseBranchProtectionChecks(branchProtection),
    ...parseRulesetChecks(branchRules),
  ]);

  if (requiredChecks.length === 0) {
    return { requiredCheckCount: 0 };
  }

  const [checkRuns, commitStatuses] = await Promise.all([
    listCheckRuns(client, owner, repo, headSha),
    listCommitStatuses(client, owner, repo, headSha),
  ]);
  assertRequiredStatusChecksSuccessful(requiredChecks, [...checkRuns, ...commitStatuses], headSha);
  return { requiredCheckCount: requiredChecks.length };
}
