// GitHub App JWT generation (RS256, 10-minute lifetime)
// TODO: implement with jsonwebtoken or jose in Phase 1

export interface AppJwtOptions {
  appId: string;
  privateKey: string;
  nowSeconds?: number;
}

export interface AppJwt {
  token: string;
  expiresAt: Date;
}

export function generateAppJwt(_options: AppJwtOptions): AppJwt {
  throw new Error("not implemented");
}
