import { describe, expect, test } from "vitest";
import { createGitHubReaderSource } from "./github-source.js";
import { ProjectAllowlistInvalidError, SnapshotMovedError } from "./reader.js";
import {
  BASE_A,
  createFakeCommentsGitHub,
  type FakeCommentsOptions,
  HEAD_A,
  HEAD_B,
  page,
  rawComment,
  rawThread,
} from "./testing/fake-comments-github.js";

const target = { owner: "o", repo: "r", prNumber: 1 };

function fullOptions(): FakeCommentsOptions {
  return {
    // 2 ページの thread。1 つ目の thread は最初のページに 2 件、続きに 1 件のコメントを持つ。
    threadPages: [
      page(
        "T1",
        rawThread(
          "PRRT_1",
          page(
            "C1",
            rawComment(101, "thread-owl", "first"),
            rawComment(102, "review-raven", "second", "2026-10-25T01:00:00Z"),
          ),
        ),
      ),
      page(null, rawThread("PRRT_2", page(null, rawComment(103, "thread-owl", "other")))),
    ],
    threadExtra: {
      C1: page(null, rawComment(104, "thread-owl", "third (on the continuation page)")),
    },
    reviewPages: [
      page("R1", { ...rawComment(201, "thread-owl", "review one"), state: "COMMENTED" }),
      page(null, { ...rawComment(202, "thread-owl", "review two"), state: "APPROVED" }),
    ],
    issuePages: [
      page("I1", rawComment(301, "codecov", "report")),
      page(null, rawComment(302, "scottlz0310-user", "note")),
    ],
  };
}

const ids = (comments: { id: string }[]) => comments.map((c) => c.id).join(",");

describe("createGitHubReaderSource.fetch", () => {
  test("walks every page of every kind, including a thread's continuation pages", async () => {
    const fake = createFakeCommentsGitHub(fullOptions());
    const snapshot = await createGitHubReaderSource(async () => fake.client, target).fetch(true);

    expect([snapshot.headSha, snapshot.baseSha]).toEqual([HEAD_A, BASE_A]);
    expect(snapshot.threads.map((t) => ids(t.comments))).toEqual(["101,102,104", "103"]);
    expect(ids(snapshot.reviews)).toBe("201,202");
    expect(ids(snapshot.issueComments)).toBe("301,302");

    const edited = snapshot.threads[0].comments[1];
    expect(edited).toMatchObject({
      author: "review-raven",
      authorType: "Bot",
      editedAt: "2026-10-25T01:00:00Z",
      kind: "review_thread_comment",
    });
    expect(snapshot.threads[0].comments[0].editedAt).toBe("");
    expect(snapshot.reviews[1]).toMatchObject({ state: "APPROVED", kind: "review_body" });
    expect(snapshot.threads[0].comments[2].body).toBe("third (on the continuation page)");
    expect(fake.requests.every((r) => r.variables.withBody === true)).toBe(true);
  });

  test("a metadata read never selects a body", async () => {
    const fake = createFakeCommentsGitHub(fullOptions());
    const snapshot = await createGitHubReaderSource(async () => fake.client, target).fetch(false);

    expect(fake.requests.length).toBeGreaterThan(0);
    expect(fake.requests.every((r) => r.variables.withBody === false)).toBe(true);
    const all = [
      ...snapshot.threads.flatMap((t) => t.comments),
      ...snapshot.reviews,
      ...snapshot.issueComments,
    ];
    expect(all).toHaveLength(8);
    for (const c of all) {
      expect(c.body).toBeNull();
      expect(c.author).not.toBe("");
    }
  });

  test("reports an unknown author as an empty login", async () => {
    const fake = createFakeCommentsGitHub({
      issuePages: [page(null, rawComment(301, null, "ghost"))],
    });
    const snapshot = await createGitHubReaderSource(async () => fake.client, target).fetch(false);
    expect(snapshot.issueComments[0]).toMatchObject({ author: "", authorType: "" });
  });

  test("reports a moved pull request when the head changes between queries", async () => {
    const fake = createFakeCommentsGitHub({
      ...fullOptions(),
      headFor: (kind) => (kind === "reviews" ? HEAD_B : HEAD_A),
    });
    await expect(
      createGitHubReaderSource(async () => fake.client, target).fetch(false),
    ).rejects.toBeInstanceOf(SnapshotMovedError);
  });

  test("rejects a page without a cursor", async () => {
    const fake = createFakeCommentsGitHub({
      threadPages: [{ pageInfo: { hasNextPage: true, endCursor: "" }, nodes: [] }],
    });
    await expect(
      createGitHubReaderSource(async () => fake.client, target).fetch(false),
    ).rejects.toThrow("empty endCursor");
  });

  test("does not ask for a GitHub client until the first query", async () => {
    let asked = 0;
    const fake = createFakeCommentsGitHub();
    const source = createGitHubReaderSource(async () => {
      asked++;
      return fake.client;
    }, target);
    expect(asked).toBe(0);
    await source.fetch(false);
    await source.fetch(false);
    expect(asked).toBe(1);
  });
});

describe("createGitHubReaderSource.projectAllowlist", () => {
  const valid = JSON.stringify({ version: 1, additional_logins: ["CI-Bot[bot]"] });

  test("reads the file at the base commit", async () => {
    const fake = createFakeCommentsGitHub({ projectFile: valid });
    const result = await createGitHubReaderSource(async () => fake.client, target).projectAllowlist(
      BASE_A,
    );
    expect(result).toEqual({ state: "present", logins: ["ci-bot"] });
    expect(fake.getContentCalls).toEqual([
      { path: ".review-raven/trusted-comment-authors.json", ref: BASE_A },
    ]);
  });

  test("a missing file adds nobody", async () => {
    const fake = createFakeCommentsGitHub({ projectFile: null });
    await expect(
      createGitHubReaderSource(async () => fake.client, target).projectAllowlist(BASE_A),
    ).resolves.toEqual({ state: "absent" });
  });

  test.each([
    ["a malformed file", JSON.stringify({ version: 1 })],
    ["not JSON", "nope"],
    ["an unknown field", JSON.stringify({ version: 1, additional_logins: [], extra: true })],
    ["a wildcard", JSON.stringify({ version: 1, additional_logins: ["*"] })],
  ])("%s stops the gate instead of adding nobody", async (_name, content) => {
    const fake = createFakeCommentsGitHub({ projectFile: content });
    await expect(
      createGitHubReaderSource(async () => fake.client, target).projectAllowlist(BASE_A),
    ).rejects.toBeInstanceOf(ProjectAllowlistInvalidError);
  });

  test("a failed request is not read as a missing file", async () => {
    const fake = createFakeCommentsGitHub({
      projectFile: Object.assign(new Error("boom"), { status: 500 }),
    });
    const error = await createGitHubReaderSource(async () => fake.client, target)
      .projectAllowlist(BASE_A)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ProjectAllowlistInvalidError);
  });
});
