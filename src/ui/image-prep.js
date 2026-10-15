// Shrinking an image before it's kept (a trade's screenshot): drawn at most 2000px on its longer side and saved as WebP,
// JPEG where the browser can't. No imports, so effects.js can carry it without pulling the Journal in.

const MAX_SIDE = 2000;

/**
 * An image shrunk for keeping: drawn at most 2000px on its longer side, saved as WebP (JPEG where the browser can't).
 * Behind effects so tests can stand in for the canvas.
 * @param {File | Blob} file @returns {Promise<{ blob: Blob, type: string, width: number, height: number }>}
 */
export async function prepareImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale), height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const toBlob = type => new Promise(r => canvas.toBlob(r, type, 0.85));
  let blob = await toBlob('image/webp');
  if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg');
  if (!blob) throw new Error("couldn't read that image");
  return { blob, type: blob.type, width, height };
}

