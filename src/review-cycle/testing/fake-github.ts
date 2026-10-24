// review-cycle のテスト用の偽 GitHub。PR の issue comment と review の一覧だけを返す（照合の検証に使う）。
import type { GitHubClient } from "../../github/client.js";

export interface FakePost {
  kind: "comment" | "review";
  id: number;
  body: string;
  login: string;
  createdAt: string;
}

export interface FakeGithub {
  posts: FakePost[];
  /** true にすると、一覧の取得が失敗する（照合できない状態）。 */
  failing: boolean;
  client: GitHubClient;
}

export function createFakeGithub(): FakeGithub {
  const comments = Symbol("issues.listComments");
  const reviews = Symbol("pulls.listReviews");
  const fake: FakeGithub = {
    posts: [],
    failing: false,
    client: undefined as unknown as GitHubClient,
  };
  fake.client = {
    rest: {
      issues: { listComments: comments },
      pulls: { listReviews: reviews },
      paginate: async (route: symbol) => {
        if (fake.failing) {
          throw new Error("github unavailable");
        }
        const kind = route === comments ? "comment" : "review";
        return fake.posts
          .filter((post) => post.kind === kind)
          .map((post) => ({
            id: post.id,
            body: post.body,
            user: { login: post.login },
            created_at: post.createdAt,
            submitted_at: post.createdAt,
          }));
      },
    },
  } as unknown as GitHubClient;
  return fake;
}
