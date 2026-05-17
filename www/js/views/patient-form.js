window.Views = window.Views || {};
window.Views.patient = (function() {
  const { el, todayIso, sanitize, toRomaji } = window.U;

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

    elId.addEventListener('input', updatePreview);
    elName.addEventListener('input', updatePreview);
    elProcedure.addEventListener('input', updatePreview);
    elDate.addEventListener('input', updatePreview);
    elNameRomaji.addEventListener('input', () => {
      elNameRomaji.dataset.manual = '1';
      updatePreview();
    });

    updatePreview();

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

    const root = el('div', { class: 'card' },
      el('h2', null, '患者情報'),
      cfgWarn,
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
        el('span', { class: 'label' }, 'フォルダ名（NAS上に作成）'),
        elPreview,
      ),
      el('div', { class: 'field' },
        el('span', { class: 'label' }, 'DICOM タグ（送信時）'),
        elDicomPreview,
      ),
      el('div', { class: 'actions between' },
        el('button', { class: 'ghost', onclick: () => state.goto('settings') }, '← 設定へ'),
        el('button', { class: 'primary', onclick: onNext, disabled: !cfg.outputRoot }, '次へ：取り込み元選択 →'),
      ),
    );

    mount.replaceChildren(root);
  }

  return { render };
})();
