import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getExpoPushTokenAsync = vi.hoisted(() => vi.fn());
vi.mock('expo-notifications', () => ({
    getExpoPushTokenAsync,
    getPermissionsAsync: vi.fn(),
    requestPermissionsAsync: vi.fn(),
    setNotificationHandler: vi.fn(),
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: { eas: { projectId: 'p1' } } } } }));
vi.mock('expo-application', () => ({ nativeApplicationVersion: null, nativeBuildVersion: null }));
vi.mock('expo-device', () => ({ deviceName: null, modelName: null, osName: null, osVersion: null, isDevice: true }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, Linking: { openSettings: vi.fn() } }));
vi.mock('./persistence', () => ({
    clearRegisteredPushToken: vi.fn(),
    loadRegisteredPushToken: vi.fn(() => null),
    saveRegisteredPushToken: vi.fn(),
}));
vi.mock('./apiPush', () => ({ registerPushToken: vi.fn(), unregisterPushToken: vi.fn() }));

import { getExpoPushTokenWithTimeout } from './pushRegistration';

describe('getExpoPushTokenWithTimeout', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('returns the token when FCM responds', async () => {
        getExpoPushTokenAsync.mockResolvedValue({ data: 'ExponentPushToken[x]' });
        const p = getExpoPushTokenWithTimeout('p1');
        await vi.runAllTimersAsync();
        expect(await p).toBe('ExponentPushToken[x]');
    });

    it('returns null when FCM hangs (stub google-services)', async () => {
        getExpoPushTokenAsync.mockReturnValue(new Promise(() => {})); // hangs
        const p = getExpoPushTokenWithTimeout('p1');
        await vi.advanceTimersByTimeAsync(8001);
        expect(await p).toBeNull();
    });

    it('returns null when FCM throws', async () => {
        getExpoPushTokenAsync.mockRejectedValue(new Error('no firebase'));
        const p = getExpoPushTokenWithTimeout('p1');
        await vi.runAllTimersAsync();
        expect(await p).toBeNull();
    });
});
