window.Views = window.Views || {};
window.Views.source = (function() {
  const { el, formatBytes } = window.U;

  const TYPE_OPTIONS = [
    { key: 'anesthesia',     label: '麻酔モニター記録',  hint: 'CSV等' },
    { key: 'surgicalPhoto',  label: '手術写真',         hint: '写真→DICOM自動送信対象' },
    { key: 'laparoscope',    label: '腹腔鏡',           hint: '画像/動画' },
    { key: 'bronchoscope',   label: '気管支鏡',         hint: '画像/動画' },
    { key: 'endoscope',      label: '内視鏡',           hint: '画像/動画' },
  ];

  async function render(state, mount) {
    if (!state.sources) state.sources = []; // [{ path, name, files, summary, type, useHashDiff }]
    const cfg = state.settings || await window.App.settings.get();
    state.settings = cfg;
    const typeFolders = cfg.typeFolders || {};

    const banner = el('div', { class: 'banner' },
      '接続されているデバイス（SDカード等）を選び、ソースごとに「種別」を1つ選んでください。'
      + ' 種別ごとの保存先（サブフォルダ）は設定画面で事前に決められます。'
      + ' 「手術写真」を選んだソースは、コピー後に DICOM サーバーへ自動送信できます。');

    const elList = el('div'); // ソース一覧表示

    const renderSources = () => {
      elList.innerHTML = '';
      if (state.sources.length === 0) {
        elList.appendChild(el('div', { class: 'banner warn' }, '取り込み元がまだ追加されていません。上のリストから追加してください。'));
        return;
      }
      state.sources.forEach((src, idx) => {
        const summary = src.summary || { photo: 0, video: 0, csv: 0, other: 0, totalBytes: 0 };

        // 種別ラジオ
        const elTypeSelect = el('select');
        TYPE_OPTIONS.forEach(opt => {
          const o = el('option', { value: opt.key }, opt.label);
          if (src.type === opt.key) o.selected = true;
          elTypeSelect.appendChild(o);
        });
        elTypeSelect.addEventListener('change', () => {
          src.type = elTypeSelect.value;
          renderSources(); // 再描画して送信先プレビューを更新
        });

        const subfolder = typeFolders[src.type] || '(未設定)';
        const isDicom = src.type === 'surgicalPhoto';

        const elIncremental = el('input', { type: 'checkbox' });
        elIncremental.checked = src.useHashDiff !== false;
        elIncremental.addEventListener('change', () => {
          src.useHashDiff = elIncremental.checked;
        });

        const removeBtn = el('button', { class: 'ghost', onclick: () => {
          state.sources.splice(idx, 1);
          renderSources();
        }}, '削除');

        const card = el('div', { class: 'card', style: { background: 'var(--bg)' } },
          el('div', { class: 'row', style: { alignItems: 'center' } },
            el('div', { style: { flex: '3' } },
              el('div', { style: { fontWeight: '600', fontSize: '13px' } }, src.name),
              el('div', { style: { fontSize: '11px', color: 'var(--fg-mute)' } }, src.path),
            ),
            el('div', { style: { flex: '1', textAlign: 'right' } }, removeBtn),
          ),
          el('div', { class: 'summary' },
            el('div', { class: 'stat' },
              el('div', { class: 'num' }, String(src.files?.length || 0)),
              el('div', { class: 'label' }, '総ファイル数'),
            ),
            el('div', { class: 'stat' },
              el('div', { class: 'num' }, String(summary.photo)),
              el('div', { class: 'label' }, '画像'),
            ),
            el('div', { class: 'stat' },
              el('div', { class: 'num' }, String(summary.video)),
              el('div', { class: 'label' }, '動画'),
            ),
            el('div', { class: 'stat' },
              el('div', { class: 'num' }, formatBytes(summary.totalBytes)),
              el('div', { class: 'label' }, '合計サイズ'),
            ),
          ),
          el('div', { class: 'row' },
            el('label', { class: 'field' },
              el('span', { class: 'label required' }, 'このソースの種別'),
              elTypeSelect,
              el('div', { style: { fontSize: '11px', color: 'var(--fg-mute)', marginTop: '2px' } },
                src.type ? `保存先: 患者フォルダ / ${subfolder} /` + (isDicom ? '   ＋DICOM送信候補' : '') : '⚠ 種別を選択してください'),
            ),
            el('label', { class: 'field' },
              el('span', { class: 'label' }, '差分インポート（前回以降のみ）'),
              el('div', { class: 'checkbox' }, elIncremental, ' SHA-256 で既取込ファイルを除外'),
            ),
          ),
        );
        elList.appendChild(card);
      });
    };

    const elVolumes = el('ul', { class: 'volume-list' });

    async function loadVolumes() {
      elVolumes.innerHTML = '';
      const r = await window.App.ingest.listVolumes();
      if (!r.ok) {
        elVolumes.appendChild(el('li', null, 'ボリュームの取得に失敗: ' + (r.error || '')));
        return;
      }
      if (r.volumes.length === 0) {
        elVolumes.appendChild(el('li', null, '検出されたボリュームはありません。SDカード等を接続してから「再読み込み」を押してください。'));
        return;
      }
      r.volumes.forEach(vol => {
        const item = el('li', null,
          el('div', { style: { flex: '1' } },
            el('div', { style: { fontWeight: '500' } }, vol.name),
            el('div', { style: { fontSize: '11px', color: 'var(--fg-mute)' } }, vol.path),
          ),
          el('button', { class: 'primary', onclick: () => addSource(vol.path, vol.name) }, '取り込み元に追加'),
        );
        elVolumes.appendChild(item);
      });
    }

    async function addSource(srcPath, srcName) {
      const scan = await window.App.ingest.scanSource({ sourcePath: srcPath });
      if (!scan.ok) {
        U.modal({ title: 'スキャン失敗', body: scan.error || '' });
        return;
      }
      // 既存と重複しないよう確認
      if (state.sources.some(s => s.path === srcPath)) {
        U.modal({ title: '追加済み', body: 'このソースはすでに追加されています。' });
        return;
      }
      state.sources.push({
        path: srcPath,
        name: srcName,
        files: scan.files,
        summary: scan.summary,
        type: '',           // 未選択。ユーザーが必ず選ぶ
        useHashDiff: true,
      });
      renderSources();
    }

    const chooseBtn = el('button', { class: 'ghost', onclick: async () => {
      const r = await window.App.ingest.chooseSource();
      if (r.ok) {
        const name = r.path.split('/').filter(Boolean).pop() || r.path;
        await addSource(r.path, name);
      }
    }}, 'フォルダを手動で選択...');

    const reloadBtn = el('button', { class: 'ghost', onclick: loadVolumes }, '再読み込み');

    const onNext = () => {
      if (state.sources.length === 0) {
        U.modal({ title: 'ソース未選択', body: '取り込み元を1つ以上追加してください。' });
        return;
      }
      const missingType = state.sources.find(s => !s.type);
      if (missingType) {
        U.modal({ title: '種別未選択', body: `「${missingType.name}」の種別を選択してください。` });
        return;
      }
      const totalFiles = state.sources.reduce((s, src) => s + (src.files?.length || 0), 0);
      if (totalFiles === 0) {
        U.modal({ title: 'ファイルなし', body: '選択されたソースに取り込み可能なファイルがありません。' });
        return;
      }
      state.goto('ingest');
    };

    const root = el('div', null,
      el('div', { class: 'card' },
        el('h2', null, '取り込み元（接続デバイス）を選ぶ'),
        banner,
        el('h3', null, '検出されたボリューム（' + (window.App.platform === 'darwin' ? '/Volumes' : 'ドライブ') + '）'),
        el('div', { class: 'row', style: { marginBottom: '8px' } }, reloadBtn, chooseBtn),
        elVolumes,
      ),
      el('div', { class: 'card' },
        el('h2', null, '取り込み元一覧（' + state.sources.length + '）'),
        elList,
        el('div', { class: 'actions between' },
          el('button', { class: 'ghost', onclick: () => state.goto('patient') }, '← 患者情報へ'),
          el('button', { class: 'primary', onclick: onNext }, '次へ：コピー開始 →'),
        ),
      ),
    );

    mount.replaceChildren(root);
    renderSources();
    loadVolumes();
  }

  return { render };
})();
