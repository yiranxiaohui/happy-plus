import * as React from 'react';
import { Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

/**
 * A header back button that always works — including on web after a page refresh
 * or when deep-linked, where the navigation stack is empty and the default back
 * arrow is hidden (canGoBack() === false), leaving the user stuck on a pushed
 * screen. When there's history it goes back; otherwise it replaces with the
 * given fallback route so there's always a way out.
 */
export const HeaderBackButton = React.memo(({ fallback }: { fallback: string }) => {
    const router = useRouter();
    const { theme } = useUnistyles();
    const onPress = React.useCallback(() => {
        if (router.canGoBack()) {
            router.back();
        } else {
            router.replace(fallback as any);
        }
    }, [router, fallback]);
    return (
        <Pressable onPress={onPress} hitSlop={15} style={{ paddingHorizontal: 8 }}>
            <Ionicons
                name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                size={24}
                color={theme.colors.header.tint}
            />
        </Pressable>
    );
});
