// GitHub App JWT generation (RS256, 10-minute lifetime)

import { createPrivateKey, type KeyObject } from "node:crypto";
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
  const key = importPrivateKey(options.privateKey);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const iat = now - CLOCK_DRIFT_SECONDS;
  const exp = iat + JWT_LIFETIME_SECONDS;

  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setIssuer(options.appId)
    .sign(key);

  return { token, expiresAt: new Date(exp * 1000) };
}

// GitHub App の秘密鍵は PKCS#1（BEGIN RSA PRIVATE KEY）で配布される。
// createPrivateKey は PKCS#1 / PKCS#8 を自動判別するため両形式に対応できる。
function importPrivateKey(privateKey: string): KeyObject {
  try {
    return createPrivateKey(privateKey);
  } catch (cause) {
    throw new Error(
      [
        "GitHub App private key could not be parsed.",
        "Common causes:",
        "- PEM line breaks were replaced with spaces",
        "- GITHUB_APP_PRIVATE_KEY was copied as a single line without \\n escapes",
        "- The key file path points to the wrong file",
        "Recommended:",
        "- Use GITHUB_APP_PRIVATE_KEY_FILE, or",
        "- Use GITHUB_APP_PRIVATE_KEY_B64 for Bitwarden/dsx-based injection",
      ].join("\n"),
      { cause },
    );
  }
}
