import { Client, SdkHttpError, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { validateContract } from "../contract/validate.js";
import { ContractError, type ContractErrorCode } from "./errors.js";
import type { IngestMessage, ResultMessage } from "./ledger.js";
import type { IngestPublisher, ResultPublisher } from "./result-delivery.js";

export interface RavenClientConfig {
  /** review-raven の内部面の MCP endpoint（通常は gateway のルート）。 */
  endpoint: string;
  /** サービス資格情報。Bearer として送り、gateway がサービス主体へ対応付ける。ログには出さない。 */
  token: string;
  /**
   * loopback 以外のホストの平文 http を許可する。gateway をサービス名で引くコンテナの private network 向けの
   * 明示的な opt-in で、資格情報はそのネットワーク上を平文で流れる。既定（false）は https または loopback の http のみ。
   */
  allowPlainHttp?: boolean;
  /** テスト用。省略時は fetch。 */
  fetch?: typeof fetch;
}

/**
 * https、または loopback 上の http だけを受け付ける（資格情報を平文で外部に送らない）。
 * allowPlainHttp は、別ホストの http を許す明示的な opt-in で、緩めるのはその規則だけ
 * （URL の資格情報・query・fragment と、他のスキームは常に拒否する）。正規化した URL を返す。
 */
export function validateRavenEndpoint(raw: string, allowPlainHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`invalid review-raven endpoint: ${raw}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("the review-raven endpoint must not carry credentials, a query or a fragment");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "https:" || (url.protocol === "http:" && (loopback || allowPlainHttp))) {
    return url.toString();
  }
  throw new Error("the review-raven endpoint must be https (http only on a loopback host)");
}

// 契約のうち、受け取っても再送できないエラーは最終にする。再送できるのは UNAVAILABLE だけ。
const PEER_CODES: ReadonlySet<string> = new Set<ContractErrorCode>([
  "INVALID_ARGUMENT",
  "PERMISSION_DENIED",
  "REQUEST_NOT_FOUND",
  "HEAD_CONFLICT",
  "CANDIDATE_CANCELLED",
  "RESULT_HEAD_MISMATCH",
  "RESULT_VERSION_STALE",
  "DELIVERY_EXPIRED",
  "UNAVAILABLE",
]);

/**
 * review-raven の内部面を呼ぶ（結果の通知 publish_review_result、webhook・コメント由来の候補 ingest_review_candidate）。
 * 失敗は、再送の可否が分かる ContractError にして投げる。
 */
export class RavenClient implements ResultPublisher, IngestPublisher {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: RavenClientConfig) {
    this.endpoint = validateRavenEndpoint(config.endpoint, config.allowPlainHttp ?? false);
    if (config.token.trim() === "") {
      throw new Error("a review-raven service credential is required");
    }
    this.token = config.token.trim();
    this.fetchImpl = config.fetch ?? fetch;
  }

  async publish(message: ResultMessage): Promise<void> {
    await this.call("publish_review_result", { schemaVersion: 1, ...message });
  }

  async ingest(message: IngestMessage): Promise<void> {
    await this.call("ingest_review_candidate", { schemaVersion: 1, ...message });
  }

  private async call(
    tool: "publish_review_result" | "ingest_review_candidate",
    input: Record<string, unknown>,
  ): Promise<void> {
    const valid = validateContract(`${tool}.input`, input);
    if (!valid.ok) {
      // 送る前の自己検査。通らない入力は、送っても同じなので再送しない。
      throw new ContractError("INVALID_ARGUMENT", `通知が契約に適合しない: ${valid.errors}`);
    }
    const client = new Client(
      { name: "thread-owl-delivery", version: "1.0.0" },
      // 相手（review-raven、go-sdk）が旧世代のプロトコルでも接続できるよう、自動で折衝する。
      { versionNegotiation: { mode: "auto" } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(this.endpoint), {
      fetch: this.fetchImpl,
      // リダイレクトは追われない（転送先に資格情報を送らない）。SDK の挙動なので、テストで固定している。
      requestInit: { headers: { authorization: `Bearer ${this.token}` } },
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: tool, arguments: input });
      this.interpret(tool, result);
    } catch (error) {
      throw this.classify(error);
    } finally {
      await client.close().catch(() => {});
    }
  }

  /** 結果を読む。契約のエラー envelope は、その code を保つ。想定外の形は、ACK 未受信と同じ再送可能な失敗。 */
  private interpret(
    tool: "publish_review_result" | "ingest_review_candidate",
    result: { isError?: boolean; structuredContent?: unknown },
  ): void {
    if (result.isError) {
      const envelope = result.structuredContent;
      if (validateContract("error", envelope).ok) {
        const { code, message } = (envelope as { error: { code: string; message: string } }).error;
        if (PEER_CODES.has(code)) {
          throw new ContractError(code as ContractErrorCode, message);
        }
      }
      throw new ContractError("UNAVAILABLE", "review-raven が契約のエラーでない応答を返した");
    }
    const output = validateContract(`${tool}.output`, result.structuredContent);
    if (!output.ok) {
      throw new ContractError("UNAVAILABLE", "review-raven の応答が契約に適合しない");
    }
  }

  private classify(error: unknown): ContractError {
    if (error instanceof ContractError) {
      return error;
    }
    if (error instanceof SdkHttpError) {
      // 資格情報の拒否・権限なしは、再送しても通らない。迂回もしない。
      if (error.status === 401 || error.status === 403) {
        return new ContractError(
          "PERMISSION_DENIED",
          `review-raven が資格情報を拒否した (HTTP ${error.status})`,
        );
      }
      if (error.status === 429 || error.status >= 500) {
        return new ContractError(
          "UNAVAILABLE",
          `review-raven に届かなかった (HTTP ${error.status})`,
        );
      }
      return new ContractError(
        "INVALID_ARGUMENT",
        `review-raven が要求を拒否した (HTTP ${error.status})`,
      );
    }
    // 接続断・タイムアウトなど（ACK 未受信）。メッセージには資格情報を含めない。
    return new ContractError("UNAVAILABLE", "review-raven に接続できなかった");
  }
}
