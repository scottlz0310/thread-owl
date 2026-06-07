import { generateAppJwt } from "../app-auth/app-jwt.js";
import { resolveInstallationId } from "../app-auth/installation-resolver.js";
import { getInstallationToken } from "../app-auth/installation-token.js";
import { createTokenCache } from "../app-auth/token-cache.js";
import type { AppConfig } from "../config/env.js";
import type { Logger } from "../config/logging.js";
import type { IssueTokenDeps } from "../internal-api/token-source.js";
import type { DeliveryDedup } from "../queue/delivery-dedup.js";
import { createDeliveryDedup } from "../queue/delivery-dedup.js";
import type { ReviewQueue } from "../queue/review-queue.js";
import { createReviewQueue } from "../queue/review-queue.js";

export interface SharedRuntime {
  config: AppConfig;
  logger: Logger;
  issueTokenDeps: IssueTokenDeps;
  reviewQueue: ReviewQueue;
  deliveryDedup: DeliveryDedup;
}

export function createSharedRuntime(config: AppConfig, logger: Logger): SharedRuntime {
  const tokenCache = createTokenCache();
  const issueTokenDeps: IssueTokenDeps = {
    config,
    logger,
    tokenCache,
    generateAppJwt,
    resolveInstallationId,
    getInstallationToken,
  };
  const reviewQueue = createReviewQueue();
  const deliveryDedup = createDeliveryDedup();
  return { config, logger, issueTokenDeps, reviewQueue, deliveryDedup };
}
