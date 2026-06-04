// Health check endpoint

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  uptime: number;
}

export function getHealth(): HealthResponse {
  return {
    status: "ok",
    version: "0.1.0",
    uptime: process.uptime(),
  };
}
