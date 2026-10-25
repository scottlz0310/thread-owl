// reader の応答（契約の成功 snapshot と失敗 envelope）の整形。

import {
  type AllowlistInfo,
  type CommentKind,
  MAX_MESSAGE_LENGTH,
  type ReaderComment,
  type ReaderGateError,
  type ReaderResult,
  SCHEMA_VERSION,
} from "./reader.js";

export interface OutputComment {
  id: string;
  author: string;
  authorType: string;
  url: string;
  createdAt: string;
  editedAt: string | null;
  state?: string;
  body: string;
}

export interface OutputThread {
  id: string;
  path: string;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  comments: OutputComment[];
}

export interface ReaderOutput {
  schemaVersion: 1;
  snapshotId: string;
  headSha: string;
  baseSha: string;
  allowlist: AllowlistInfo;
  threads: OutputThread[];
  reviews: OutputComment[];
  issueComments: OutputComment[];
  summary: { threads: number; unresolvedThreads: number; reviews: number; issueComments: number };
  pagination: { complete: true };
}

export interface ErrorEnvelope {
  schemaVersion: 1;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: {
      comments: {
        kind: CommentKind;
        id: string;
        threadId?: string;
        author: string;
        authorType: string;
        url: string;
      }[];
    };
  };
}

function outputComment(c: ReaderComment): OutputComment {
  return {
    id: c.id,
    author: c.author,
    authorType: c.authorType,
    url: c.url,
    createdAt: c.createdAt,
    editedAt: c.editedAt === "" ? null : c.editedAt,
    ...(c.state === "" ? {} : { state: c.state }),
    body: c.body ?? "",
  };
}

// 検証済みの結果を、契約の成功応答にする。Result の全コメントは本文を持つ。
export function toOutput(result: ReaderResult): ReaderOutput {
  const s = result.snapshot;
  return {
    schemaVersion: SCHEMA_VERSION,
    snapshotId: result.snapshotId,
    headSha: s.headSha,
    baseSha: s.baseSha,
    allowlist: result.allowlist,
    threads: s.threads.map((t) => ({
      id: t.id,
      path: t.path,
      line: t.line,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      comments: t.comments.map(outputComment),
    })),
    reviews: s.reviews.map(outputComment),
    issueComments: s.issueComments.map(outputComment),
    summary: {
      threads: s.threads.length,
      unresolvedThreads: s.threads.filter((t) => !t.isResolved).length,
      reviews: s.reviews.length,
      issueComments: s.issueComments.length,
    },
    pagination: { complete: true },
  };
}

// 上流のエラーがどれだけ長くても、契約の長さを超えず、文字（コードポイント）の途中では切らない。
export function clampMessage(message: string): string {
  const chars = Array.from(message);
  if (chars.length <= MAX_MESSAGE_LENGTH) return message;
  return `${chars.slice(0, MAX_MESSAGE_LENGTH - 3).join("")}...`;
}

// 失敗を契約の envelope にする。retryable は、PR 側が何も変えなくても同じ呼び出しが後で成功し得る場合だけ。
export function toErrorEnvelope(error: ReaderGateError): ErrorEnvelope {
  const detail: ErrorEnvelope["error"] = {
    code: error.code,
    message: clampMessage(error.detail),
    retryable: error.code === "SNAPSHOT_CHANGED",
  };
  if (error.comments.length > 0) {
    detail.details = {
      comments: error.comments.map((c) => ({
        kind: c.kind,
        id: c.id,
        ...(c.threadId === undefined ? {} : { threadId: c.threadId }),
        author: c.author,
        authorType: c.authorType,
        url: c.url,
      })),
    };
  }
  return { schemaVersion: SCHEMA_VERSION, error: detail };
}
