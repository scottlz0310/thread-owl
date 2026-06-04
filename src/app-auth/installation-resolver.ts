// Resolve GitHub App installation_id from owner/repo
// TODO: implement with @octokit/rest in Phase 1

export async function resolveInstallationId(
  _appJwt: string,
  _owner: string,
  _repo: string,
): Promise<number> {
  throw new Error("not implemented");
}
