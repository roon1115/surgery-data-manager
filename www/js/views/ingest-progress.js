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
      el('div', { class: 'stat' }, el('div', { class: 'num', id: 'st-bytes' }, '0 B'), el('div', { class: 'label' }, '処理済')),
    );

    function logLine(text, cls) {
      const line = el('div', { class: cls || '' }, text);
      elLog.appendChild(line);
      elLog.scrollTop = elLog.scrollHeight;
    }

    const cancelBtn = el('button', { class: 'danger' }, '中断');
    const nextBtn = el('button', { class: 'primary', disabled: true }, '次へ：DICOM送信 →');
    const skipDicomBtn = el('button', { class: 'ghost', disabled: true }, 'DICOMをスキップして完了');

    cancelBtn.onclick = async () => {
      if (!confirm('現在のコピーを中断しますか？\n進行中のファイルは削除されます。これまでコピー済みのファイルは残ります。')) return;
      cancelBtn.disabled = true;
      cancelBtn.textContent = '中断中...';
      await window.App.ingest.cancel();
    };

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
    // v0.3.16: コピーは並列実行されるため、ファイル index ではなく完了数で進捗表示する
    let totalFiles = 0;
    let processedCount = 0; // done + skip + fail の合計
    const countedIdx = new Set(); // 同一ファイルが複数イベントを出しても1回だけ数える
    const inFlightNames = new Map(); // index -> name（並列コピー中のファイル名表示用）
    const countOnce = (idx) => {
      if (idx != null && countedIdx.has(idx)) return;
      if (idx != null) countedIdx.add(idx);
      processedCount++;
    };
    const updateStatus = () => {
      const names = [...inFlightNames.values()];
      let suffix = '';
      if (names.length > 0) {
        const shown = names.slice(0, 2).join(', ');
        suffix = ` — コピー中: ${shown}` + (names.length > 2 ? ` ほか${names.length - 2}件` : '');
      }
      elStatus.textContent = `${processedCount} / ${totalFiles} ファイル完了${suffix}`;
    };
    const off = window.App.ingest.onProgress((data) => {
      if (data.type === 'start') {
        totalFiles = data.total;
        elStatus.textContent = `0 / ${data.total} ファイル（${U.formatBytes(data.totalBytes)}）`;
      } else if (data.type === 'file-start') {
        inFlightNames.set(data.index, data.name);
        updateStatus();
      } else if (data.type === 'file-done') {
        countOnce(data.index);
        inFlightNames.delete(data.index);
        updateStatus();
        logLine('✓ ' + data.name, 'ok');
        document.getElementById('st-copied').textContent = String((parseInt(document.getElementById('st-copied').textContent, 10) || 0) + 1);
        document.getElementById('st-bytes').textContent = U.formatBytes(data.bytes);
        if (data.totalBytes > 0) {
          elProgress.firstElementChild.style.width = ((data.bytes / data.totalBytes) * 100).toFixed(1) + '%';
        }
      } else if (data.type === 'file-skip') {
        countOnce(data.index);
        inFlightNames.delete(data.index);
        updateStatus();
        logLine('⊘ ' + data.name + '（' + (data.reason === 'duplicate' ? '重複' : data.reason) + '）', 'skip');
        document.getElementById('st-skip').textContent = String((parseInt(document.getElementById('st-skip').textContent, 10) || 0) + 1);
        if (data.totalBytes > 0 && data.bytes != null) {
          elProgress.firstElementChild.style.width = ((data.bytes / data.totalBytes) * 100).toFixed(1) + '%';
        }
      } else if (data.type === 'file-fail') {
        countOnce(data.index);
        inFlightNames.delete(data.index);
        updateStatus();
        logLine('✗ ' + data.name + ' — ' + data.error, 'err');
        document.getElementById('st-fail').textContent = String((parseInt(document.getElementById('st-fail').textContent, 10) || 0) + 1);
        if (data.totalBytes > 0 && data.bytes != null) {
          elProgress.firstElementChild.style.width = ((data.bytes / data.totalBytes) * 100).toFixed(1) + '%';
        }
      } else if (data.type === 'file-warn') {
        // 警告（削除見送り等）: コピー/スキップ自体は成功しているので失敗カウンタは増やさない
        logLine('⚠ ' + data.name + ' — ' + data.error, 'warn');
      } else if (data.type === 'file-deleted') {
        logLine('🗑 元データ削除: ' + data.name, 'warn');
      } else if (data.type === 'dirs-cleaned') {
        logLine(`🗂 空になったソースフォルダを ${data.removedDirs} 件削除`, 'warn');
      } else if (data.type === 'done') {
        const delPart = data.deleted ? ` / 削除 ${data.deleted}` : '';
        if (data.cancelled) {
          elStatus.textContent = `中断しました: コピー済 ${data.copied} / スキップ ${data.skippedDup} / 失敗 ${data.failed}${delPart}`;
          logLine('ユーザー操作により中断されました', 'warn');
        } else {
          elStatus.textContent = `完了: コピー ${data.copied} / スキップ ${data.skippedDup} / 失敗 ${data.failed}${delPart}`;
          if (data.deleted) logLine(`元データを ${data.deleted} 件削除（二重ハッシュ照合＋削除前検証済み）`, 'warn');
          elProgress.firstElementChild.style.width = '100%';
        }
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

    // 失敗（コピーできなかったもの）と警告（コピー/スキップは成功したが削除を見送ったもの等）を分けて表示。
    // 警告は failed=0 でも必ず表示する（元データが残る理由をユーザーに見せる）。
    const failList = result.failures || [];
    if (failList.length > 0) {
      logLine(`失敗 ${failList.length} 件。下記参照:`, 'err');
      for (const f of failList) {
        logLine('  - ' + f.file + ': ' + f.error, 'err');
      }
    }
    const warnList = result.warnings || [];
    if (warnList.length > 0) {
      logLine(`警告 ${warnList.length} 件（コピー/スキップは成功。元データの削除を見送った項目など）:`, 'warn');
      for (const w of warnList) {
        logLine('  - ' + w.file + ': ' + w.error, 'warn');
      }
    }

    // 中断後は「中断」ボタンを「戻る」に変更
    cancelBtn.classList.remove('danger');
    cancelBtn.classList.add('ghost');
    cancelBtn.textContent = result.cancelled ? '← プレビューへ戻る' : '中断';
    cancelBtn.disabled = !result.cancelled;
    cancelBtn.onclick = () => state.goto('preview');

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
