import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  type ContractSchemaName,
  contractJsonSchema,
  contractSchemaNames,
  validateContract,
} from "./validate.js";

const root = fileURLToPath(new URL("./v1", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

type PatchOp = { op: "add" | "replace" | "remove"; path: string; value?: unknown };

// valid の base に当てる最小パッチ（add / replace / remove のみ。契約の README と同じ）
function applyPatch(base: unknown, patch: PatchOp[]): unknown {
  const doc = structuredClone(base) as Record<string, unknown>;
  for (const { op, path, value } of patch) {
    const keys = path.split("/").slice(1);
    const last = keys.pop() as string;
    let target: Record<string, unknown> = doc;
    for (const key of keys) {
      target = target[key] as Record<string, unknown>;
    }
    if (op === "remove") {
      delete target[last];
    } else {
      target[last] = value;
    }
  }
  return doc;
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

const names = contractSchemaNames();

describe("契約 fixture", () => {
  test("fixture のある面は、すべて schema と対応している", () => {
    const fixtureDirs = readdirSync(join(root, "fixtures"));
    expect(fixtureDirs.filter((dir) => !names.includes(dir as ContractSchemaName))).toEqual([]);
  });

  const valid = names.flatMap((name) => {
    try {
      return readdirSync(join(root, "fixtures", name, "valid")).map((file) => ({ name, file }));
    } catch {
      return [];
    }
  });
  test.each(valid)("valid: $name/$file は受理される", ({ name, file }) => {
    const value = readJson(join(root, "fixtures", name, "valid", file));
    expect(validateContract(name, value)).toEqual({ ok: true });
  });

  const invalid = names.flatMap((name) => {
    try {
      return readdirSync(join(root, "fixtures", name, "invalid")).map((file) => ({ name, file }));
    } catch {
      return [];
    }
  });
  test.each(invalid)("invalid: $name/$file は拒否される", ({ name, file }) => {
    const { base, patch } = readJson(join(root, "fixtures", name, "invalid", file)) as {
      base: string;
      patch: PatchOp[];
    };
    const baseValue = readJson(join(root, "fixtures", name, "valid", `${base}.json`));
    expect(validateContract(name, baseValue)).toEqual({ ok: true });
    expect(validateContract(name, applyPatch(baseValue, patch)).ok).toBe(false);
  });
});

describe("自己完結の schema（tools/list で通知する入力 schema）", () => {
  test.each(names.filter((name) => name.endsWith(".input")))(
    "%s は $ref を含まず、valid fixture をすべて受理する",
    async (name) => {
      const standalone = contractJsonSchema(name);
      expect(JSON.stringify(standalone)).not.toContain("$ref");
      const { Ajv2020 } = await import("ajv/dist/2020.js");
      const validate = new Ajv2020({ strict: true, strictTypes: false }).compile(standalone);
      for (const file of readdirSync(join(root, "fixtures", name, "valid"))) {
        expect(validate(readJson(join(root, "fixtures", name, "valid", file)))).toBe(true);
      }
    },
  );
});
