import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, test, vi } from "vitest";
import { createMcpServer } from "../../../src/mcp/server.js";
import type { ToolDeps } from "../../../src/mcp/tool-deps.js";
import { READ_PR_COMMENTS_TOOL_NAME } from "../../../src/mcp/tools/read-pr-comments.js";
import {
  createFakeCommentsGitHub,
  type FakeCommentsOptions,
  page,
  rawComment,
} from "../../../src/reader/testing/fake-comments-github.js";

function issueCommentsBy(...authors: string[]): FakeCommentsOptions {
  return {
    issuePages: [
      page(null, ...authors.map((login, i) => rawComment(900 + i, login, `text of ${login}`))),
    ],
  };
}

async function connect(fakeOptions: FakeCommentsOptions, trustedCommentAuthors: readonly string[]) {
  const fake = createFakeCommentsGitHub(fakeOptions);
  const getClient = vi.fn(async () => fake.client);
  const deps: ToolDeps = {
    getClient,
    getWriteContext: vi.fn(),
    allowedRepos: [],
    allowedAuthors: [],
    trustedCommentAuthors,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    resolveInstallationId: vi.fn(),
  };
  const server = createMcpServer(deps, { name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { fake, getClient, client, server };
}

async function callRead(client: Client) {
  return client.callTool({
    name: READ_PR_COMMENTS_TOOL_NAME,
    arguments: { owner: "o", repo: "r", prNumber: 1 },
  });
}

interface Payload {
  error: { code: string; details: { comments: unknown[] } };
  issueComments: { body: string }[];
  snapshotId: string;
  pagination: { complete: boolean };
}

function structured(result: Awaited<ReturnType<typeof callRead>>) {
  return result.structuredContent as unknown as Payload;
}

describe("read_pr_comments over MCP", () => {
  test("is listed with the other review tools", async () => {
    const { client, server } = await connect({}, ["thread-owl"]);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain(
      READ_PR_COMMENTS_TOOL_NAME,
    );
    await client.close();
    await server.close();
  });

  test("never asks GitHub for text when an author is not allowed, and the failure carries none", async () => {
    const { fake, client, server } = await connect(issueCommentsBy("thread-owl", "mallory"), [
      "thread-owl",
    ]);
    const result = await callRead(client);

    expect(result.isError).toBe(true);
    expect(fake.bodyAsked()).toBe(false);
    expect(JSON.stringify(result)).not.toContain("text of");
    const envelope = structured(result);
    expect(envelope.error.code).toBe("UNTRUSTED_COMMENT");
    expect(envelope.error.details.comments).toEqual([
      expect.objectContaining({ kind: "issue_comment", author: "mallory" }),
    ]);
    // text content にも同じ envelope がある
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual(envelope);

    await client.close();
    await server.close();
  });

  test("returns the verified text", async () => {
    const { fake, client, server } = await connect(
      issueCommentsBy("thread-owl", "scottlz0310-user"),
      ["thread-owl", "scottlz0310-user"],
    );
    const result = await callRead(client);

    expect(result.isError).toBeFalsy();
    const output = structured(result);
    expect(output.issueComments.map((c) => c.body)).toEqual([
      "text of thread-owl",
      "text of scottlz0310-user",
    ]);
    expect(output.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    expect(output.pagination.complete).toBe(true);
    expect(fake.bodyAsked()).toBe(true);

    await client.close();
    await server.close();
  });

  test("fails closed without a server allowlist, before asking for a GitHub token", async () => {
    const { fake, getClient, client, server } = await connect(issueCommentsBy("thread-owl"), []);
    const result = await callRead(client);

    expect(result.isError).toBe(true);
    expect(structured(result).error.code).toBe("TRUSTED_AUTHORS_NOT_CONFIGURED");
    expect(getClient).not.toHaveBeenCalled();
    expect(fake.requests).toHaveLength(0);

    await client.close();
    await server.close();
  });

  test.each([
    [
      "the file adds the author",
      JSON.stringify({ version: 1, additional_logins: ["ci-bot"] }),
      false,
      undefined,
      true,
    ],
    ["no file adds nobody", null, true, "UNTRUSTED_COMMENT", false],
    [
      "a malformed file stops the reader",
      JSON.stringify({ version: 1 }),
      true,
      "PROJECT_ALLOWLIST_INVALID",
      false,
    ],
  ])("project allowlist: %s", async (_name, projectFile, wantError, wantCode, wantBodyRead) => {
    const { fake, client, server } = await connect(
      { ...issueCommentsBy("thread-owl", "ci-bot"), projectFile },
      ["thread-owl"],
    );
    const result = await callRead(client);

    expect(Boolean(result.isError)).toBe(wantError);
    expect(fake.bodyAsked()).toBe(wantBodyRead);
    if (wantCode !== undefined) expect(structured(result).error.code).toBe(wantCode);

    await client.close();
    await server.close();
  });

  test("a failed GitHub request is an ordinary tool error, not a gate code", async () => {
    const { client, server } = await connect(
      {
        ...issueCommentsBy("thread-owl"),
        projectFile: Object.assign(new Error("boom"), { status: 500 }),
      },
      ["thread-owl"],
    );
    const result = await callRead(client);

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("boom");
    expect(result.structuredContent).toBeUndefined();

    await client.close();
    await server.close();
  });
});
