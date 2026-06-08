import * as React from 'react';
import { View, Text, Linking, ActivityIndicator } from 'react-native';
import { Camera, useCameraDevice, useCameraPermission, useCodeScanner } from 'react-native-vision-camera';
import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { useConnectAccount } from '@/hooks/useConnectAccount';
import { RoundButton } from '@/components/RoundButton';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * QR scanner screen backed by react-native-vision-camera.
 *
 * Why this exists: expo-camera's `CameraView.launchScanner()` uses the Android
 * "Google Code Scanner", which downloads its ML Kit barcode module from Play
 * Services on first use. On devices where that download is blocked/unreliable
 * the scanner simply never opens. vision-camera (with `enableCodeScanner` in
 * app.config.js) bundles ML Kit barcode scanning into the APK, so scanning
 * works fully offline. This screen renders the camera in-app instead of the
 * old imperative native overlay.
 *
 * `mode` param selects the auth flow + expected QR prefix:
 *   - 'terminal' → happy://terminal?...  (connect a CLI terminal)
 *   - 'account'  → happy:///account?...  (link a new device)
 */
function ScannerScreen() {
    const { mode } = useLocalSearchParams<{ mode?: string }>();
    const isAccount = mode === 'account';
    const prefix = isAccount ? 'happy:///account?' : 'happy://terminal?';

    const { hasPermission, requestPermission } = useCameraPermission();
    const device = useCameraDevice('back');

    // Both hooks are cheap; we only use processAuthUrl from the relevant one.
    const terminal = useConnectTerminal({ onSuccess: () => router.back() });
    const account = useConnectAccount({ onSuccess: () => router.back() });
    const processAuthUrl = isAccount ? account.processAuthUrl : terminal.processAuthUrl;

    const [active, setActive] = React.useState(true);
    const processingRef = React.useRef(false);

    // Ask for camera permission on mount if not already granted.
    React.useEffect(() => {
        if (!hasPermission) {
            requestPermission();
        }
    }, [hasPermission, requestPermission]);

    const codeScanner = useCodeScanner({
        codeTypes: ['qr'],
        onCodeScanned: (codes) => {
            if (processingRef.current) return;
            const value = codes.find((c) => typeof c.value === 'string' && c.value.startsWith(prefix))?.value;
            if (!value) return;
            processingRef.current = true;
            setActive(false);
            (async () => {
                const ok = await processAuthUrl(value);
                if (!ok) {
                    // processAuthUrl already surfaced an error modal; allow retry.
                    processingRef.current = false;
                    setActive(true);
                }
                // On success the hook's success modal calls onSuccess -> router.back().
            })();
        },
    });

    if (!hasPermission) {
        return (
            <View style={styles.centered}>
                <Text style={styles.message}>{t('modals.cameraPermissionsRequiredToScanQr')}</Text>
                <RoundButton
                    title={t('common.continue')}
                    onPress={() => Linking.openSettings()}
                />
            </View>
        );
    }

    if (!device) {
        return (
            <View style={styles.centered}>
                <Text style={styles.message}>{t('common.error')}</Text>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <Camera
                style={StyleSheet.absoluteFillObject}
                device={device}
                isActive={active}
                codeScanner={codeScanner}
            />
            <View style={styles.overlay} pointerEvents="none">
                <View style={styles.frame} />
                <Text style={styles.hint}>{t('settings.scanQrCodeToAuthenticate')}</Text>
                {!active && <ActivityIndicator color="#fff" style={styles.spinner} />}
            </View>
        </View>
    );
}

export default React.memo(ScannerScreen);

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: '#000',
    },
    centered: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        backgroundColor: theme.colors.surface,
    },
    message: {
        ...Typography.default(),
        fontSize: 16,
        color: theme.colors.text,
        textAlign: 'center',
        marginBottom: 24,
    },
    overlay: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
    },
    frame: {
        width: 250,
        height: 250,
        borderWidth: 3,
        borderColor: 'rgba(255,255,255,0.9)',
        borderRadius: 24,
        backgroundColor: 'transparent',
    },
    hint: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        color: '#fff',
        textAlign: 'center',
        marginTop: 24,
        paddingHorizontal: 24,
    },
    spinner: {
        marginTop: 24,
    },
}));
