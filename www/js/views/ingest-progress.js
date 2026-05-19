window.Views = window.Views || {};
window.Views.ingest = (function() {
  const { el, formatBytes } = window.U;

  async function prepareTarget(state) {
    const usedTypes = [...new Set(state.sources.filter(s => s.type).map(s => s.type))];
    // 履歴から呼び出した患者なら衝突確認なしで追記モード ('keep')
    const onCollision = state.isExistingPatient ? 'keep' : (state.onCollision || 'keep');
    const r = await window.App.ingest.prepareTarget({
      patient: state.patient,
      date: state.patient.date,
      onCollision,
      types: usedTypes,
    });
    if (!r.ok && r.collision) {
      return new Promise((resolve) => {
        const body = el('div', null,
          el('p', null, `「${r.type}」の保存先に同名フォルダが既に存在します：`),
          el('div', { class: 'preview' }, r.target),
          el('p', null, 'どうしますか？'),
        );
        // モーダル拡張: 3つボタン
        const m = document.getElementById('modal');
        const content = document.getElementById('modal-content');
        const okBtn = document.getElementById('modal-ok');
        const cancelBtn = document.getElementById('modal-cancel');
        content.innerHTML = '';
        content.appendChild(el('h3', null, 'フォルダ衝突'));
        content.appendChild(body);
        okBtn.textContent = '追記';
        cancelBtn.textContent = '中止';
        // 3つ目「別名作成」を入れる
        const renameBtn = el('button', { class: 'primary' }, '別名(_2など)');
        okBtn.parentElement.insertBefore(renameBtn, okBtn);
        m.classList.remove('hidden');
        const cleanup = () => {
          m.classList.add('hidden');
          renameBtn.remove();
          okBtn.replaceWith(okBtn.cloneNode(true));
          cancelBtn.replaceWith(cancelBtn.cloneNode(true));
        };
        document.getElementById('modal-ok').onclick = async () => {
          cleanup();
          const r2 = await window.App.ingest.prepareTarget({
            patient: state.patient,
            date: state.patient.date,
            onCollision: 'keep',
            types: usedTypes,
          });
          resolve(r2);
        };
        renameBtn.onclick = async () => {
          cleanup();
          const r2 = await window.App.ingest.prepareTarget({
            patient: state.patient,
            date: state.patient.date,
            onCollision: 'rename',
            types: usedTypes,
          });
          resolve(r2);
        };
        document.getElementById('modal-cancel').onclick = () => {
          cleanup();
          resolve({ ok: false, error: 'ユーザー中止' });
        };
      });
    }
    return r;
  }

  function inferKindFromExt(filePath, defaultKind) {
    if (defaultKind && defaultKind !== 'auto') return defaultKind;
    const dot = filePath.lastIndexOf('.');
    const ext = (dot >= 0 ? filePath.slice(dot) : '').toLowerCase();
    if (['.jpg','.jpeg','.png','.heic','.heif','.tif','.tiff','.bmp'].includes(ext)) return 'photo';
    if (['.mp4','.mov','.m4v','.avi','.mts','.mxf','.mkv'].includes(ext)) return 'video';
    if (['.csv','.tsv','.txt'].includes(ext)) return 'csv';
    return 'other';
  }

  async function render(state, mount) {
    const elProgress = el('div', { class: 'progress-bar' }, el('div', { class: 'fill', style: { width: '0%' } }));
    const elStatus = el('div', { style: { fontSize: '12px', color: 'var(--fg-mute)' } }, '準備中...');
    const elLog = el('div', { class: 'log' });
    const elStats = el('div', { class: 'summary' },
      el('div', { class: 'stat' }, el('div', { class: 'num', id: 'st-copied' }, '0'), el('div', { class: 'label' }, 'コピー済')),
      el('div', { class: 'stat' }, el('div', { class: 'num', id: 'st-skip' }, '0'), el('div', { class: 'label' }, 'スキップ')),
      el('div', { class: 'stat' }, el('div', { class: 'num', id: 'st-fail' }, '0'), el('div', { class: 'label' }, '失敗')),
      el('div', { class: 'stat' }, el('div', { class: 'num', id: 'st-bytes' }, '0 B'), el('div', { class: 'label' }, '転送量')),
    );

    function logLine(text, cls) {
      const line = el('div', { class: cls || '' }, text);
      elLog.appendChild(line);
      elLog.scrollTop = elLog.scrollHeight;
    }

    const cancelBtn = el('button', { class: 'ghost', disabled: true }, '中断（未実装）');
    const nextBtn = el('button', { class: 'primary', disabled: true }, '次へ：DICOM送信 →');
    const skipDicomBtn = el('button', { class: 'ghost', disabled: true }, 'DICOMをスキップして完了');

    const root = el('div', { class: 'card' },
      el('h2', null, 'コピー進捗'),
      elStatus,
      elProgress,
      elStats,
      el('h3', null, 'ログ'),
      elLog,
      el('div', { class: 'actions between' },
        cancelBtn,
        el('div', null, skipDicomBtn, ' ', nextBtn),
      ),
    );
    mount.replaceChildren(root);

    // 1. ターゲットフォルダ準備
    const prep = await prepareTarget(state);
    if (!prep.ok) {
      logLine('フォルダ準備失敗: ' + (prep.error || ''), 'err');
      elStatus.textContent = '中止しました';
      cancelBtn.textContent = '戻る';
      cancelBtn.disabled = false;
      cancelBtn.classList.remove('ghost');
      cancelBtn.onclick = () => state.goto('source');
      return;
    }
    state.targets = prep.targets || {};
    state.folderName = prep.folderName;
    // 表示用: 最初の種別の patient folder を代表として保持
    const firstType = Object.keys(state.targets)[0];
    state.targetFolder = firstType ? state.targets[firstType] : null;
    for (const [t, p] of Object.entries(state.targets)) {
      logLine(`出力先 [${t}]: ${p}`, 'ok');
    }

    // 2. ファイル一覧の集約
    // プレビュー画面で f.selected = true のものだけが対象。
    // 各ソースには src.type (anesthesia/surgicalPhoto/laparoscope/bronchoscope/endoscope) が
    // ユーザーにより1つ指定されている。全ファイルにその type と useHashDiff を付与。
    const allFiles = [];
    for (const src of state.sources) {
      if (!src.type) continue; // 種別未選択は無視（呼び出し前にバリデート済）
      const srcDiff = src.useHashDiff !== false;
      for (const f of src.files) {
        if (f.selected === false) continue; // プレビューで除外されたファイル
        allFiles.push({
          ...f,
          type: src.type,            // ingest-handler が見るキー
          useHashDiff: srcDiff,      // ソース単位の差分判定設定
          sourcePath: src.path,
        });
      }
    }

    // 3. 進捗購読
    const off = window.App.ingest.onProgress((data) => {
      if (data.type === 'start') {
        elStatus.textContent = `0 / ${data.total} ファイル（${U.formatBytes(data.totalBytes)}）`;
      } else if (data.type === 'file-start') {
        elStatus.textContent = `${data.index + 1} / ${data.total}: ${data.name}`;
      } else if (data.type === 'file-done') {
        logLine('✓ ' + data.name, 'ok');
        document.getElementById('st-copied').textContent = String((parseInt(document.getElementById('st-copied').textContent, 10) || 0) + 1);
        document.getElementById('st-bytes').textContent = U.formatBytes(data.bytes);
        if (data.totalBytes > 0) {
          elProgress.firstElementChild.style.width = ((data.bytes / data.totalBytes) * 100).toFixed(1) + '%';
        }
      } else if (data.type === 'file-skip') {
        logLine('⊘ ' + data.name + '（' + data.reason + '）', 'skip');
        document.getElementById('st-skip').textContent = String((parseInt(document.getElementById('st-skip').textContent, 10) || 0) + 1);
      } else if (data.type === 'file-fail') {
        logLine('✗ ' + data.name + ' — ' + data.error, 'err');
        document.getElementById('st-fail').textContent = String((parseInt(document.getElementById('st-fail').textContent, 10) || 0) + 1);
      } else if (data.type === 'done') {
        elStatus.textContent = `完了: コピー ${data.copied} / スキップ ${data.skippedDup} / 失敗 ${data.failed}`;
        elProgress.firstElementChild.style.width = '100%';
      }
    });

    // 4. 単一プロセスで全ソースをまとめて取り込む（差分判定は各ファイルの useHashDiff を尊重）
    const useHashDiff = state.sources.some(s => s.useHashDiff);
    const result = await window.App.ingest.start({
      targets: state.targets,
      files: allFiles,
      patient: state.patient,
      folderName: state.folderName,
      useHashDiff,
    });
    off();

    state.ingestResult = result;

    if (result.failed > 0) {
      logLine(`失敗 ${result.failed} 件あり。下記参照:`, 'err');
      for (const f of (result.failures || [])) {
        logLine('  - ' + f.file + ': ' + f.error, 'err');
      }
    }

    const hasDicom = (result.dicomCandidates || []).length > 0;
    nextBtn.disabled = !hasDicom;
    skipDicomBtn.disabled = false;
    skipDicomBtn.onclick = () => state.goto('done');
    nextBtn.onclick = () => state.goto('dicom');
    if (!hasDicom) {
      logLine('DICOM対象の写真はありません。', 'skip');
    } else {
      logLine(`DICOM送信対象: ${result.dicomCandidates.length} 枚`, 'ok');
    }
  }

  return { render };
})();
