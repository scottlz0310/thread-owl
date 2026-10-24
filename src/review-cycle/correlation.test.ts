import { describe, expect, test } from "vitest";
import { appendMarker, buildMarker, parseMarker } from "./correlation.js";

const marker = {
  cycleId: "cyc_01jbq3x8n5r7t9v2w4y6z8a0c1",
  candidateId: "cand_01jbq3x8n5r7t9v2w4y6z8a0d1",
  writeId: "0123456789abcdef",
  kind: "approved" as const,
};

describe("相関マーカー", () => {
  test("組み立てたマーカーは、本文の中から読み戻せる", () => {
    const line = buildMarker(marker);
    expect(parseMarker(`本文\n\n${line}`)).toEqual(marker);
    expect(parseMarker(`${line}\r\n後ろ`)).toEqual(marker);
  });

  test.each([
    ["マーカー無し", "本文だけ"],
    ["行の途中", `前置き ${buildMarker(marker)}`],
    ["余分な空白", buildMarker(marker).replace("<!-- ", "<!--  ")],
    ["cycleId の書式違い", buildMarker({ ...marker, cycleId: "cyc_short" })],
    ["writeId の書式違い", buildMarker({ ...marker, writeId: "XYZ" })],
    ["未知の kind", buildMarker(marker).replace("approved", "verdict")],
  ])("不正なマーカーは読まない（%s）", (_name, body) => {
    expect(parseMarker(body)).toBeUndefined();
  });

  test("appendMarker は、本文の後ろに空行を挟んで足し、本文が空ならマーカーだけにする", () => {
    const line = buildMarker(marker);
    expect(appendMarker("本文", line)).toBe(`本文\n\n${line}`);
    expect(appendMarker("", line)).toBe(line);
  });
});
