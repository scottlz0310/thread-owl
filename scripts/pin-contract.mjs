// review-raven のレビュー依頼契約を、固定したコミットから取り込み直す。
// 使い方: bun scripts/pin-contract.mjs <review-raven の clone> <commit>
// 取り込み先の各ファイルの sha256 を MANIFEST.json に記録し、手元での改変を contract.test.ts が検出する。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const [source, commit] = process.argv.slice(2);
if (!source || !/^[0-9a-f]{40}$/.test(commit ?? "")) {
  console.error("usage: bun scripts/pin-contract.mjs <review-raven clone> <40-hex commit>");
  process.exit(2);
}

const target = fileURLToPath(new URL("../src/contract/v1", import.meta.url));
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

const archive = execFileSync(
  "git",
  ["-c", "core.autocrlf=false", "-C", source, "archive", commit, "docs/design/contracts"],
  {
    maxBuffer: 64 * 1024 * 1024,
  },
);
execFileSync("tar", ["-x", "--strip-components=3"], { input: archive, cwd: target });

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const files = Object.fromEntries(
  walk(target)
    .map((path) => relative(target, path).split("\\").join("/"))
    .sort()
    .map((rel) => [
      rel,
      createHash("sha256")
        .update(readFileSync(join(target, rel)))
        .digest("hex"),
    ]),
);

const manifest = {
  source: { repository: "scottlz0310/review-raven", path: "docs/design/contracts", commit },
  files,
};
writeFileSync(join(target, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`pinned ${Object.keys(files).length} files from ${commit}`);
