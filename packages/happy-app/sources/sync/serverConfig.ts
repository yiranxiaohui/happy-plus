import { MMKV } from 'react-native-mmkv';
import { Platform } from 'react-native';

// Separate MMKV instance for server config that persists across logouts
const serverConfigStorage = new MMKV({ id: 'server-config' });

const SERVER_KEY = 'custom-server-url';
const LOG_SERVER_KEY = 'log-server-url';
const DEFAULT_SERVER_URL = 'https://happy.yunnet.top';

export function getServerUrl(): string {
    // A user-set custom server always wins (e.g. connecting to a remote instance).
    const custom = serverConfigStorage.getString(SERVER_KEY);
    if (custom) {
        return custom;
    }

    // Web: dynamic same-origin — talk to whatever domain served this page. When the
    // webapp is bundled into the server (single-service deploy), this makes the app
    // always same-origin with its API, so CORS never applies no matter how many
    // domains front the service. Native has no "own origin" and is not subject to
    // browser CORS anyway, so it keeps using the absolute fallback below.
    if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.origin) {
        return window.location.origin;
    }

    return (globalThis as any).__HAPPY_CONFIG__?.serverUrl ||
           process.env.EXPO_PUBLIC_HAPPY_SERVER_URL ||
           DEFAULT_SERVER_URL;
}

export function setServerUrl(url: string | null): void {
    if (url && url.trim()) {
        serverConfigStorage.set(SERVER_KEY, url.trim());
    } else {
        serverConfigStorage.delete(SERVER_KEY);
    }
}

export function getLogServerUrl(): string | null {
    return serverConfigStorage.getString(LOG_SERVER_KEY) ||
           process.env.EXPO_PUBLIC_LOG_SERVER_URL ||
           null;
}

export function setLogServerUrl(url: string | null): void {
    if (url && url.trim()) {
        serverConfigStorage.set(LOG_SERVER_KEY, url.trim());
    } else {
        serverConfigStorage.delete(LOG_SERVER_KEY);
    }
}

export function isUsingCustomServer(): boolean {
    // "Custom" means the user explicitly set a server URL — not the web
    // dynamic-same-origin default, which getServerUrl() may return on web.
    return !!serverConfigStorage.getString(SERVER_KEY);
}

export function getServerInfo(): { hostname: string; port?: number; isCustom: boolean } {
    const url = getServerUrl();
    const isCustom = isUsingCustomServer();
    
    try {
        const parsed = new URL(url);
        const port = parsed.port ? parseInt(parsed.port) : undefined;
        return {
            hostname: parsed.hostname,
            port,
            isCustom
        };
    } catch {
        // Fallback if URL parsing fails
        return {
            hostname: url,
            port: undefined,
            isCustom
        };
    }
}

export function validateServerUrl(url: string): { valid: boolean; error?: string } {
    if (!url || !url.trim()) {
        return { valid: false, error: 'Server URL cannot be empty' };
    }
    
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { valid: false, error: 'Server URL must use HTTP or HTTPS protocol' };
        }
        return { valid: true };
    } catch {
        return { valid: false, error: 'Invalid URL format' };
    }
}