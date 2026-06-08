import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * Web stub for the QR scanner route. react-native-vision-camera has no web
 * implementation, and scanning is gated to native platforms in the callers,
 * so this only exists to keep the web bundle from importing the native module.
 */
function ScannerScreen() {
    return (
        <View style={styles.centered}>
            <Text style={styles.message}>{t('common.error')}</Text>
        </View>
    );
}

export default React.memo(ScannerScreen);

const styles = StyleSheet.create((theme) => ({
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
    },
}));
