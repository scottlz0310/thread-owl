// reader の GitHub 側の取得（ReaderSource の実装）。
//
// 本文は GraphQL の `@include(if: $withBody)` で選択する。withBody=false の問い合わせは、
// 本文のフィールドを GitHub へ要求しない。投稿者の検証は、その応答で行う。

import type { GitHubClient } from "../github/client.js";
import { PROJECT_FILE_PATH, parseProjectFile } from "./project-allowlist.js";
import {
  type CommentKind,
  type ProjectAllowlist,
  ProjectAllowlistInvalidError,
  type ReaderComment,
  type ReaderSnapshot,
  type ReaderSource,
  type ReaderThread,
  SnapshotMovedError,
} from "./reader.js";

// プロジェクトの allowlist ファイルの大きさの上限。短い login の一覧で、これを超えるのは設定ではなく誤り。
const MAX_PROJECT_FILE_BYTES = 64 * 1024;

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface CommentNode {
  databaseId: number | null;
  url: string;
  createdAt: string;
  lastEditedAt: string | null;
  body?: string;
  author: { login: string; __typename: string } | null;
  // review body だけ
  state?: string;
}

interface ThreadNode {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  comments: { pageInfo: PageInfo; nodes: CommentNode[] };
}

interface PullRequestRefs {
  headRefOid: string;
  baseRefOid: string;
}

const COMMENT_FIELDS = `
  databaseId
  url
  createdAt
  lastEditedAt
  body @include(if: $withBody)
  author {
    login
    __typename
  }
`;

const THREADS_QUERY = `
  query ($owner: String!, $repo: String!, $pr: Int!, $cursor: String, $withBody: Boolean!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        headRefOid
        baseRefOid
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            comments(first: 50) {
              pageInfo { hasNextPage endCursor }
              nodes { ${COMMENT_FIELDS} }
            }
          }
        }
      }
    }
  }
`;

const THREAD_COMMENTS_QUERY = `
  query ($id: ID!, $cursor: String, $withBody: Boolean!) {
    node(id: $id) {
      ... on PullRequestReviewThread {
        comments(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { ${COMMENT_FIELDS} }
        }
      }
    }
  }
`;

const REVIEWS_QUERY = `
  query ($owner: String!, $repo: String!, $pr: Int!, $cursor: String, $withBody: Boolean!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        headRefOid
        baseRefOid
        reviews(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { state ${COMMENT_FIELDS} }
        }
      }
    }
  }
`;

const ISSUE_COMMENTS_QUERY = `
  query ($owner: String!, $repo: String!, $pr: Int!, $cursor: String, $withBody: Boolean!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        headRefOid
        baseRefOid
        comments(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { ${COMMENT_FIELDS} }
        }
      }
    }
  }
`;

function toComment(kind: CommentKind, node: CommentNode, withBodies: boolean): ReaderComment {
  return {
    kind,
    id: node.databaseId !== null && node.databaseId > 0 ? String(node.databaseId) : "",
    author: node.author?.login ?? "",
    authorType: node.author?.__typename ?? "",
    url: node.url,
    createdAt: node.createdAt,
    editedAt: node.lastEditedAt ?? "",
    state: node.state ?? "",
    body: withBodies ? (node.body ?? "") : null,
  };
}

function nextCursor(page: PageInfo): string | null {
  if (!page.hasNextPage) return null;
  if (page.endCursor === null || page.endCursor === "") {
    throw new Error("graphql query returned hasNextPage=true with an empty endCursor");
  }
  return page.endCursor;
}

export interface GitHubSourceTarget {
  owner: string;
  repo: string;
  prNumber: number;
}

// getClient は、最初に GitHub へ問い合わせるときまで呼ばない（installation token の発行を伴うため。
// 信頼する投稿者が未設定で止まるときは、GitHub へ一切問い合わせない）。
export function createGitHubReaderSource(
  getClient: () => Promise<GitHubClient>,
  target: GitHubSourceTarget,
): ReaderSource {
  const { owner, repo, prNumber } = target;
  let clientPromise: Promise<GitHubClient> | undefined;
  const clientOnce = (): Promise<GitHubClient> => {
    clientPromise ??= getClient();
    return clientPromise;
  };

  // thread の最初のページに載らない続きのコメントまで読む。
  async function readThread(node: ThreadNode, withBodies: boolean): Promise<ReaderThread> {
    const client = await clientOnce();
    const thread: ReaderThread = {
      id: node.id,
      path: node.path ?? "",
      line: node.line,
      isResolved: node.isResolved,
      isOutdated: node.isOutdated,
      comments: node.comments.nodes.map((c) => toComment("review_thread_comment", c, withBodies)),
    };
    let cursor = nextCursor(node.comments.pageInfo);
    while (cursor !== null) {
      const data: { node: { comments: { pageInfo: PageInfo; nodes: CommentNode[] } } } =
        await client.graphql(THREAD_COMMENTS_QUERY, { id: node.id, cursor, withBody: withBodies });
      const page = data.node.comments;
      for (const c of page.nodes) {
        thread.comments.push(toComment("review_thread_comment", c, withBodies));
      }
      cursor = nextCursor(page.pageInfo);
    }
    return thread;
  }

  async function fetchSnapshot(withBodies: boolean): Promise<ReaderSnapshot> {
    const client = await clientOnce();
    const snapshot: ReaderSnapshot = {
      headSha: "",
      baseSha: "",
      threads: [],
      reviews: [],
      issueComments: [],
    };
    let haveRefs = false;
    // 問い合わせごとに head / base を比べる。取得中に動いたら、検証を引き継げない。
    const setRefs = (refs: PullRequestRefs): void => {
      if (!haveRefs) {
        snapshot.headSha = refs.headRefOid;
        snapshot.baseSha = refs.baseRefOid;
        haveRefs = true;
        return;
      }
      if (snapshot.headSha !== refs.headRefOid || snapshot.baseSha !== refs.baseRefOid) {
        throw new SnapshotMovedError();
      }
    };
    const variables = (cursor: string | null) => ({
      owner,
      repo,
      pr: prNumber,
      cursor,
      withBody: withBodies,
    });

    // review threads
    let cursor: string | null = null;
    do {
      const data: {
        repository: {
          pullRequest: PullRequestRefs & {
            reviewThreads: { pageInfo: PageInfo; nodes: ThreadNode[] };
          };
        };
      } = await client.graphql(THREADS_QUERY, variables(cursor));
      const pr = data.repository.pullRequest;
      setRefs(pr);
      for (const node of pr.reviewThreads.nodes) {
        snapshot.threads.push(await readThread(node, withBodies));
      }
      cursor = nextCursor(pr.reviewThreads.pageInfo);
    } while (cursor !== null);

    // review bodies
    cursor = null;
    do {
      const data: {
        repository: {
          pullRequest: PullRequestRefs & { reviews: { pageInfo: PageInfo; nodes: CommentNode[] } };
        };
      } = await client.graphql(REVIEWS_QUERY, variables(cursor));
      const pr = data.repository.pullRequest;
      setRefs(pr);
      for (const node of pr.reviews.nodes) {
        snapshot.reviews.push(toComment("review_body", node, withBodies));
      }
      cursor = nextCursor(pr.reviews.pageInfo);
    } while (cursor !== null);

    // issue comments
    cursor = null;
    do {
      const data: {
        repository: {
          pullRequest: PullRequestRefs & { comments: { pageInfo: PageInfo; nodes: CommentNode[] } };
        };
      } = await client.graphql(ISSUE_COMMENTS_QUERY, variables(cursor));
      const pr = data.repository.pullRequest;
      setRefs(pr);
      for (const node of pr.comments.nodes) {
        snapshot.issueComments.push(toComment("issue_comment", node, withBodies));
      }
      cursor = nextCursor(pr.comments.pageInfo);
    } while (cursor !== null);

    return snapshot;
  }

  // base ref のプロジェクト allowlist。存在しなければ追加なし。存在して読めなければ、ゲートを止める。
  async function projectAllowlist(baseSha: string): Promise<ProjectAllowlist> {
    const client = await clientOnce();
    let data: unknown;
    try {
      const response = await client.rest.repos.getContent({
        owner,
        repo,
        path: PROJECT_FILE_PATH,
        ref: baseSha,
      });
      data = response.data;
    } catch (error) {
      if ((error as { status?: number } | null)?.status === 404) return { state: "absent" };
      throw error;
    }
    const notRegular = new ProjectAllowlistInvalidError(
      `${PROJECT_FILE_PATH} is not a regular file`,
    );
    if (Array.isArray(data) || typeof data !== "object" || data === null) throw notRegular;
    const file = data as { type?: string; encoding?: string; size?: number; content?: string };
    if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string") {
      throw notRegular;
    }
    if ((file.size ?? 0) > MAX_PROJECT_FILE_BYTES) {
      throw new ProjectAllowlistInvalidError(
        `${PROJECT_FILE_PATH} is larger than ${MAX_PROJECT_FILE_BYTES} bytes`,
      );
    }
    try {
      return {
        state: "present",
        logins: parseProjectFile(Buffer.from(file.content, "base64").toString("utf8")),
      };
    } catch (error) {
      throw new ProjectAllowlistInvalidError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return { fetch: fetchSnapshot, projectAllowlist };
}
