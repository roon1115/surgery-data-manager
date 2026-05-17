window.Decode = (function() {

  // file:// URL を Image で読んでCanvasにdrawし、RGBA→RGB変換したUint8Arrayを返す
  function readFileUrlAsRgb(filePath) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const maxEdge = 2048;
          let w = img.naturalWidth, h = img.naturalHeight;
          if (w > maxEdge || h > maxEdge) {
            const r = Math.min(maxEdge / w, maxEdge / h);
            w = Math.round(w * r);
            h = Math.round(h * r);
          }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const data = ctx.getImageData(0, 0, w, h).data; // RGBA
          const rgb = new Uint8Array(w * h * 3);
          let j = 0;
          for (let i = 0; i < data.length; i += 4) {
            rgb[j++] = data[i];
            rgb[j++] = data[i + 1];
            rgb[j++] = data[i + 2];
          }
          resolve({ width: w, height: h, rgb });
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = () => reject(new Error('image load failed: ' + filePath));
      const url = 'file://' + encodeURI(filePath).replace(/#/g, '%23').replace(/\?/g, '%3F');
      img.src = url;
    });
  }

  function isCanvasSupportedExt(ext) {
    const e = (ext || '').toLowerCase();
    return e === '.jpg' || e === '.jpeg' || e === '.png' || e === '.bmp' || e === '.gif' || e === '.webp';
  }

  async function decodeToRgb(filePath) {
    const dot = filePath.lastIndexOf('.');
    const ext = dot >= 0 ? filePath.slice(dot) : '';
    if (!isCanvasSupportedExt(ext)) {
      throw new Error('Canvas未対応形式: ' + ext + '（HEICはメイン側で前処理が必要）');
    }
    return await readFileUrlAsRgb(filePath);
  }

  return { decodeToRgb, isCanvasSupportedExt };
})();
