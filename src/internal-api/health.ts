// Health check endpoint

export interface HealthResponse {
  status: "ok";
}

export function getHealth(): HealthResponse {
  return { status: "ok" };
}
