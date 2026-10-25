import { describe, expect, test } from "vitest";
import { parseProjectFile } from "./project-allowlist.js";

describe("parseProjectFile", () => {
  test.each([
    [
      "adds normalized logins",
      '{"version":1,"additional_logins":["Cloudflare-Workers-And-Pages[bot]","ci-bot"]}',
      ["cloudflare-workers-and-pages", "ci-bot"],
    ],
    ["an empty list is valid", '{"version":1,"additional_logins":[]}', []],
  ])("%s", (_name, input, expected) => {
    expect(parseProjectFile(input)).toEqual(expected);
  });

  test.each([
    ["not JSON", "nope", "not a valid allowlist file"],
    ["not an object", '["a"]', "not a valid allowlist file"],
    ["null", "null", "not a valid allowlist file"],
    ["trailing document", '{"version":1,"additional_logins":[]} {}', "not a valid allowlist file"],
    ["missing version", '{"additional_logins":[]}', "version must be 1"],
    ["wrong version", '{"version":2,"additional_logins":[]}', "version must be 1"],
    ["missing logins", '{"version":1}', "additional_logins must be an array"],
    ["null logins", '{"version":1,"additional_logins":null}', "additional_logins must be an array"],
    ["unknown key", '{"version":1,"additional_logins":[],"extra":true}', "unknown field"],
    ["non-string login", '{"version":1,"additional_logins":[1]}', "GitHub login"],
    ["null login", '{"version":1,"additional_logins":[null]}', "GitHub login"],
    ["empty login", '{"version":1,"additional_logins":[""]}', "GitHub login"],
    ["wildcard", '{"version":1,"additional_logins":["*"]}', "wildcards are not allowed"],
    ["double bot suffix", '{"version":1,"additional_logins":["name[bot][bot]"]}', "GitHub login"],
    [
      "duplicate after normalization",
      '{"version":1,"additional_logins":["Name","name[bot]"]}',
      "duplicate",
    ],
  ])("rejects %s", (_name, input, message) => {
    expect(() => parseProjectFile(input)).toThrow(message);
  });

  test.each([
    ["an invalid login", "!".repeat(600)],
    ["multibyte characters", "あ".repeat(600)],
    ["astral characters", "😀".repeat(600)],
  ])("repeats only an excerpt of a long rejected value: %s", (_name, value) => {
    let message = "";
    try {
      parseProjectFile(JSON.stringify({ version: 1, additional_logins: [value] }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(Array.from(message).length).toBeLessThan(300);
  });
});
