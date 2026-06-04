import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { generateAppJwt } from "../../../src/app-auth/app-jwt.js";

function makeKeyPair(privateKeyType: "pkcs1" | "pkcs8") {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: privateKeyType, format: "pem" },
  });
}

const APP_ID = "123456";
const NOW = 1_700_000_000;

describe("generateAppJwt", () => {
  it.each([["pkcs1"], ["pkcs8"]] as const)(
    "%s 形式の秘密鍵から検証可能な RS256 JWT を生成する",
    async (keyType) => {
      const { privateKey, publicKey } = makeKeyPair(keyType);

      const jwt = await generateAppJwt({ appId: APP_ID, privateKey, nowSeconds: NOW });

      const { payload, protectedHeader } = await jwtVerify(jwt.token, createPublicKey(publicKey), {
        currentDate: new Date(NOW * 1000),
      });
      expect(protectedHeader.alg).toBe("RS256");
      expect(payload.iss).toBe(APP_ID);
      expect(payload.iat).toBe(NOW - 60);
      expect(payload.exp).toBe(NOW + 600);
    },
  );

  it("expiresAt が exp クレームと一致する", async () => {
    const { privateKey } = makeKeyPair("pkcs8");

    const jwt = await generateAppJwt({ appId: APP_ID, privateKey, nowSeconds: NOW });

    expect(jwt.expiresAt.getTime()).toBe((NOW + 600) * 1000);
  });

  it("nowSeconds 未指定時は現在時刻を基準にする", async () => {
    const { privateKey, publicKey } = makeKeyPair("pkcs8");
    const before = Math.floor(Date.now() / 1000);

    const jwt = await generateAppJwt({ appId: APP_ID, privateKey });

    const { payload } = await jwtVerify(jwt.token, createPublicKey(publicKey));
    const after = Math.floor(Date.now() / 1000);
    expect(payload.iat).toBeGreaterThanOrEqual(before - 60);
    expect(payload.iat).toBeLessThanOrEqual(after - 60);
    expect(payload.exp).toBeGreaterThanOrEqual(before + 600);
    expect(payload.exp).toBeLessThanOrEqual(after + 600);
  });

  it("不正な秘密鍵の場合はエラーを throw する", async () => {
    await expect(
      generateAppJwt({ appId: APP_ID, privateKey: "not-a-valid-key", nowSeconds: NOW }),
    ).rejects.toThrow();
  });
});
