export type ImagePreviewViewport = { width: number; height: number };
type ImagePreviewSize = { width: number; height: number };

export const getImagePreviewBounds = (
    viewport: ImagePreviewViewport,
    isMobile: boolean,
    markdownImage: boolean,
): { maxWidth: number; maxHeight: number } => ({
    maxWidth: Math.max(160, viewport.width * (markdownImage ? 0.6 : (isMobile ? 0.86 : 0.75))),
    maxHeight: Math.max(160, viewport.height * (markdownImage ? 0.8 : (isMobile ? 0.72 : 0.75))),
});

const IMAGE_DIALOG_MIN_WIDTH = 320;
const IMAGE_DIALOG_CHROME_WIDTH = 34;

export const getImagePreviewDialogLayout = (
    image: ImagePreviewSize,
    viewport: ImagePreviewViewport,
    isMobile: boolean,
): { dialogWidth: number; imageWidth: number; imageHeight: number } => {
    const viewportInset = isMobile ? 16 : 32;
    const maxDialogWidth = Math.max(160, viewport.width - viewportInset);
    const minDialogWidth = Math.min(IMAGE_DIALOG_MIN_WIDTH, maxDialogWidth);
    const dialogWidth = Math.min(
        maxDialogWidth,
        Math.max(minDialogWidth, image.width + IMAGE_DIALOG_CHROME_WIDTH),
    );
    const availableImageWidth = Math.max(1, dialogWidth - IMAGE_DIALOG_CHROME_WIDTH);
    const scale = Math.min(1, availableImageWidth / Math.max(1, image.width));

    return {
        dialogWidth: Math.round(dialogWidth),
        imageWidth: Math.max(1, Math.round(image.width * scale)),
        imageHeight: Math.max(1, Math.round(image.height * scale)),
    };
};
