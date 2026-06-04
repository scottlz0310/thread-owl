// Authenticated GitHub client factory
// TODO: implement with @octokit/rest + @octokit/graphql in Phase 1

export interface GitHubClient {
  rest: unknown;
  graphql: unknown;
}

export function createClient(_installationToken: string): GitHubClient {
  throw new Error("not implemented");
}
