window.Views = window.Views || {};
window.Views.patient = (function() {
  const { el, todayIso, sanitize, toRomaji, formatBytes } = window.U;

  function formatRelTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'たった今';
    if (min < 60) return `${min}分前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}時間前`;
    const day = Math.floor(hr / 24);
    if (day < 30) return `${day}日前`;
    const d = new Date(ts);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }

  async function render(state, mount) {
    if (!state.patient) {
      state.patient = { id: '', name: '', nameRomaji: '', procedure: '', date: todayIso() };
    }
    const p = state.patient;
    const cfg = state.settings || await window.App.settings.get();
    state.settings = cfg;

    const elId = el('input', { type: 'text', value: p.id, placeholder: '例: P0001' });
    const elName = el('input', { type: 'text', value: p.name, placeholder: '例: モモ（カタカナ可）' });
    const elNameRomaji = el('input', { type: 'text', value: p.nameRomaji, placeholder: 'DICOM送信用（英数）' });
    const elProcedure = el('input', { type: 'text', value: p.procedure, placeholder: '例: 去勢術' });
    const elDate = el('input', { type: 'date', value: p.date });
    const elPreview = el('div', { class: 'preview' }, '—');
    const elDicomPreview = el('div', { class: 'preview', style: { background: 'rgba(245,158,11,0.1)' } }, '—');

    // 「呼び出し中」バッジ（履歴から呼び出した場合に表示）
    const recallBadge = el('div', { class: 'banner ok', style: { display: state.isExistingPatient ? 'block' : 'none' } },
      '過去の患者から呼び出し中：同じ患者フォルダにデータを追記します（衝突確認なし）');

    function updatePreview() {
      const id = sanitize(elId.value);
      const name = sanitize(elName.value);
      const procedure = sanitize(elProcedure.value);
      const date = elDate.value || todayIso();
      const pattern = cfg.folderPattern || '{date}_{id}_{name}_{procedure}';
      const folder = pattern
        .replace('{date}', date)
        .replace('{id}', id || '_')
        .replace('{name}', name || '_')
        .replace('{procedure}', procedure || '_');
      elPreview.textContent = folder;

      // DICOM PatientName プレビュー: カタカナ→ローマ字（手動上書きしていなければ）
      if (!elNameRomaji.dataset.manual) {
        const autoRomaji = toRomaji(elName.value);
        elNameRomaji.value = autoRomaji;
      }
      const dicomName = (elNameRomaji.value || '').replace(/[^\x20-\x7E]/g, '');
      const dicomId = (elId.value || '').replace(/[^\x20-\x7E]/g, '');
      elDicomPreview.textContent = `PatientID: ${dicomId || '(空)'} / PatientName: ${dicomName || '(空)'}`;
    }

    elId.addEventListener('input', () => { state.isExistingPatient = false; recallBadge.style.display = 'none'; updatePreview(); });
    elName.addEventListener('input', () => { state.isExistingPatient = false; recallBadge.style.display = 'none'; updatePreview(); });
    elProcedure.addEventListener('input', () => { state.isExistingPatient = false; recallBadge.style.display = 'none'; updatePreview(); });
    elDate.addEventListener('input', () => { state.isExistingPatient = false; recallBadge.style.display = 'none'; updatePreview(); });
    elNameRomaji.addEventListener('input', () => {
      elNameRomaji.dataset.manual = '1';
      updatePreview();
    });

    updatePreview();

    // 過去患者から呼び出し
    function applyRecalled(item) {
      const pt = item.patient || {};
      elId.value = pt.id || '';
      elName.value = pt.name || '';
      elNameRomaji.value = pt.nameRomaji || '';
      elNameRomaji.dataset.manual = '1';
      elProcedure.value = pt.procedure || '';
      elDate.value = pt.date || todayIso();
      state.isExistingPatient = true;
      recallBadge.style.display = 'block';
      updatePreview();
    }

    const recentListEl = el('div');
    async function renderRecent() {
      const r = await window.App.history.listRecent({ limit: 30 });
      recentListEl.innerHTML = '';
      if (!r.ok || !r.items || r.items.length === 0) {
        recentListEl.appendChild(el('div', { style: { fontSize: '12px', color: 'var(--fg-mute)' } },
          '過去の取り込み履歴はまだありません。'));
        return;
      }
      const ul = el('ul', { class: 'volume-list', style: { maxHeight: '260px' } });
      r.items.forEach(item => {
        const pt = item.patient || {};
        const selectBtn = el('button', { class: 'primary', onclick: () => applyRecalled(item) }, '呼び出す');
        const removeBtn = el('button', { class: 'ghost', style: { fontSize: '11px' }, onclick: async () => {
          if (!confirm(`「${item.folderName}」を履歴から削除しますか？（フォルダ自体は残ります）`)) return;
          await window.App.history.remove(item.folderName);
          renderRecent();
        }}, '削除');
        ul.appendChild(el('li', null,
          el('div', { style: { flex: '1', minWidth: 0 } },
            el('div', { style: { fontWeight: '500', fontSize: '13px' } }, item.folderName),
            el('div', { style: { fontSize: '11px', color: 'var(--fg-mute)' } },
              `${pt.procedure || ''}　|　最終: ${formatRelTime(item.lastIngestAt)}　|　取り込み ${item.ingestCount || 1}回 / ${item.totalFiles || 0}ファイル`),
          ),
          selectBtn, ' ', removeBtn,
        ));
      });
      recentListEl.appendChild(ul);
    }
    renderRecent();

    const recallCard = el('div', { class: 'card', style: { background: 'var(--bg)' } },
      el('div', { class: 'row', style: { alignItems: 'center', marginBottom: '8px' } },
        el('div', { style: { flex: '1' } },
          el('h3', { style: { margin: 0 } }, '過去の患者から呼び出す'),
          el('div', { style: { fontSize: '11px', color: 'var(--fg-mute)', marginTop: '2px' } },
            'SDカードを差し替えて同じ症例のデータを追加で取り込む場合に使います。'),
        ),
        el('button', { class: 'ghost', onclick: renderRecent }, '↻ 更新'),
      ),
      recentListEl,
    );

    const onNext = () => {
      if (!elId.value.trim()) {
        U.modal({ title: '入力エラー', body: '患者IDを入力してください。' });
        return;
      }
      if (!elName.value.trim()) {
        U.modal({ title: '入力エラー', body: '患者名を入力してください。' });
        return;
      }
      if (!elProcedure.value.trim()) {
        U.modal({ title: '入力エラー', body: '処置名を入力してください。' });
        return;
      }
      if (!elNameRomaji.value.trim()) {
        U.modal({ title: '入力エラー', body: 'DICOM送信用の患者名（英数）を入力してください。' });
        return;
      }
      state.patient = {
        id: elId.value.trim(),
        name: elName.value.trim(),
        nameRomaji: elNameRomaji.value.trim().replace(/[^\x20-\x7E]/g, ''),
        procedure: elProcedure.value.trim(),
        date: elDate.value || todayIso(),
      };
      state.goto('source');
    };

    const cfgWarn = !cfg.outputRoot
      ? el('div', { class: 'banner warn' }, '出力ルートが未設定です。先に設定画面で指定してください。')
      : el('div', { class: 'banner ok' }, `出力ルート: ${cfg.outputRoot}`);

    const formCard = el('div', { class: 'card' },
      el('h2', null, '患者情報'),
      cfgWarn,
      recallBadge,
      el('div', { class: 'row' },
        el('label', { class: 'field' },
          el('span', { class: 'label required' }, '患者ID'),
          elId,
        ),
        el('label', { class: 'field' },
          el('span', { class: 'label required' }, '日付'),
          elDate,
        ),
      ),
      el('label', { class: 'field' },
        el('span', { class: 'label required' }, '患者名（カタカナ可）'),
        elName,
      ),
      el('label', { class: 'field' },
        el('span', { class: 'label required' }, 'DICOM 送信用 患者名（英数・ローマ字）'),
        elNameRomaji,
        el('div', { style: { fontSize: '11px', color: 'var(--fg-mute)', marginTop: '2px' } },
          'カタカナから自動変換しますが、PACSの登録名に合わせて手動修正できます。'),
      ),
      el('label', { class: 'field' },
        el('span', { class: 'label required' }, '処置名'),
        elProcedure,
      ),
      el('h3', null, 'プレビュー'),
      el('div', { class: 'field' },
        el('span', { class: 'label' }, 'フォルダ名'),
        elPreview,
      ),
      el('div', { class: 'field' },
        el('span', { class: 'label' }, 'DICOM タグ（送信時）'),
        elDicomPreview,
      ),
      el('div', { class: 'actions between' },
        el('button', { class: 'ghost', onclick: () => state.goto('settings') }, '← 設定へ'),
        el('div', null,
          el('button', { class: 'ghost', onclick: () => {
            elId.value = '';
            elName.value = '';
            elNameRomaji.value = '';
            delete elNameRomaji.dataset.manual;
            elProcedure.value = '';
            elDate.value = todayIso();
            state.isExistingPatient = false;
            recallBadge.style.display = 'none';
            updatePreview();
          }}, '🗑 クリア'),
          ' ',
          el('button', { class: 'primary', onclick: onNext, disabled: !cfg.outputRoot }, '次へ：取り込み元選択 →'),
        ),
      ),
    );

    mount.replaceChildren(el('div', null, recallCard, formCard));
  }

  return { render };
})();
