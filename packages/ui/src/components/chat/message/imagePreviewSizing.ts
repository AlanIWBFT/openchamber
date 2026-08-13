export type ImagePreviewViewport = { width: number; height: number };
type ImagePreviewSize = { width: number; height: number };
export type ImagePreviewPoint = { x: number; y: number };
type ImagePreviewTransform = { scale: number; x: number; y: number };

export const IDENTITY_IMAGE_PREVIEW_TRANSFORM: ImagePreviewTransform = { scale: 1, x: 0, y: 0 };
const MAX_IMAGE_PREVIEW_SCALE = 4;

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

const midpoint = (first: ImagePreviewPoint, second: ImagePreviewPoint): ImagePreviewPoint => ({
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
});

const distance = (first: ImagePreviewPoint, second: ImagePreviewPoint): number => (
    Math.hypot(second.x - first.x, second.y - first.y)
);

export const getContainedImagePreviewSize = (
    image: ImagePreviewSize,
    viewport: ImagePreviewViewport,
): ImagePreviewSize => {
    const scale = Math.min(
        viewport.width / Math.max(1, image.width),
        viewport.height / Math.max(1, image.height),
    );
    return {
        width: image.width * scale,
        height: image.height * scale,
    };
};

export const getLocalImagePreviewPoints = (
    points: ImagePreviewPoint[],
    origin: ImagePreviewPoint,
): ImagePreviewPoint[] => points.map((point) => ({
    x: point.x - origin.x,
    y: point.y - origin.y,
}));

export const clampImagePreviewTransform = (
    transform: ImagePreviewTransform,
    viewport: ImagePreviewViewport,
    content: ImagePreviewSize,
): ImagePreviewTransform => {
    const scale = Math.min(MAX_IMAGE_PREVIEW_SCALE, Math.max(1, transform.scale));
    const maxX = Math.max(0, (content.width * scale - viewport.width) / 2);
    const maxY = Math.max(0, (content.height * scale - viewport.height) / 2);

    return {
        scale,
        x: Math.min(maxX, Math.max(-maxX, scale === 1 ? 0 : transform.x)),
        y: Math.min(maxY, Math.max(-maxY, scale === 1 ? 0 : transform.y)),
    };
};

export const getImagePreviewGestureTransform = (
    transform: ImagePreviewTransform,
    previousPoints: ImagePreviewPoint[],
    currentPoints: ImagePreviewPoint[],
    viewport: ImagePreviewViewport,
    content: ImagePreviewSize,
): ImagePreviewTransform => {
    if (previousPoints.length >= 2 && currentPoints.length >= 2) {
        const previousDistance = distance(previousPoints[0], previousPoints[1]);
        if (previousDistance <= 0) return transform;

        const previousMidpoint = midpoint(previousPoints[0], previousPoints[1]);
        const currentMidpoint = midpoint(currentPoints[0], currentPoints[1]);
        const scale = Math.min(
            MAX_IMAGE_PREVIEW_SCALE,
            Math.max(1, transform.scale * distance(currentPoints[0], currentPoints[1]) / previousDistance),
        );
        const ratio = scale / transform.scale;
        const center = { x: viewport.width / 2, y: viewport.height / 2 };

        return clampImagePreviewTransform({
            scale,
            x: currentMidpoint.x - center.x - (previousMidpoint.x - center.x - transform.x) * ratio,
            y: currentMidpoint.y - center.y - (previousMidpoint.y - center.y - transform.y) * ratio,
        }, viewport, content);
    }

    if (previousPoints.length === 1 && currentPoints.length === 1 && transform.scale > 1) {
        return clampImagePreviewTransform({
            ...transform,
            x: transform.x + currentPoints[0].x - previousPoints[0].x,
            y: transform.y + currentPoints[0].y - previousPoints[0].y,
        }, viewport, content);
    }

    return transform;
};
