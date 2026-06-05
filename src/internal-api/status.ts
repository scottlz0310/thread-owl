// Application status endpoint
// secret（token / privateKey / JWT / installation token）は一切含めない。

export interface AppStatus {
  appId: string;
  version: string;
  startedAt: string; // ISO 8601
}

export interface StatusInput {
  appId: string;
  version: string;
  startedAt: Date;
}

export function getStatus(input: StatusInput): AppStatus {
  return {
    appId: input.appId,
    version: input.version,
    startedAt: input.startedAt.toISOString(),
  };
}
