// A trade's screenshot on its way in: read from the clipboard (Paste from clipboard), and shrunk before it's kept (at
// most 2000px on its longer side, WebP, JPEG where the browser can't). No imports, so effects.js can carry it without
// pulling the Journal in.

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


/**
 * The images on the clipboard, read when you tap Paste from clipboard (the browser may ask first; iOS shows a Paste
 * bubble). Throws 'unsupported' where the browser can't read images, and the browser's own error when you say no.
 * @returns {Promise<Blob[]>}
 */
export async function readClipboardImages() {
  if (!navigator.clipboard?.read) throw Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
  const out = [];
  for (const item of await navigator.clipboard.read()) {
    const type = item.types.find(t => /^image\//.test(t));
    if (type) out.push(await item.getType(type));
  }
  return out;
}

/** the image files in a paste: from files, or from items where a browser only puts them there. @param {DataTransfer | null | undefined} data */
export function pastedImages(data) {
  const files = [...(data?.files || [])].filter(f => /^image\//.test(f.type || ''));
  if (files.length) return files;
  return [...(data?.items || [])].filter(i => i.kind === 'file' && /^image\//.test(i.type || '')).map(i => i.getAsFile()).filter(Boolean);
}
