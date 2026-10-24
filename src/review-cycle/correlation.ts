import type { ResultKind } from "./ledger.js";

/**
 * 投稿本文に付ける、結果索引との相関マーカー（HTML コメントなので表示されない）。
 * GitHub への投稿成功後・台帳への記録前に停止しても、writeId で投稿を照合して回復できる。
 */
export interface CorrelationMarker {
  cycleId: string;
  candidateId: string;
  writeId: string;
  kind: ResultKind;
}

const MARKER_LINE =
  /^<!-- thread-owl:cycle cycleId=(cyc_[0-9a-z]{26}) candidateId=(cand_[0-9a-z]{26}) writeId=([0-9a-f]{16}) kind=(reviewed|approved) -->$/;

export function buildMarker(marker: CorrelationMarker): string {
  return `<!-- thread-owl:cycle cycleId=${marker.cycleId} candidateId=${marker.candidateId} writeId=${marker.writeId} kind=${marker.kind} -->`;
}

/** 本文の末尾に、空行を挟んでマーカーを足す。本文が空ならマーカーだけにする。 */
export function appendMarker(body: string, marker: string): string {
  return body === "" ? marker : `${body}\n\n${marker}`;
}

/** 本文の行のうち、完全一致するマーカー行を読む（部分一致や整形違いは拒否）。 */
export function parseMarker(body: string): CorrelationMarker | undefined {
  for (const line of body.split("\n")) {
    const match = MARKER_LINE.exec(line.replace(/\r$/, ""));
    if (match) {
      return {
        cycleId: match[1],
        candidateId: match[2],
        writeId: match[3],
        kind: match[4] as ResultKind,
      };
    }
  }
  return undefined;
}
