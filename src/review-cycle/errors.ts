/** 契約 v1 のエラー code のうち、thread-owl の内部面（raven → owl）が返しうるもの。 */
export type ContractErrorCode =
  | "INVALID_ARGUMENT"
  | "PERMISSION_DENIED"
  | "REQUEST_NOT_FOUND"
  | "HEAD_CONFLICT"
  | "CANCEL_RESULT_POSTED"
  | "CANCEL_UNCONFIRMED"
  | "CANDIDATE_CANCELLED"
  | "ORIGIN_REJECTED"
  | "RESULT_HEAD_MISMATCH"
  | "RESULT_VERSION_STALE"
  | "DELIVERY_EXPIRED"
  | "UNAVAILABLE";

/** 再送してよいのは、同じ取消 ID で再試行できる CANCEL_UNCONFIRMED と一時的な障害だけ。 */
const RETRYABLE: ReadonlySet<ContractErrorCode> = new Set(["CANCEL_UNCONFIRMED", "UNAVAILABLE"]);

export class ContractError extends Error {
  readonly code: ContractErrorCode;
  readonly retryable: boolean;

  constructor(code: ContractErrorCode, message: string) {
    super(message);
    this.name = "ContractError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
  }
}
