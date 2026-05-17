window.Views = window.Views || {};
window.Views.done = (function() {
  const { el } = window.U;

  async function render(state, mount) {
    const r = state.ingestResult || {};
    const dicom = state.dicomResult;

    const openFolderBtn = el('button', { class: 'primary', onclick: () => {
      if (state.targetFolder) window.App.showFolder(state.targetFolder);
    }}, 'フォルダを開く');

    const newSessionBtn = el('button', { class: 'ghost', onclick: () => {
      state.reset();
      state.goto('patient');
    }}, '新しいセッションを開始');

    const dicomLine = dicom
      ? (dicom.ok
          ? el('div', { class: 'banner ok' }, `✓ DICOM送信成功: ${dicom.sent} 枚`)
          : el('div', { class: 'banner err' }, `✗ DICOM送信失敗: ${dicom.error || ''}`))
      : el('div', { class: 'banner' }, 'DICOM送信はスキップされました。');

    const root = el('div', { class: 'card' },
      el('h2', null, '完了'),
      el('div', { class: 'banner ok' },
        `フォルダ: ${state.targetFolder || '(未作成)'}`),
      el('div', { class: 'summary' },
        el('div', { class: 'stat' }, el('div', { class: 'num' }, String(r.copied || 0)), el('div', { class: 'label' }, 'コピー成功')),
        el('div', { class: 'stat' }, el('div', { class: 'num' }, String(r.skippedDup || 0)), el('div', { class: 'label' }, '差分スキップ')),
        el('div', { class: 'stat' }, el('div', { class: 'num' }, String(r.failed || 0)), el('div', { class: 'label' }, '失敗')),
        el('div', { class: 'stat' }, el('div', { class: 'num' }, String((r.dicomCandidates || []).length)), el('div', { class: 'label' }, 'DICOM対象')),
      ),
      dicomLine,
      el('div', { class: 'actions' }, newSessionBtn, openFolderBtn),
    );
    mount.replaceChildren(root);
  }

  return { render };
})();
