import { startApi } from "@/app/api/api";
import { log } from "@/utils/log";
import { awaitShutdown, onShutdown } from "@/utils/shutdown";
import { db } from './storage/db';
import { startTimeout } from "./app/presence/timeout";
import { startMetricsServer } from "@/app/monitoring/metrics";
import { activityCache } from "@/app/presence/sessionCache";
import { auth } from "./app/auth/auth";
import { startDatabaseMetricsUpdater } from "@/app/monitoring/metrics2";
import { initEncrypt } from "./modules/encrypt";
import { initGithub } from "./modules/github";
import { loadFiles } from "./storage/files";
import * as path from "path";
import * as fs from "fs";

// Locate a bundled webapp directory so the server can serve the web client from
// the same origin (single-service deploy). Returns undefined when no webapp is
// bundled, in which case startApi() falls back to the plain banner at `/`.
// Note: this module runs under tsx as ESM, so `__dirname` is unavailable —
// rely on HAPPY_STATIC_DIR (set by Dockerfile.server) and the package cwd.
function findStaticDir(): string | undefined {
    const candidates = [
        process.env.HAPPY_STATIC_DIR,
        path.join(process.cwd(), "webapp"),
        path.join(process.cwd(), "packages", "happy-server", "webapp"),
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, "index.html"))) {
            return candidate;
        }
    }
    return undefined;
}

async function main() {

    // Storage
    await db.$connect();
    onShutdown('db', async () => {
        await db.$disconnect();
    });
    onShutdown('activity-cache', async () => {
        activityCache.shutdown();
    });
    if (process.env.REDIS_URL) {
        const { Redis } = await import('ioredis');
        const redis = new Redis(process.env.REDIS_URL);
        await redis.ping();
    }

    // Initialize auth module
    await initEncrypt();
    await initGithub();
    await loadFiles();
    await auth.init();

    //
    // Start
    //

    const staticDir = findStaticDir();
    let injectHtmlConfig: Record<string, unknown> | undefined;
    if (process.env.HAPPY_INJECT_HTML_CONFIG) {
        try {
            injectHtmlConfig = JSON.parse(process.env.HAPPY_INJECT_HTML_CONFIG);
        } catch {
            // ignore malformed input
        }
    }
    if (staticDir) {
        log(`Serving bundled webapp from ${staticDir}`);
    }
    await startApi({ staticDir, injectHtmlConfig });
    await startMetricsServer();
    startDatabaseMetricsUpdater();
    startTimeout();

    //
    // Ready
    //

    log('Ready');
    await awaitShutdown();
    log('Shutting down...');
}

// Process-level error handling
process.on('uncaughtException', (error) => {
    log({
        module: 'process-error',
        level: 'error',
        stack: error.stack,
        name: error.name
    }, `Uncaught Exception: ${error.message}`);

    console.error('Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    const errorMsg = reason instanceof Error ? reason.message : String(reason);
    const errorStack = reason instanceof Error ? reason.stack : undefined;

    log({
        module: 'process-error',
        level: 'error',
        stack: errorStack,
        reason: String(reason)
    }, `Unhandled Rejection: ${errorMsg}`);

    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

process.on('warning', (warning) => {
    log({
        module: 'process-warning',
        level: 'warn',
        name: warning.name,
        stack: warning.stack
    }, `Process Warning: ${warning.message}`);
});

// Log when the process is about to exit
process.on('exit', (code) => {
    if (code !== 0) {
        log({
            module: 'process-exit',
            level: 'error',
            exitCode: code
        }, `Process exiting with code: ${code}`);
    } else {
        log({
            module: 'process-exit',
            level: 'info',
            exitCode: code
        }, 'Process exiting normally');
    }
});

main().catch((e) => {
    console.error(e);
    process.exit(1);
}).then(() => {
    process.exit(0);
});