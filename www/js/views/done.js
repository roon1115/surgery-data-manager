window.Views = window.Views || {};
window.Views.done = (function() {
  const { el } = window.U;

  const TYPE_LABELS = {
    anesthesia: '麻酔モニター記録',
    surgicalPhoto: '手術写真',
    laparoscope: '腹腔鏡',
    bronchoscope: '気管支鏡',
    endoscope: '内視鏡',
  };

  async function render(state, mount) {
    const r = state.ingestResult || {};
    const dicom = state.dicomResult;
    const targets = state.targets || {};
    const targetEntries = Object.entries(targets);

    const newSessionBtn = el('button', { class: 'ghost', onclick: () => {
      state.reset();
      state.goto('patient');
    }}, '新しいセッションを開始');

    const dicomLine = dicom
      ? (dicom.ok
          ? el('div', { class: 'banner ok' }, `✓ DICOM送信成功: ${dicom.sent} 枚`)
          : el('div', { class: 'banner err' }, `✗ DICOM送信失敗: ${dicom.error || ''}`))
      : el('div', { class: 'banner' }, 'DICOM送信はスキップされました。');

    // 種別ごとに「フォルダを開く」ボタンを並べる
    const folderButtons = targetEntries.map(([type, p]) =>
      el('button', { class: 'ghost', onclick: () => window.App.showFolder(p), style: { fontSize: '12px' } },
        `📁 ${TYPE_LABELS[type] || type} を開く`));

    const targetsDisplay = targetEntries.length > 0
      ? el('div', { class: 'banner ok' },
          el('div', { style: { fontWeight: '600', marginBottom: '4px' } }, '作成された患者フォルダ:'),
          ...targetEntries.map(([type, p]) =>
            el('div', { style: { fontSize: '12px', marginBottom: '2px' } },
              el('span', { style: { color: 'var(--fg-mute)' } }, (TYPE_LABELS[type] || type) + ': '),
              el('span', { class: 'preview', style: { display: 'inline-block', padding: '2px 6px' } }, p))))
      : el('div', { class: 'banner' }, 'フォルダ未作成');

    const root = el('div', { class: 'card' },
      el('h2', null, '完了'),
      targetsDisplay,
      el('div', { class: 'summary' },
        el('div', { class: 'stat' }, el('div', { class: 'num' }, String(r.copied || 0)), el('div', { class: 'label' }, 'コピー成功')),
        el('div', { class: 'stat' }, el('div', { class: 'num' }, String(r.skippedDup || 0)), el('div', { class: 'label' }, '差分スキップ')),
        el('div', { class: 'stat' }, el('div', { class: 'num' }, String(r.failed || 0)), el('div', { class: 'label' }, '失敗')),
        el('div', { class: 'stat' }, el('div', { class: 'num' }, String((r.dicomCandidates || []).length)), el('div', { class: 'label' }, 'DICOM対象')),
      ),
      dicomLine,
      el('div', { class: 'actions between' },
        newSessionBtn,
        el('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } }, ...folderButtons),
      ),
    );
    mount.replaceChildren(root);
  }

  return { render };
})();
