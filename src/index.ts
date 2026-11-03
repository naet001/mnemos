import { loadConfig } from "./config/index.js";
import { logger, setLogLevel } from "./logger/index.js";
import { connect, disconnect, checkHealth } from "./db/index.js";

async function main(): Promise<void> {
  // Load configuration
  const config = loadConfig();
  setLogLevel(config.logLevel);

  logger.info("Mnemos starting", {
    nodeEnv: config.nodeEnv,
    transport: config.transport,
  });

  // Connect to database
  try {
    await connect(config.databaseUrl);
    logger.info("Database connection established");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Failed to connect to database", { error: message });
    process.exit(1);
  }

  // Run health check
  const health = await checkHealth();
  logger.info("Health check", {
    connected: health.connected,
    pgvectorAvailable: health.pgvectorAvailable,
    schemaVersion: health.schemaVersion,
    latencyMs: health.latencyMs,
  });

  if (!health.connected) {
    logger.error("Database health check failed — exiting");
    process.exit(1);
  }

  // Log startup summary
  logger.info("Mnemos started successfully", {
    transport: config.transport,
    pgvector: health.pgvectorAvailable,
    schema: health.schemaVersion,
  });

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Shutting down (${signal})...`);
    await disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // For STDIO transport, keep the process alive
  // (MCP SDK will handle the protocol loop in later milestones)
  if (config.transport === "stdio") {
    logger.info("STDIO transport mode — waiting for MCP messages");
    // In M1, we just keep the process alive
    await new Promise<void>(() => {
      // Never resolves — process stays alive until signal
    });
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error("Fatal startup error", { error: message });
  process.exit(1);
});
