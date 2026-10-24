import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { type CallToolResult, createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { validateContract } from "../contract/validate.js";
import { ContractError, type ContractErrorCode } from "./errors.js";
import type { IngestMessage, ResultMessage } from "./ledger.js";
import { RavenClient, validateRavenEndpoint } from "./raven-client.js";

const TOKEN = "service-credential-0123456789abcdef";
const message: ResultMessage = {
  cycleId: "cyc_01jbq3x8n5r7t9v2w4y6z8a0c1",
  candidateId: "cand_01jbq3x8n5r7t9v2w4y6z8a0d1",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  resultVersion: 1,
  kind: "approved",
  post: {
    commentId: 6384700041,
    url: "https://github.com/org/repo/pull/5#issuecomment-6384700041",
  },
  postedAt: "2026-10-25T00:00:00Z",
};
const ok = { schemaVersion: 1, accepted: true, snapshotRevision: 6, terminal: true };
const ingestOk = {
  schemaVersion: 1,
  cycleId: "cyc_01jbq3x8n5r7t9v2w4y6z8a0c1",
  round: 1,
  dispatch: "pending",
  resourceUri: "review-raven://requests/cyc_01jbq3x8n5r7t9v2w4y6z8a0c1",
  deduplicated: false,
};
const ingestMessage: IngestMessage = {
  sourceId: "delivery:0f1e2d3c-0001",
  owner: "scottlz0310",
  repo: "mcp-resource-subscriber",
  prNumber: 226,
  headSha: "0123456789abcdef0123456789abcdef01234567",
  reason: "opened",
  delivery: "webhook",
};

interface FakeRaven {
  url: string;
  received: Array<{ tool: string; authorization: string | undefined; input: unknown }>;
  /** 次の ingest の応答。 */
  replyIngest: () => CallToolResult;
  /** 次の応答を差し替える。 */
  reply: () => CallToolResult | Promise<CallToolResult>;
  /** 設定すると、MCP に入る前に HTTP でこの状態を返す。 */
  httpStatus: number | undefined;
  close(): Promise<void>;
}

async function startFakeRaven(): Promise<FakeRaven> {
  const fake: FakeRaven = {
    url: "",
    received: [],
    replyIngest: () => ({ content: [{ type: "text", text: "{}" }], structuredContent: ingestOk }),
    reply: () => ({ content: [{ type: "text", text: "{}" }], structuredContent: ok }),
    httpStatus: undefined,
    close: async () => {},
  };
  let authorization: string | undefined;
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: "fake-raven", version: "1" });
      server.registerTool(
        "publish_review_result",
        { description: "fake", inputSchema: z.looseObject({}) },
        async (args) => {
          fake.received.push({ tool: "publish_review_result", authorization, input: args });
          return fake.reply();
        },
      );
      server.registerTool(
        "ingest_review_candidate",
        { description: "fake", inputSchema: z.looseObject({}) },
        async (args) => {
          fake.received.push({ tool: "ingest_review_candidate", authorization, input: args });
          return fake.replyIngest();
        },
      );
      return server;
    },
    { legacy: "reject" },
  );
  const nodeHandler = toNodeHandler(handler);
  const http: Server = createServer((req, res) => {
    if (fake.httpStatus !== undefined) {
      res.writeHead(fake.httpStatus).end();
      return;
    }
    authorization = req.headers.authorization;
    void nodeHandler(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/internal/mcp`;
  fake.close = async () => {
    await handler.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  };
  return fake;
}

async function publishError(client: RavenClient): Promise<ContractError> {
  try {
    await client.publish(message);
  } catch (error) {
    if (error instanceof ContractError) return error;
    throw error;
  }
  throw new Error("契約エラーが投げられなかった");
}

describe("validateRavenEndpoint", () => {
  test.each([
    ["https は許可", "https://gateway.example/mcp/raven-internal", true],
    ["loopback の http は許可", "http://127.0.0.1:8080/internal/mcp", true],
    ["localhost の http は許可", "http://localhost:8080/x", true],
    ["外部ホストの http は拒否", "http://gateway.example/mcp", false],
    ["資格情報つきの URL は拒否", "https://user:pass@gateway.example/mcp", false],
    ["query つきの URL は拒否", "https://gateway.example/mcp?x=1", false],
    ["fragment つきの URL は拒否", "https://gateway.example/mcp#x", false],
    ["URL ではない", "not a url", false],
    ["file スキームは拒否", "file:///etc/passwd", false],
  ])("%s", (_name, url, allowed) => {
    if (allowed) {
      expect(validateRavenEndpoint(url)).toBe(new URL(url).toString());
    } else {
      expect(() => validateRavenEndpoint(url)).toThrow();
    }
  });
});

describe("RavenClient", () => {
  let raven: FakeRaven;
  let client: RavenClient;

  beforeEach(async () => {
    raven = await startFakeRaven();
    client = new RavenClient({ endpoint: raven.url, token: TOKEN });
  });

  afterEach(async () => {
    await raven.close();
  });

  test("資格情報を Bearer で送り、契約に適合する入力を送る", async () => {
    await expect(client.publish(message)).resolves.toBeUndefined();
    expect(raven.received).toHaveLength(1);
    expect(raven.received[0].authorization).toBe(`Bearer ${TOKEN}`);
    expect(validateContract("publish_review_result.input", raven.received[0].input)).toEqual({
      ok: true,
    });
    expect(raven.received[0].input).toEqual({ schemaVersion: 1, ...message });
  });

  test("資格情報が空のクライアントは作れない", () => {
    expect(() => new RavenClient({ endpoint: raven.url, token: "  " })).toThrow();
  });

  test.each<[ContractErrorCode, boolean]>([
    ["CANDIDATE_CANCELLED", false],
    ["DELIVERY_EXPIRED", false],
    ["RESULT_VERSION_STALE", false],
    ["RESULT_HEAD_MISMATCH", false],
    ["REQUEST_NOT_FOUND", false],
    ["PERMISSION_DENIED", false],
    ["UNAVAILABLE", true],
  ])("raven の契約のエラー（%s）は、その code を保ち、再送可否は %s", async (code, retryable) => {
    raven.reply = () => ({
      isError: true,
      content: [{ type: "text", text: "{}" }],
      structuredContent: {
        schemaVersion: 1,
        error: { code, message: "scripted", retryable },
      },
    });
    const error = await publishError(client);
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
  });

  test.each([
    [
      "未知の code",
      {
        isError: true,
        content: [{ type: "text" as const, text: "{}" }],
        structuredContent: {
          schemaVersion: 1,
          error: { code: "WEIRD", message: "x", retryable: false },
        },
      },
    ],
    [
      "契約のエラーでないエラー結果",
      { isError: true, content: [{ type: "text" as const, text: "boom" }] },
    ],
    [
      "出力が契約に適合しない成功",
      {
        content: [{ type: "text" as const, text: "{}" }],
        structuredContent: { schemaVersion: 1, accepted: false },
      },
    ],
    ["構造化された結果が無い成功", { content: [{ type: "text" as const, text: "ok" }] }],
  ])("%s は、ACK 未受信と同じ再送可能な失敗（UNAVAILABLE）にする", async (_name, reply) => {
    raven.reply = () => reply as CallToolResult;
    const error = await publishError(client);
    expect(error.code).toBe("UNAVAILABLE");
    expect(error.retryable).toBe(true);
  });

  test.each<[number, ContractErrorCode, boolean]>([
    [401, "PERMISSION_DENIED", false],
    [403, "PERMISSION_DENIED", false],
    [404, "INVALID_ARGUMENT", false],
    [429, "UNAVAILABLE", true],
    [500, "UNAVAILABLE", true],
    [502, "UNAVAILABLE", true],
    [503, "UNAVAILABLE", true],
  ])("HTTP %i は %s（再送可否 %s）。資格情報はエラーに出ない", async (status, code, retryable) => {
    raven.httpStatus = status;
    const error = await publishError(client);
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
    expect(error.message).not.toContain(TOKEN);
  });

  test("接続できないときは、再送可能な UNAVAILABLE（資格情報は出ない）", async () => {
    const dead = new RavenClient({ endpoint: "http://127.0.0.1:1/internal/mcp", token: TOKEN });
    const error = await publishError(dead);
    expect(error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(error.message).not.toContain(TOKEN);
  });

  test("契約に適合しない通知は、送らずに INVALID_ARGUMENT（再送しない）", async () => {
    await expect(client.publish({ ...message, headSha: "NOT-A-SHA" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      retryable: false,
    });
    expect(raven.received).toHaveLength(0);
  });

  describe("ingest_review_candidate", () => {
    test("資格情報を Bearer で送り、契約に適合する入力を送る", async () => {
      await expect(client.ingest(ingestMessage)).resolves.toBeUndefined();
      expect(raven.received).toHaveLength(1);
      expect(raven.received[0].tool).toBe("ingest_review_candidate");
      expect(raven.received[0].authorization).toBe(`Bearer ${TOKEN}`);
      expect(validateContract("ingest_review_candidate.input", raven.received[0].input)).toEqual({
        ok: true,
      });
      expect(raven.received[0].input).toEqual({ schemaVersion: 1, ...ingestMessage });
    });

    test.each<[ContractErrorCode, boolean]>([
      ["PERMISSION_DENIED", false],
      ["INVALID_ARGUMENT", false],
      ["HEAD_CONFLICT", false],
      ["UNAVAILABLE", true],
    ])("raven の契約のエラー（%s）は、その code を保ち、再送可否は %s", async (code, retryable) => {
      raven.replyIngest = () => ({
        isError: true,
        content: [{ type: "text", text: "{}" }],
        structuredContent: { schemaVersion: 1, error: { code, message: "scripted", retryable } },
      });
      await expect(client.ingest(ingestMessage)).rejects.toMatchObject({ code, retryable });
    });

    test("契約に適合しない出力の成功は、再送可能な UNAVAILABLE にする", async () => {
      raven.replyIngest = () => ({
        content: [{ type: "text", text: "{}" }],
        structuredContent: { schemaVersion: 1, cycleId: "nope" },
      });
      await expect(client.ingest(ingestMessage)).rejects.toMatchObject({
        code: "UNAVAILABLE",
        retryable: true,
      });
    });

    test("契約に適合しない通知は、送らずに INVALID_ARGUMENT（再送しない）", async () => {
      await expect(client.ingest({ ...ingestMessage, headSha: "NOT-A-SHA" })).rejects.toMatchObject(
        {
          code: "INVALID_ARGUMENT",
          retryable: false,
        },
      );
      expect(raven.received).toHaveLength(0);
    });

    test("結果の通知と候補の通知は、別の tool に届く", async () => {
      await client.publish(message);
      await client.ingest(ingestMessage);
      expect(raven.received.map((r) => r.tool)).toEqual([
        "publish_review_result",
        "ingest_review_candidate",
      ]);
    });
  });

  test("リダイレクトは追われず、転送先に資格情報を送らない（SDK の挙動を固定する）", async () => {
    const target: Array<string | undefined> = [];
    const other = createServer((req, res) => {
      target.push(req.headers.authorization);
      res.writeHead(200).end();
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const redirector = createServer((_req, res) => {
      res
        .writeHead(307, { location: `http://127.0.0.1:${(other.address() as AddressInfo).port}/x` })
        .end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    try {
      const redirecting = new RavenClient({
        endpoint: `http://127.0.0.1:${(redirector.address() as AddressInfo).port}/internal/mcp`,
        token: TOKEN,
      });
      await expect(redirecting.publish(message)).rejects.toBeInstanceOf(ContractError);
      expect(target).toEqual([]);
    } finally {
      other.closeAllConnections();
      redirector.closeAllConnections();
      await new Promise<void>((resolve) => other.close(() => resolve()));
      await new Promise<void>((resolve) => redirector.close(() => resolve()));
    }
  });
});
