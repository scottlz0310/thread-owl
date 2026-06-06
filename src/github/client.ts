// Authenticated GitHub client factory

import { graphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";

export interface GitHubClient {
  rest: Octokit;
  graphql: typeof graphql;
}

// installation access token で認証済みの REST / GraphQL クライアントを構築する。
export function createClient(installationToken: string): GitHubClient {
  return {
    rest: new Octokit({ auth: installationToken }),
    graphql: graphql.defaults({
      headers: { authorization: `token ${installationToken}` },
    }),
  };
}
