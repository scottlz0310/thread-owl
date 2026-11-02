import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = fileURLToPath(new URL("./v2", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("取り込んだ契約の固定", () => {
  test("MANIFEST と取り込んだファイルが一致する（手元での改変・欠落・追加を検出する）", () => {
    const manifest = readJson(join(root, "MANIFEST.json")) as {
      source: { commit: string };
      files: Record<string, string>;
    };
    const actual = Object.fromEntries(
      walk(root)
        .map((path) => relative(root, path).split("\\").join("/"))
        .filter((rel) => rel !== "MANIFEST.json")
        .sort()
        .map((rel) => [
          rel,
          createHash("sha256")
            .update(readFileSync(join(root, rel)))
            .digest("hex"),
        ]),
    );
    expect(manifest.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(actual).toEqual(manifest.files);
  });
});
