import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { validateContract } from "../contract/validate.js";
import { createMcpServer } from "../mcp/server.js";
import { type StartedMcpHttpServer, startMcpHttpServer } from "../mcp/transports.js";
import { createReviewQueue } from "../queue/review-queue.js";
import {
  authenticateInternalRequest,
  createInternalEndpoint,
  type InternalEndpoint,
} from "./internal-endpoint.js";
import { ReviewCycleLedger } from "./ledger.js";
import { ResultBinder } from "./result-binder.js";
import { parseServiceAcl } from "./service-acl.js";
import { createFakeGithub } from "./testing/fake-github.js";

const SECRET = "proxy-secret-0123456789abcdef";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const accept = {
  schemaVersion: 1,
  cycleId: "cyc_01jbq3x8n5r7t9v2w4y6z8a0c1",
  round: 1,
  owner: "scottlz0310",
  repo: "mcp-resource-subscriber",
  prNumber: 226,
  headSha: HEAD,
  reason: "opened",
  sourceId: null,
};

describe("authenticateInternalRequest", () => {
  test.each([
    [
      "identity も token も正しい",
      { "x-authenticated-user": "svc-raven", authorization: `Bearer ${SECRET}` },
      { ok: true, principal: "svc-raven" },
    ],
    [
      "identity が無い",
      { authorization: `Bearer ${SECRET}` },
      { ok: false, code: "missing_proxy_identity" },
    ],
    [
      "identity が空白",
      { "x-authenticated-user": "  ", authorization: `Bearer ${SECRET}` },
      { ok: false, code: "missing_proxy_identity" },
    ],
    [
      "token が無い",
      { "x-authenticated-user": "svc-raven" },
      { ok: false, code: "invalid_proxy_token" },
    ],
    [
      "token が違う",
      { "x-authenticated-user": "svc-raven", authorization: "Bearer wrong" },
      { ok: false, code: "invalid_proxy_token" },
    ],
    [
      "Bearer 以外の方式",
      { "x-authenticated-user": "svc-raven", authorization: `Basic ${SECRET}` },
      { ok: false, code: "invalid_proxy_token" },
    ],
  ])("%s", (_name, headers, expected) => {
    expect(authenticateInternalRequest(headers, SECRET)).toEqual(expected);
  });

  test("proxy secret が空なら、どの token も拒否する（fail-closed）", () => {
    expect(
      authenticateInternalRequest(
        { "x-authenticated-user": "svc-raven", authorization: "Bearer " },
        "",
      ),
    ).toEqual({ ok: false, code: "invalid_proxy_token" });
  });
});

describe("内部 MCP endpoint（公開面と同じ HTTP server の別パス）", () => {
  let ledger: ReviewCycleLedger;
  let endpoint: InternalEndpoint;
  let server: StartedMcpHttpServer;

  beforeEach(async () => {
    ledger = new ReviewCycleLedger({
      path: ":memory:",
      newCandidateId: () => "cand_01jbq3x8n5r7t9v2w4y6z8a0d1",
    });
    const queue = createReviewQueue();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    endpoint = createInternalEndpoint({
      path: "/internal/mcp",
      proxySecret: SECRET,
      version: "0.0.0-test",
      deps: {
        ledger,
        acl: parseServiceAcl(
          JSON.stringify({
            services: {
              "svc-raven": {
                actions: ["accept", "cancel", "get_result"],
                repos: ["scottlz0310/*"],
              },
            },
          }),
        ),
        checkOrigin: async () => ({ allowed: true }),
        queue,
        resolveInstallationId: async () => 1,
        binder: new ResultBinder({
          ledger,
          queue,
          getClient: async () => createFakeGithub().client,
          botLogin: "thread-owl[bot]",
          logger,
        }),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      },
    });
    server = await startMcpHttpServer(
      () =>
        createMcpServer(
          {
            getClient: vi.fn(),
            getWriteContext: vi.fn(),
            allowedRepos: [],
            allowedAuthors: [],
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
            resolveInstallationId: vi.fn(),
          },
          { name: "thread-owl", version: "0.0.0-test" },
        ),
      {
        host: "127.0.0.1",
        port: 0,
        fallbackHandler: async (req, res) => {
          if (!(await endpoint.handle(req, res))) {
            res.writeHead(404).end();
          }
        },
      },
    );
  });

  afterEach(async () => {
    await server.close();
    await endpoint.close();
    ledger.close();
  });

  async function connect(path: string, headers: Record<string, string>) {
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}${path}`), {
        requestInit: { headers },
      }),
    );
    return client;
  }

  const serviceHeaders = { "x-authenticated-user": "svc-raven", authorization: `Bearer ${SECRET}` };

  test("認証が無い要求は 401 で、MCP に到達しない", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/internal/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "missing_proxy_identity" });
  });

  test("proxy secret が違う要求は 401", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/internal/mcp`, {
      method: "POST",
      headers: { "x-authenticated-user": "svc-raven", authorization: "Bearer wrong" },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_proxy_token" });
  });

  test("内部面の tool は内部パスにだけあり、公開面の tools/list には出ない", async () => {
    const internal = await connect("/internal/mcp", serviceHeaders);
    const internalNames = (await internal.listTools()).tools.map((t) => t.name).sort();
    expect(internalNames).toEqual([
      "accept_review_candidate",
      "cancel_review_candidate",
      "get_review_result",
    ]);
    await internal.close();

    const publicClient = await connect("/mcp", {});
    const publicNames = (await publicClient.listTools()).tools.map((t) => t.name);
    for (const name of internalNames) {
      expect(publicNames).not.toContain(name);
    }
    await publicClient.close();
  });

  test("tools/list は $ref を展開した自己完結の入力 schema を通知する", async () => {
    const client = await connect("/internal/mcp", serviceHeaders);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(JSON.stringify(tool.inputSchema)).not.toContain("$ref");
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
    await client.close();
  });

  test("accept は structuredContent に契約の出力を返し、再送は duplicate", async () => {
    const client = await connect("/internal/mcp", serviceHeaders);
    const first = await client.callTool({ name: "accept_review_candidate", arguments: accept });
    expect(first.isError).toBeFalsy();
    expect(validateContract("accept_review_candidate.output", first.structuredContent)).toEqual({
      ok: true,
    });
    expect(first.structuredContent).toEqual({
      schemaVersion: 1,
      candidateId: "cand_01jbq3x8n5r7t9v2w4y6z8a0d1",
      duplicate: false,
    });
    const again = await client.callTool({ name: "accept_review_candidate", arguments: accept });
    expect(again.structuredContent).toMatchObject({ duplicate: true });
    await client.close();
  });

  test("不正な入力は isError と契約のエラー envelope（SDK の検証エラーにしない）", async () => {
    const client = await connect("/internal/mcp", serviceHeaders);
    const result = await client.callTool({
      name: "accept_review_candidate",
      arguments: { ...accept, requestedBy: "alice" },
    });
    expect(result.isError).toBe(true);
    expect(validateContract("error", result.structuredContent)).toEqual({ ok: true });
    expect(result.structuredContent).toMatchObject({
      error: { code: "INVALID_ARGUMENT", retryable: false },
    });
    await client.close();
  });

  test("主体の認可は identity から決まる（ACL にないサービスは PERMISSION_DENIED）", async () => {
    const client = await connect("/internal/mcp", {
      ...serviceHeaders,
      "x-authenticated-user": "svc-other",
    });
    const result = await client.callTool({ name: "accept_review_candidate", arguments: accept });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "PERMISSION_DENIED" } });
    expect(ledger.findByCycle(accept.cycleId)).toBeUndefined();
    await client.close();
  });
});
