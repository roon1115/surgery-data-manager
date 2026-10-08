window.Decode = (function() {

  // URL（file:// か blob:）を Image で読んでCanvasにdrawし、RGBA→RGB変換したUint8Arrayを返す。
  // label はエラー文言用（画面に出るので URL そのものではなく名前/パスを渡す）。
  function loadUrlAsRgb(url, label, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      let settled = false;
      let timer;
      function finish(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        img.onload = null;
        img.onerror = null;
        // 打ち切った後も読み込みが続くと、応答しない共有ドライブへの要求が溜まり続ける。
        // src を空にして読み込みを取り消す（成功時も同じ処理で画像メモリを早く手放せる）。
        try { img.src = ''; } catch (_) { /* 取り消し失敗は結果に影響しない */ }
        if (error) reject(error);
        else resolve(value);
      }
      img.onload = () => {
        if (settled) return;
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
          finish(null, { width: w, height: h, rgb });
        } catch (e) {
          finish(e);
        }
      };
      img.onerror = () => finish(new Error('image load failed: ' + label));
      // SMB の Image 読み込みは応答が返らないことがある。時間切れもデコード失敗に
      // 流し、未送信の画像が失敗キューから消えないようにする。
      // decodeTimeout は呼び出し側（連続時間切れで残りのデコードを諦める判定）が見る印。
      timer = setTimeout(() => {
        const err = new Error('image load timeout: ' + label);
        err.decodeTimeout = true;
        finish(err);
      }, timeoutMs);
      try { img.src = url; } catch (e) { finish(e); }
    });
  }

  // NAS 上のファイルを file:// で読む。
  // キャッシュ対策のクエリ（?v=）は付けない: Chromium は同一ページ内で同じ URL の画像を
  // メモリキャッシュから返すことがあるが、NAS 側のパスは患者フォルダ配下で取り込みごとに
  // 別名が割り当てられ（allocateDst）、アプリ自身が同じパスに別内容を書くことはない（ただし Finder で
  // 消してから取り込み直した場合は同じ名前が再利用され得る＝完全には排除できない）。クエリ付き file:// が
  // 実機の Chromium で読めることも手元では確認できないため、読めなくなる危険の方を避ける。
  function readFileUrlAsRgb(filePath, timeoutMs = 60000) {
    const url = 'file://' + encodeURI(filePath).replace(/#/g, '%23').replace(/\?/g, '%3F');
    return loadUrlAsRgb(url, filePath, timeoutMs);
  }

  // main が SHA-256 照合済みで返したバイト列を Blob URL 経由でデコードする。
  // Blob URL は読み込みごとに一意なので、file:// のメモリキャッシュ混同が起きない。
  // 使い終わった URL は必ず revoke する（時間切れ・失敗でも）。
  const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.bmp': 'image/bmp', '.gif': 'image/gif', '.webp': 'image/webp' };
  async function decodeBytesToRgb(bytes, name, timeoutMs = 60000) {
    const dot = String(name || '').lastIndexOf('.');
    const ext = dot >= 0 ? String(name).slice(dot).toLowerCase() : '';
    if (!isCanvasSupportedExt(ext)) {
      throw new Error('Canvas未対応形式: ' + ext + '（HEICはメイン側で前処理が必要）');
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: MIME_BY_EXT[ext] || '' }));
    try {
      return await loadUrlAsRgb(url, name, timeoutMs);
    } finally {
      URL.revokeObjectURL(url);
    }
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

  return { decodeToRgb, decodeBytesToRgb, isCanvasSupportedExt, readFileUrlAsRgb };
})();
