export type LogLevel = "debug" | "info" | "warn" | "error";

export type TransportMode = "stdio" | "http" | "both";

export interface AppConfig {
  nodeEnv: string;
  logLevel: LogLevel;
  databaseUrl: string;
  transport: TransportMode;
  http: {
    host: string;
    port: number;
    path: string;
    authMode: string;
  };
  embedding: {
    provider: string;
    model: string;
    dimensions: number;
  };
  extraction: {
    provider: string;
    model: string;
  };
  limits: {
    defaultContextLimit: number;
    defaultSearchLimit: number;
    proposalTtl: number;
  };
}