// GitHub App JWT generation (RS256, 10-minute lifetime)

import { createPrivateKey } from "node:crypto";
import { SignJWT } from "jose";

export interface AppJwtOptions {
  appId: string;
  privateKey: string;
  nowSeconds?: number;
}

export interface AppJwt {
  token: string;
  expiresAt: Date;
}

// iat を過去にずらしてサーバー間のクロックドリフトを吸収する（GitHub 推奨）
const CLOCK_DRIFT_SECONDS = 60;
// GitHub が許容する App JWT の有効期間上限は 10 分
const JWT_LIFETIME_SECONDS = 600;

export async function generateAppJwt(options: AppJwtOptions): Promise<AppJwt> {
  // GitHub App の秘密鍵は PKCS#1（BEGIN RSA PRIVATE KEY）で配布される。
  // createPrivateKey は PKCS#1 / PKCS#8 を自動判別するため両形式に対応できる。
  const key = createPrivateKey(options.privateKey);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const iat = now - CLOCK_DRIFT_SECONDS;
  const exp = now + JWT_LIFETIME_SECONDS;

  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setIssuer(options.appId)
    .sign(key);

  return { token, expiresAt: new Date(exp * 1000) };
}
