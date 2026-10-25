// reviewer 側の reader: PR の review thread・review body・issue comment の本文を、
// 「メタデータ全ページ → 投稿者検証 → 本文」の順で読む。
//
// 契約は review-raven の docs/design/contracts/reader（src/contract/v1/reader に固定して取り込む）。
// review-raven の internal/reader と同じ判定で、同じ共有シナリオを実行して一致を確かめる。
//
// 他者が書き得るコメントは未信頼。source に本文を要求するのは、全コメントの投稿者が allowlist に含まれると
// 確認した後だけで、返すのは、検証したコメントと同じもの（集合・投稿者・編集時刻・head/base）に限る。
// 検証後に追加・編集されたものは、取り直し、変わり続ければ本文なしで SNAPSHOT_CHANGED を返す。

import { createHash } from "node:crypto";
import { normalizeLogin } from "../policy/author-policy.js";

export type CommentKind = "review_thread_comment" | "review_body" | "issue_comment";

// 契約のエラー code。
export const CODE_UNTRUSTED_COMMENT = "UNTRUSTED_COMMENT";
export const CODE_AUTHOR_CHECK_FAILED = "AUTHOR_CHECK_FAILED";
export const CODE_TRUSTED_AUTHORS_NOT_CONFIGURED = "TRUSTED_AUTHORS_NOT_CONFIGURED";
export const CODE_PROJECT_ALLOWLIST_INVALID = "PROJECT_ALLOWLIST_INVALID";
export const CODE_SNAPSHOT_CHANGED = "SNAPSHOT_CHANGED";

// 古い snapshot を取り直す回数の上限。
export const MAX_ATTEMPTS = 3;
export const SCHEMA_VERSION = 1;
// 契約が許す、エラーメッセージの最大長（文字数）。
export const MAX_MESSAGE_LENGTH = 500;

export interface ReaderComment {
  kind: CommentKind;
  id: string;
  // GitHub が投稿者を返さない（削除済みアカウント）ときは空文字。
  author: string;
  authorType: string;
  url: string;
  createdAt: string;
  // 編集されていなければ空文字。
  editedAt: string;
  // review body だけ。
  state: string;
  // 本文を読むまでは null。
  body: string | null;
}

export interface ReaderThread {
  id: string;
  path: string;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  comments: ReaderComment[];
}

export interface ReaderSnapshot {
  headSha: string;
  baseSha: string;
  threads: ReaderThread[];
  reviews: ReaderComment[];
  issueComments: ReaderComment[];
}

export type ProjectAllowlist =
  | { state: "absent" }
  | { state: "present"; logins: readonly string[] };

// 取得中に PR の commit が動いたときに source が投げる。
export class SnapshotMovedError extends Error {
  constructor() {
    super("pull request changed while reading");
    this.name = "SnapshotMovedError";
  }
}

// プロジェクトの allowlist ファイルが存在するが、読めない・壊れているときに source が投げる。
export class ProjectAllowlistInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectAllowlistInvalidError";
  }
}

export interface ReaderSource {
  // 全ページを返す。withBodies=false のとき、upstream へ本文を要求してはならない。
  fetch(withBodies: boolean): Promise<ReaderSnapshot>;
  // baseSha のプロジェクト allowlist。ファイルが無ければ absent。
  projectAllowlist(baseSha: string): Promise<ProjectAllowlist>;
}

// 本文を含まないコメントの参照。
export interface CommentRef {
  kind: CommentKind;
  id: string;
  threadId?: string;
  author: string;
  authorType: string;
  url: string;
}

// ゲートが止めたときのエラー。コメント本文は持たない。
export class ReaderGateError extends Error {
  readonly code: string;
  readonly comments: CommentRef[];

  constructor(code: string, message: string, comments: CommentRef[] = []) {
    super(`${code}: ${message}`);
    this.name = "ReaderGateError";
    this.code = code;
    this.comments = comments;
  }

  // code を除いた説明。
  get detail(): string {
    return this.message.slice(this.code.length + 2);
  }
}

export interface AllowlistInfo {
  serverLogins: number;
  projectFile: boolean;
  projectLogins: number;
}

export interface ReaderResult {
  snapshot: ReaderSnapshot;
  snapshotId: string;
  allowlist: AllowlistInfo;
}

interface Located {
  comment: ReaderComment;
  threadId: string;
}

function allComments(s: ReaderSnapshot): Located[] {
  const out: Located[] = [];
  for (const t of s.threads) for (const c of t.comments) out.push({ comment: c, threadId: t.id });
  for (const c of s.reviews) out.push({ comment: c, threadId: "" });
  for (const c of s.issueComments) out.push({ comment: c, threadId: "" });
  return out;
}

// serverLogins（正規化済みのサーバーの allowlist）に加え、base ref のプロジェクト allowlist を適用して、
// 検証済みの snapshot を返す。空の allowlist は誰も信頼しないため、GitHub へ問い合わせずに止める。
export async function readComments(
  source: ReaderSource,
  serverLogins: readonly string[],
): Promise<ReaderResult> {
  if (serverLogins.length === 0) {
    throw new ReaderGateError(
      CODE_TRUSTED_AUTHORS_NOT_CONFIGURED,
      "no comment author is trusted: the server allowlist (TRUSTED_COMMENT_AUTHORS) is empty",
    );
  }
  for (let attempt = 1; ; attempt++) {
    const result = await readOnce(source, serverLogins);
    if (result !== "stale") return result;
    if (attempt >= MAX_ATTEMPTS) {
      throw new ReaderGateError(
        CODE_SNAPSHOT_CHANGED,
        `comments changed between the author check and the text read on ${MAX_ATTEMPTS} attempts; no text was returned`,
      );
    }
  }
}

async function readOnce(
  source: ReaderSource,
  serverLogins: readonly string[],
): Promise<ReaderResult | "stale"> {
  let meta: ReaderSnapshot;
  try {
    meta = await source.fetch(false);
  } catch (error) {
    if (error instanceof SnapshotMovedError) return "stale";
    throw new Error(`read comment metadata: ${errorMessage(error)}`, { cause: error });
  }
  validateIds(meta);

  let project: ProjectAllowlist;
  try {
    project = await source.projectAllowlist(meta.baseSha);
  } catch (error) {
    if (error instanceof ProjectAllowlistInvalidError) {
      throw new ReaderGateError(CODE_PROJECT_ALLOWLIST_INVALID, error.message);
    }
    throw new Error(`read project allowlist: ${errorMessage(error)}`, { cause: error });
  }
  const projectLogins = project.state === "present" ? project.logins : [];
  const allowed = new Set<string>([...serverLogins, ...projectLogins]);

  checkAuthors(meta, allowed);

  let full: ReaderSnapshot;
  try {
    full = await source.fetch(true);
  } catch (error) {
    if (error instanceof SnapshotMovedError) return "stale";
    throw new Error(`read comment text: ${errorMessage(error)}`, { cause: error });
  }
  if (fingerprint(meta) !== fingerprint(full)) return "stale";
  requireBodies(full);

  return {
    snapshot: full,
    snapshotId: snapshotId(full),
    allowlist: {
      serverLogins: serverLogins.length,
      projectFile: project.state === "present",
      projectLogins: projectLogins.length,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateIds(s: ReaderSnapshot): void {
  const seen = new Set<string>();
  for (const { comment } of allComments(s)) {
    if (comment.id === "") {
      throw new Error(`read comment metadata: a ${comment.kind} has no id`);
    }
    const key = `${comment.kind}|${comment.id}`;
    if (seen.has(key)) {
      throw new Error(`read comment metadata: duplicate ${comment.kind} id ${comment.id}`);
    }
    seen.add(key);
  }
}

// 全コメントに allowlist を適用する。投稿者を特定できないコメントが 1 件でもあれば、許可外とは区別して止める。
function checkAuthors(s: ReaderSnapshot, allowed: ReadonlySet<string>): void {
  const unknown: CommentRef[] = [];
  const untrusted: CommentRef[] = [];
  for (const { comment: c, threadId } of allComments(s)) {
    const ref: CommentRef = {
      kind: c.kind,
      id: c.id,
      ...(threadId === "" ? {} : { threadId }),
      author: c.author,
      authorType: c.authorType,
      url: c.url,
    };
    if (c.author === "") {
      unknown.push(ref);
    } else if (!allowed.has(normalizeLogin(c.author))) {
      untrusted.push(ref);
    }
  }
  if (unknown.length > 0) {
    throw new ReaderGateError(
      CODE_AUTHOR_CHECK_FAILED,
      `the author of ${unknown.length} comment(s) could not be determined; no text was read`,
      [...unknown, ...untrusted],
    );
  }
  if (untrusted.length > 0) {
    throw new ReaderGateError(
      CODE_UNTRUSTED_COMMENT,
      `${untrusted.length} comment(s) were written by an author who is not in the allowlist; no text was read`,
      untrusted,
    );
  }
}

function requireBodies(s: ReaderSnapshot): void {
  for (const { comment } of allComments(s)) {
    if (comment.body === null) {
      throw new Error(
        `read comment text: the source returned no text for ${comment.kind} ${comment.id}`,
      );
    }
  }
}

// UTF-8 のバイト順で比べる（Go の sort.Strings と同じ順序にして、snapshotId を実装間で一致させる）。
function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

// 投稿者の検証が依拠した事実。同じ指紋の 2 つの snapshot は、同じコメントが同じ投稿者・編集なしで並ぶ。
// thread の resolved は投稿者も本文も変えないので含めない。
export function fingerprint(s: ReaderSnapshot): string {
  const lines = allComments(s)
    .map(({ comment: c, threadId }) =>
      [c.kind, c.id, threadId, c.author, c.authorType, c.editedAt].join("|"),
    )
    .sort(byteOrder);
  return [`head=${s.headSha}`, `base=${s.baseSha}`, ...lines].join("\n");
}

// 検証した snapshot の識別子。後の再読で値が変われば、コメント・投稿者・編集・head のいずれかが変わっている。
export function snapshotId(s: ReaderSnapshot): string {
  return createHash("sha256").update(fingerprint(s), "utf8").digest("hex");
}
