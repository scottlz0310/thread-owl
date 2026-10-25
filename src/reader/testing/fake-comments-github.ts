// reader のテスト用の偽 GitHub。コメントの GraphQL 問い合わせと、プロジェクト allowlist の REST 取得に答える。
// 本文は、問い合わせが選択したとき（withBody=true）だけ返す。GitHub と同じ。

import type { GitHubClient } from "../../github/client.js";

export interface RawComment {
  databaseId: number;
  url: string;
  createdAt: string;
  lastEditedAt: string | null;
  body: string;
  author: { login: string; __typename: string } | null;
  state?: string;
}

export function rawComment(
  id: number,
  login: string | null,
  body: string,
  lastEditedAt: string | null = null,
): RawComment {
  return {
    databaseId: id,
    url: `https://github.com/o/r/pull/1#c${id}`,
    createdAt: "2026-10-25T00:00:00Z",
    lastEditedAt,
    body,
    author: login === null ? null : { login, __typename: "Bot" },
  };
}

export function page<T>(next: string | null, ...nodes: T[]) {
  return { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes };
}

export function rawThread(id: string, comments: ReturnType<typeof page<RawComment>>) {
  return { id, isResolved: false, isOutdated: false, path: "main.go", line: 7, comments };
}

export interface FakeCommentsOptions {
  threadPages?: object[];
  // thread の続きのコメント。thread の最初のページの endCursor をキーにする。
  threadExtra?: Record<string, object>;
  reviewPages?: object[];
  issuePages?: object[];
  // null: ファイルなし(404)。文字列: その内容。Error: その失敗。
  projectFile?: string | null | Error;
  // 問い合わせの種類と、その種類で何回目かから、PR の head を返す。
  headFor?: (kind: string, call: number) => string;
}

export interface GraphqlRequest {
  query: string;
  variables: Record<string, unknown>;
}

export const HEAD_A = "1".repeat(40);
export const HEAD_B = "3".repeat(40);
export const BASE_A = "2".repeat(40);

function strip(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) strip(child);
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    delete record.body;
    for (const child of Object.values(record)) strip(child);
  }
}

// ページの列から、cursor の次のページを選ぶ（cursor が無ければ最初のページ）。GitHub と同じく、取得のたびに先頭から辿れる。
function pickPage(pages: object[] | undefined, cursor: unknown): object | undefined {
  if (pages === undefined) return undefined;
  if (cursor === null || cursor === undefined) return pages[0];
  const index = pages.findIndex(
    (p) => (p as { pageInfo: { endCursor: string | null } }).pageInfo.endCursor === cursor,
  );
  return index < 0 ? undefined : pages[index + 1];
}

export function createFakeCommentsGitHub(options: FakeCommentsOptions = {}) {
  const requests: GraphqlRequest[] = [];
  const calls: Record<string, number> = {};
  const emptyPage = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };

  const graphql = async (query: string, variables: Record<string, unknown> = {}) => {
    requests.push({ query, variables });
    if (!query.includes("@include(if: $withBody)")) {
      throw new Error(`the query must select the body through @include(if: $withBody): ${query}`);
    }
    const kind = query.includes("reviewThreads(")
      ? "threads"
      : query.includes("node(id")
        ? "continuation"
        : query.includes("reviews(")
          ? "reviews"
          : "issues";
    const call = calls[kind] ?? 0;
    calls[kind] = call + 1;
    const refs = { headRefOid: options.headFor?.(kind, call) ?? HEAD_A, baseRefOid: BASE_A };

    let data: unknown;
    if (kind === "threads") {
      data = {
        repository: {
          pullRequest: {
            ...refs,
            reviewThreads: structuredClone(
              pickPage(options.threadPages, variables.cursor) ?? emptyPage,
            ),
          },
        },
      };
    } else if (kind === "continuation") {
      data = {
        node: {
          comments: structuredClone(options.threadExtra?.[String(variables.cursor)] ?? emptyPage),
        },
      };
    } else if (kind === "reviews") {
      data = {
        repository: {
          pullRequest: {
            ...refs,
            reviews: structuredClone(pickPage(options.reviewPages, variables.cursor) ?? emptyPage),
          },
        },
      };
    } else {
      data = {
        repository: {
          pullRequest: {
            ...refs,
            comments: structuredClone(pickPage(options.issuePages, variables.cursor) ?? emptyPage),
          },
        },
      };
    }
    if (variables.withBody !== true) strip(data);
    return data;
  };

  const getContentCalls: { path: string; ref: string }[] = [];
  const getContent = async (params: { path: string; ref: string }) => {
    getContentCalls.push({ path: params.path, ref: params.ref });
    const file = options.projectFile;
    if (file === undefined || file === null) {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    }
    if (file instanceof Error) throw file;
    return {
      data: {
        type: "file",
        encoding: "base64",
        size: file.length,
        path: params.path,
        content: Buffer.from(file, "utf8").toString("base64"),
      },
    };
  };

  const client = { graphql, rest: { repos: { getContent } } } as unknown as GitHubClient;
  return {
    client,
    requests,
    getContentCalls,
    bodyAsked: () => requests.some((r) => r.variables.withBody === true),
  };
}
