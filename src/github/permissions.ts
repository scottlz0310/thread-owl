// GitHub App permission verification

export type RequiredPermission = "pull_requests" | "issues" | "contents" | "metadata";

export async function checkPermissions(
  _client: unknown,
  _owner: string,
  _repo: string,
  _required: RequiredPermission[],
): Promise<boolean> {
  throw new Error("not implemented");
}
