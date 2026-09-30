/**
 * Tăng sáng và tương phản trên đúng ảnh người vận hành vừa chọn.
 * Không sinh ảnh mới và không đổi bố cục.
 */
export async function improveCatalogPhoto(file: File): Promise<{ file: File; note: string }> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    return { file, note: 'Trình duyệt không xử lý được ảnh. Giữ file gốc.' };
  }
  context.drawImage(bitmap, 0, 0);
  const frame = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = frame.data;
  const brightness = 1.08;
  const contrast = 1.06;
  const intercept = 128 * (1 - contrast);
  for (let index = 0; index < pixels.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const lifted = pixels[index + channel] * brightness;
      pixels[index + channel] = Math.max(0, Math.min(255, Math.round(lifted * contrast + intercept)));
    }
  }
  context.putImageData(frame, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  bitmap.close();
  if (!blob) {
    return { file, note: 'Không xuất được ảnh đã chỉnh. Giữ file gốc.' };
  }
  const name = file.name.replace(/\.[^.]+$/, '') || 'product';
  return {
    file: new File([blob], `${name}-improved.jpg`, { type: 'image/jpeg' }),
    note: 'Đã tăng sáng 8% và tương phản 6% trên ảnh vừa chọn.',
  };
}
