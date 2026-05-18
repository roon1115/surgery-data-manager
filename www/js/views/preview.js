window.Views = window.Views || {};
window.Views.preview = (function() {
  const { el, formatBytes } = window.U;

  const TYPE_LABELS = {
    anesthesia: '麻酔モニター記録',
    surgicalPhoto: '手術写真',
    laparoscope: '腹腔鏡',
    bronchoscope: '気管支鏡',
    endoscope: '内視鏡',
  };

  // 拡張子から判定（DICOM対象写真かどうかの目安）
  const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.bmp']);

  async function render(state, mount) {
    const cfg = state.settings || await window.App.settings.get();
    state.settings = cfg;
    const typeFolders = cfg.typeFolders || {};

    // 初回: 全ファイルを selected=true で初期化
    for (const src of state.sources) {
      for (const f of src.files) {
        if (f.selected === undefined) f.selected = true;
      }
    }

    // フォルダ名プレビュー（patient + date から計算、ingest:prepareTarget と同じロジック）
    const dateStr = (state.patient?.date || U.todayIso());
    const sanitize = (v) => String(v || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '').trim();
    const pattern = cfg.folderPattern || '{date}_{id}_{name}_{procedure}';
    const folderName = pattern
      .replace('{date}', sanitize(dateStr))
      .replace('{id}', sanitize(state.patient?.id))
      .replace('{name}', sanitize(state.patient?.name))
      .replace('{procedure}', sanitize(state.patient?.procedure));
    const patientFolderPath = (cfg.outputRoot || '') + '/' + folderName;

    // サマリ計算関数
    function computeSummary() {
      let totalFiles = 0, totalBytes = 0, dicomFiles = 0;
      const byType = {};
      for (const src of state.sources) {
        if (!src.type) continue;
        for (const f of src.files) {
          if (!f.selected) continue;
          totalFiles++;
          totalBytes += (f.size || 0);
          byType[src.type] = (byType[src.type] || 0) + 1;
          if (src.type === 'surgicalPhoto' && PHOTO_EXT.has((f.ext || '').toLowerCase())) {
            dicomFiles++;
          }
        }
      }
      return { totalFiles, totalBytes, dicomFiles, byType };
    }

    const summaryEl = el('div', { class: 'summary' });
    const sourcesEl = el('div');

    function renderSummary() {
      const s = computeSummary();
      summaryEl.innerHTML = '';
      summaryEl.appendChild(el('div', { class: 'stat' },
        el('div', { class: 'num' }, String(s.totalFiles)),
        el('div', { class: 'label' }, 'コピー対象')));
      summaryEl.appendChild(el('div', { class: 'stat' },
        el('div', { class: 'num' }, formatBytes(s.totalBytes)),
        el('div', { class: 'label' }, '合計サイズ')));
      summaryEl.appendChild(el('div', { class: 'stat' },
        el('div', { class: 'num' }, String(s.dicomFiles)),
        el('div', { class: 'label' }, 'うちDICOM送信候補')));
      summaryEl.appendChild(el('div', { class: 'stat' },
        el('div', { class: 'num' }, String(state.sources.length)),
        el('div', { class: 'label' }, 'ソース数')));
    }

    function renderSources() {
      sourcesEl.innerHTML = '';
      state.sources.forEach((src, srcIdx) => {
        if (!src.type) {
          sourcesEl.appendChild(el('div', { class: 'banner err' },
            `⚠ ソース「${src.name}」は種別が未設定のため、コピー対象外です。`));
          return;
        }
        const subfolder = typeFolders[src.type] || src.type;
        const selectedCount = src.files.filter(f => f.selected).length;
        const totalCount = src.files.length;
        const selectedBytes = src.files.filter(f => f.selected).reduce((a, b) => a + (b.size || 0), 0);

        // ソース内の一括選択/解除
        const allOnBtn = el('button', { class: 'ghost', onclick: () => {
          src.files.forEach(f => f.selected = true);
          renderSources(); renderSummary();
        }}, '全選択');
        const allOffBtn = el('button', { class: 'ghost', onclick: () => {
          src.files.forEach(f => f.selected = false);
          renderSources(); renderSummary();
        }}, '全解除');

        // 折りたたみ機能（ファイル数が多い時）
        const expanded = src._expanded !== undefined ? src._expanded : (totalCount <= 30);
        const toggleBtn = el('button', { class: 'ghost', onclick: () => {
          src._expanded = !expanded;
          renderSources();
        }}, expanded ? '▼ 折りたたむ' : `▶ ${totalCount} 件を表示`);

        // ファイル一覧テーブル
        let fileListEl = el('div');
        if (expanded) {
          // ソート: パスのアルファベット順
          const sortedFiles = [...src.files].sort((a, b) =>
            (a.relPath || a.path).localeCompare(b.relPath || b.path));

          const ul = el('ul', { class: 'file-list', style: { maxHeight: '300px' } });
          sortedFiles.forEach((f) => {
            const filename = f.relPath || f.path.split('/').pop();
            const ext = (f.ext || '').toLowerCase();
            const isDicomCandidate = src.type === 'surgicalPhoto' && PHOTO_EXT.has(ext);

            const cb = el('input', { type: 'checkbox' });
            cb.checked = !!f.selected;
            cb.addEventListener('change', () => {
              f.selected = cb.checked;
              renderSummary();
              // ヘッダの選択数も再描画
              renderSources();
            });

            ul.appendChild(el('li', null,
              el('div', { class: 'checkbox', style: { flex: '1', minWidth: 0 } },
                cb,
                el('div', { style: { flex: '1', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, filename),
              ),
              el('div', { style: { fontSize: '11px', color: 'var(--fg-mute)', whiteSpace: 'nowrap', marginLeft: '8px' } },
                formatBytes(f.size || 0),
              ),
              isDicomCandidate
                ? el('span', { class: 'kind-badge kind-photo', style: { marginLeft: '8px' } }, 'DICOM')
                : null,
            ));
          });
          fileListEl = ul;
        }

        const card = el('div', { class: 'card', style: { background: 'var(--bg)' } },
          el('div', { class: 'row', style: { alignItems: 'center' } },
            el('div', { style: { flex: '3' } },
              el('div', { style: { fontWeight: '600', fontSize: '13px' } }, src.name),
              el('div', { style: { fontSize: '11px', color: 'var(--fg-mute)' } }, src.path),
            ),
            el('span', { class: `kind-badge ${src.type === 'anesthesia' ? 'kind-csv' : 'kind-photo'}` },
              TYPE_LABELS[src.type] || src.type),
          ),
          el('div', { style: { fontSize: '12px', color: 'var(--fg-mute)', margin: '8px 0' } },
            '保存先: ',
            el('span', { class: 'preview', style: { display: 'inline-block', padding: '2px 6px' } },
              `${patientFolderPath}/${subfolder}/`),
          ),
          el('div', { class: 'row', style: { alignItems: 'center', marginBottom: '8px' } },
            el('div', { style: { flex: '1', fontSize: '12px' } },
              `選択: ${selectedCount} / ${totalCount} ファイル（${formatBytes(selectedBytes)}）`,
              src.useHashDiff !== false
                ? el('span', { style: { marginLeft: '8px', color: 'var(--ok)' } }, '✓ 差分インポート有効（既取込ファイルは自動スキップ）')
                : null,
            ),
            allOnBtn, allOffBtn, toggleBtn,
          ),
          fileListEl,
        );
        sourcesEl.appendChild(card);
      });
    }

    const backBtn = el('button', { class: 'ghost', onclick: () => state.goto('source') }, '← 取り込み元へ戻る');
    const startBtn = el('button', { class: 'primary', onclick: () => {
      const s = computeSummary();
      if (s.totalFiles === 0) {
        U.modal({ title: 'コピー対象なし', body: 'チェックされているファイルがありません。' });
        return;
      }
      state.goto('ingest');
    }}, 'コピー開始 →');

    const root = el('div', null,
      el('div', { class: 'card' },
        el('h2', null, 'コピー内容プレビュー'),
        el('div', { class: 'banner ok' },
          '出力先（患者フォルダ）: ',
          el('span', { class: 'preview', style: { display: 'inline-block', padding: '2px 6px' } },
            patientFolderPath),
        ),
        el('h3', null, 'サマリ'),
        summaryEl,
      ),
      el('div', { class: 'card' },
        el('h2', null, 'ソース別 内訳'),
        el('div', { class: 'banner' },
          '実際にコピーされる前に確認してください。不要なファイルはチェックを外すと除外できます。'
          + ' 差分インポートが有効なソースは、既に取り込み済みのファイルがコピー時に自動スキップされます。'),
        sourcesEl,
        el('div', { class: 'actions between' },
          backBtn,
          startBtn,
        ),
      ),
    );

    mount.replaceChildren(root);
    renderSources();
    renderSummary();
  }

  return { render };
})();
