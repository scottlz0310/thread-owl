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

interface ThreadNode {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  comments: { nodes: CommentNode[] };
}

interface ListResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ThreadNode[];
      };
    };
  };
}

const THREAD_FIELDS = `
  id
  isResolved
  isOutdated
  path
  line
  comments(first: 100) {
    nodes {
      id
      body
      author {
        login
      }
      createdAt
      url
    }
  }
`;

function mapThread(node: ThreadNode): ReviewThread {
  return {
    id: node.id,
    isResolved: node.isResolved,
    isOutdated: node.isOutdated,
    path: node.path,
    line: node.line,
    comments: node.comments.nodes.map((comment) => ({
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
      threads.push(mapThread(node));
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
  return res.node ? mapThread(res.node) : null;
}

// resolveReviewThread（write）は #13 で実装する。
export async function resolveReviewThread(_client: GitHubClient, _threadId: string): Promise<void> {
  throw new Error("not implemented");
}
