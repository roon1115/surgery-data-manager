window.Views = window.Views || {};
window.Views.source = (function() {
  const { el, formatBytes } = window.U;

  async function render(state, mount) {
    if (!state.sources) state.sources = []; // [{ path, name, files, summary, defaultKind, isSurgicalPhoto }]

    const banner = el('div', { class: 'banner' },
      'SDカード等のソースを追加し、それぞれの中身に対して「写真／動画／CSV」の種別を選んでください。'
      + '「手術写真として送信」をONにすると DICOM 送信対象になります。');

    const elList = el('div'); // ソース一覧表示

    const renderSources = () => {
      elList.innerHTML = '';
      if (state.sources.length === 0) {
        elList.appendChild(el('div', { class: 'banner warn' }, '取り込み元がまだ追加されていません。'));
      }
      state.sources.forEach((src, idx) => {
        const summary = src.summary || { photo: 0, video: 0, csv: 0, other: 0, totalBytes: 0 };
        const kindOptions = ['photo', 'video', 'csv', 'auto'];
        const kindLabels = { photo: '写真', video: '動画', csv: '麻酔CSV', auto: '拡張子で自動判定' };

        const elKindSelect = el('select');
        kindOptions.forEach(k => {
          const o = el('option', { value: k }, kindLabels[k]);
          if (src.defaultKind === k) o.selected = true;
          elKindSelect.appendChild(o);
        });
        elKindSelect.addEventListener('change', () => {
          src.defaultKind = elKindSelect.value;
        });

        const elSurgical = el('input', { type: 'checkbox' });
        elSurgical.checked = !!src.isSurgicalPhoto;
        elSurgical.addEventListener('change', () => {
          src.isSurgicalPhoto = elSurgical.checked;
        });

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
            el('div', { style: { flex: '1' } }, removeBtn),
          ),
          el('div', { class: 'summary' },
            el('div', { class: 'stat' },
              el('div', { class: 'num' }, String(summary.photo)),
              el('div', { class: 'label' }, '写真'),
            ),
            el('div', { class: 'stat' },
              el('div', { class: 'num' }, String(summary.video)),
              el('div', { class: 'label' }, '動画'),
            ),
            el('div', { class: 'stat' },
              el('div', { class: 'num' }, String(summary.csv)),
              el('div', { class: 'label' }, 'CSV'),
            ),
            el('div', { class: 'stat' },
              el('div', { class: 'num' }, formatBytes(summary.totalBytes)),
              el('div', { class: 'label' }, '合計サイズ'),
            ),
          ),
          el('div', { class: 'row' },
            el('label', { class: 'field' },
              el('span', { class: 'label' }, 'このソースの既定種別'),
              elKindSelect,
            ),
            el('label', { class: 'field' },
              el('span', { class: 'label' }, '手術写真として送信（DICOM対象）'),
              el('div', { class: 'checkbox' }, elSurgical, ' ON でDICOMサーバーへC-STORE送信'),
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
        elVolumes.appendChild(el('li', null, '検出されたボリュームはありません。'));
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
      state.sources.push({
        path: srcPath,
        name: srcName,
        files: scan.files,
        summary: scan.summary,
        defaultKind: 'auto',
        isSurgicalPhoto: false,
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
      const totalFiles = state.sources.reduce((s, src) => s + (src.files?.length || 0), 0);
      if (totalFiles === 0) {
        U.modal({ title: 'ファイルなし', body: '選択されたソースに取り込み可能なファイルがありません。' });
        return;
      }
      state.goto('ingest');
    };

    const root = el('div', null,
      el('div', { class: 'card' },
        el('h2', null, '取り込み元を選ぶ'),
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
