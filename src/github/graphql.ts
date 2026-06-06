// GitHub GraphQL API operations (review threads require GraphQL)

import type { GitHubClient } from "./client.js";

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  comments: ReviewThreadComment[];
}

export interface ReviewThreadComment {
  id: string;
  body: string;
  author: string;
  createdAt: string;
  url: string;
}

interface CommentNode {
  id: string;
  body: string;
  author: { login: string } | null;
  createdAt: string;
  url: string;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface CommentConnection {
  pageInfo: PageInfo;
  nodes: CommentNode[];
}

interface ThreadNode {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  comments: CommentConnection;
}

interface ListResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: PageInfo;
        nodes: ThreadNode[];
      };
    };
  };
}

const COMMENT_FIELDS = `
  id
  body
  author {
    login
  }
  createdAt
  url
`;

const THREAD_FIELDS = `
  id
  isResolved
  isOutdated
  path
  line
  comments(first: 100) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {${COMMENT_FIELDS}}
  }
`;

const THREAD_COMMENTS_QUERY = `
  query ($threadId: ID!, $cursor: String) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        comments(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {${COMMENT_FIELDS}}
        }
      }
    }
  }
`;

async function paginateThreadComments(
  client: GitHubClient,
  threadId: string,
  initialConnection: CommentConnection,
): Promise<CommentNode[]> {
  const comments = [...initialConnection.nodes];
  let cursor = initialConnection.pageInfo.hasNextPage ? initialConnection.pageInfo.endCursor : null;

  while (cursor !== null) {
    const res = (await client.graphql(THREAD_COMMENTS_QUERY, {
      threadId,
      cursor,
    })) as { node: { comments: CommentConnection } };
    const connection = res.node.comments;
    comments.push(...connection.nodes);
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  }

  return comments;
}

function mapThread(node: ThreadNode, comments: CommentNode[]): ReviewThread {
  return {
    id: node.id,
    isResolved: node.isResolved,
    isOutdated: node.isOutdated,
    path: node.path,
    line: node.line,
    comments: comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      // author が null になるのは削除済みユーザー等のケース
      author: comment.author?.login ?? "",
      createdAt: comment.createdAt,
      url: comment.url,
    })),
  };
}

export async function listReviewThreads(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ReviewThread[]> {
  const query = `
    query ($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {${THREAD_FIELDS}}
          }
        }
      }
    }
  `;

  const threads: ReviewThread[] = [];
  let cursor: string | null = null;
  do {
    const res = (await client.graphql(query, {
      owner,
      repo,
      pr: prNumber,
      cursor,
    })) as ListResponse;
    const connection = res.repository.pullRequest.reviewThreads;
    for (const node of connection.nodes) {
      const comments = await paginateThreadComments(client, node.id, node.comments);
      threads.push(mapThread(node, comments));
    }
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor !== null);

  return threads;
}

export async function getReviewThread(
  client: GitHubClient,
  threadId: string,
): Promise<ReviewThread | null> {
  const query = `
    query ($threadId: ID!) {
      node(id: $threadId) {
        ... on PullRequestReviewThread {${THREAD_FIELDS}}
      }
    }
  `;

  const res = (await client.graphql(query, { threadId })) as { node: ThreadNode | null };
  if (!res.node) {
    return null;
  }
  const comments = await paginateThreadComments(client, res.node.id, res.node.comments);
  return mapThread(res.node, comments);
}

// スレッドへの返信（GraphQL mutation）。作成された comment node id を返す。
export async function addReviewThreadReply(
  client: GitHubClient,
  threadId: string,
  body: string,
): Promise<string> {
  const mutation = `
    mutation ($threadId: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
        comment {
          id
          url
        }
      }
    }
  `;

  const res = (await client.graphql(mutation, { threadId, body })) as {
    addPullRequestReviewThreadReply: { comment: { id: string; url: string } };
  };
  return res.addPullRequestReviewThreadReply.comment.id;
}

// review thread が属するリポジトリを取得する（write 前の allowlist 照合に使う）。
// mutation は threadId のみで対象を決めるため、引数の owner/repo ではなく実 repo で判定する。
export async function getThreadRepository(
  client: GitHubClient,
  threadId: string,
): Promise<{ owner: string; repo: string } | null> {
  const query = `
    query ($threadId: ID!) {
      node(id: $threadId) {
        ... on PullRequestReviewThread {
          repository {
            name
            owner {
              login
            }
          }
        }
      }
    }
  `;

  const res = (await client.graphql(query, { threadId })) as {
    node: { repository: { name: string; owner: { login: string } } } | null;
  };
  if (!res.node) {
    return null;
  }
  return { owner: res.node.repository.owner.login, repo: res.node.repository.name };
}
