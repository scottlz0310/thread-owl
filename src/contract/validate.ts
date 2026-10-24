// 取り込んだ契約 schema の読み込みと検証。schema は dist にも含めるため、静的に import する。
import { Ajv2020 } from "ajv/dist/2020.js";
import acceptReviewCandidateInput from "./v1/schemas/accept_review_candidate.input.schema.json" with {
  type: "json",
};
import acceptReviewCandidateOutput from "./v1/schemas/accept_review_candidate.output.schema.json" with {
  type: "json",
};
import cancelReviewCandidateInput from "./v1/schemas/cancel_review_candidate.input.schema.json" with {
  type: "json",
};
import cancelReviewCandidateOutput from "./v1/schemas/cancel_review_candidate.output.schema.json" with {
  type: "json",
};
import cancelReviewRequestInput from "./v1/schemas/cancel_review_request.input.schema.json" with {
  type: "json",
};
import cancelReviewRequestOutput from "./v1/schemas/cancel_review_request.output.schema.json" with {
  type: "json",
};
import common from "./v1/schemas/common.schema.json" with { type: "json" };
import error from "./v1/schemas/error.schema.json" with { type: "json" };
import getReviewRequestInput from "./v1/schemas/get_review_request.input.schema.json" with {
  type: "json",
};
import getReviewResultInput from "./v1/schemas/get_review_result.input.schema.json" with {
  type: "json",
};
import getReviewResultOutput from "./v1/schemas/get_review_result.output.schema.json" with {
  type: "json",
};
import ingestReviewCandidateInput from "./v1/schemas/ingest_review_candidate.input.schema.json" with {
  type: "json",
};
import ingestReviewCandidateOutput from "./v1/schemas/ingest_review_candidate.output.schema.json" with {
  type: "json",
};
import publishReviewObservationInput from "./v1/schemas/publish_review_observation.input.schema.json" with {
  type: "json",
};
import publishReviewObservationOutput from "./v1/schemas/publish_review_observation.output.schema.json" with {
  type: "json",
};
import publishReviewResultInput from "./v1/schemas/publish_review_result.input.schema.json" with {
  type: "json",
};
import publishReviewResultOutput from "./v1/schemas/publish_review_result.output.schema.json" with {
  type: "json",
};
import requestReviewInput from "./v1/schemas/request_review.input.schema.json" with {
  type: "json",
};
import requestReviewOutput from "./v1/schemas/request_review.output.schema.json" with {
  type: "json",
};
import settings from "./v1/schemas/settings.schema.json" with { type: "json" };
import snapshot from "./v1/schemas/snapshot.schema.json" with { type: "json" };

const schemas = {
  "accept_review_candidate.input": acceptReviewCandidateInput,
  "accept_review_candidate.output": acceptReviewCandidateOutput,
  "cancel_review_candidate.input": cancelReviewCandidateInput,
  "cancel_review_candidate.output": cancelReviewCandidateOutput,
  "cancel_review_request.input": cancelReviewRequestInput,
  "cancel_review_request.output": cancelReviewRequestOutput,
  error: error,
  "get_review_request.input": getReviewRequestInput,
  "get_review_result.input": getReviewResultInput,
  "get_review_result.output": getReviewResultOutput,
  "ingest_review_candidate.input": ingestReviewCandidateInput,
  "ingest_review_candidate.output": ingestReviewCandidateOutput,
  "publish_review_observation.input": publishReviewObservationInput,
  "publish_review_observation.output": publishReviewObservationOutput,
  "publish_review_result.input": publishReviewResultInput,
  "publish_review_result.output": publishReviewResultOutput,
  "request_review.input": requestReviewInput,
  "request_review.output": requestReviewOutput,
  settings: settings,
  snapshot: snapshot,
} as const;

export type ContractSchemaName = keyof typeof schemas;

export type ContractValidation = { ok: true } | { ok: false; errors: string };

// snapshot の条件分岐（allOf/oneOf 内の properties）が strictTypes の規則に当たるため、その規則だけ外す。
// 契約の schema は固定コピーで、書き換えない。
const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: false });
ajv.addSchema(common);
const validators = Object.fromEntries(
  Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)]),
);

/** 契約 schema で値を検証する。未知の項目は schema の additionalProperties:false で拒否される。 */
export function validateContract(name: ContractSchemaName, value: unknown): ContractValidation {
  const validate = validators[name];
  if (validate(value)) {
    return { ok: true };
  }
  return { ok: false, errors: ajv.errorsText(validate.errors) };
}

export function contractSchemaNames(): ContractSchemaName[] {
  return Object.keys(schemas) as ContractSchemaName[];
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvePointer(doc: JsonObject, pointer: string): unknown {
  return pointer
    .split("/")
    .slice(1)
    .reduce<unknown>((node, key) => (isObject(node) ? node[key] : undefined), doc);
}

function inlineRefs(node: unknown, doc: JsonObject, depth: number): unknown {
  if (depth > 20) {
    throw new Error("契約 schema の $ref が深すぎる（循環の疑い）");
  }
  if (Array.isArray(node)) {
    return node.map((item) => inlineRefs(item, doc, depth));
  }
  if (!isObject(node)) {
    return node;
  }
  const ref = node.$ref;
  if (typeof ref === "string") {
    const [file, pointer = ""] = ref.split("#");
    const target = file === "common.schema.json" ? (common as JsonObject) : doc;
    const resolved = resolvePointer(target, pointer);
    if (resolved === undefined) {
      throw new Error(`契約 schema の $ref を解決できない: ${ref}`);
    }
    return inlineRefs(resolved, target, depth + 1);
  }
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => key !== "$id" && key !== "$defs")
      .map(([key, value]) => [key, inlineRefs(value, doc, depth)]),
  );
}

/**
 * $ref を展開した自己完結の schema。tools/list で通知する入力 schema に使う
 * （相対 $ref は、受け取った側で解決できないため）。検証には validateContract を使う。
 */
export function contractJsonSchema(name: ContractSchemaName): JsonObject {
  const schema = schemas[name] as JsonObject;
  return inlineRefs(schema, schema, 0) as JsonObject;
}
