/**
 * Any-file picker for message attachments. Stateless: returns picked files as
 * AttachmentPreview entries (kind: 'file') for the caller to funnel into the
 * shared selected-attachments state via useImagePicker's addImages().
 *
 * Files are non-images: width/height are 0 and no thumbhash, so the file event
 * built in sync.ts omits the `image` sub-object automatically. The CLI then
 * materializes them to disk instead of inlining.
 */
import { useCallback } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import { Modal } from '@/modal';
import { t } from '@/text';
import { MAX_FILE_SIZE } from './useImagePicker';
import type { AttachmentPreview } from '@/sync/attachmentTypes';

type UseDocumentPickerResult = {
    pickDocuments: () => Promise<AttachmentPreview[]>;
};

export function useDocumentPicker(): UseDocumentPickerResult {
    const pickDocuments = useCallback(async (): Promise<AttachmentPreview[]> => {
        const result = await DocumentPicker.getDocumentAsync({
            type: '*/*',
            multiple: true,
            copyToCacheDirectory: true, // gives a readable file:// URI for readFileBytes
        });

        if (result.canceled || !result.assets?.length) return [];

        const previews: AttachmentPreview[] = [];
        for (const asset of result.assets) {
            const size = asset.size ?? 0;
            if (size > MAX_FILE_SIZE) {
                Modal.alert(
                    t('imageUpload.fileTooLargeTitle'),
                    t('imageUpload.fileTooLargeMessage', { name: asset.name ?? 'file', maxMb: 50 }),
                    [{ text: t('common.ok') }],
                );
                continue;
            }
            previews.push({
                id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
                kind: 'file',
                uri: asset.uri,
                width: 0,
                height: 0,
                mimeType: asset.mimeType ?? 'application/octet-stream',
                size,
                name: asset.name ?? `file_${Date.now()}`,
            });
        }
        return previews;
    }, []);

    return { pickDocuments };
}
