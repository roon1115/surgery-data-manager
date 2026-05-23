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

  // /Volumes/ 配下で、かつ手動選択フォルダ（ローカルディレクトリ）ではなく
  // ボリュームトップ階層に近いものを取り外し候補とする
  function isEjectable(srcPath) {
    return typeof srcPath === 'string' && srcPath.startsWith('/Volumes/');
  }
  // ボリュームのルート（/Volumes/XXX）を抽出
  function volumeRoot(srcPath) {
    const m = srcPath.match(/^(\/Volumes\/[^/]+)/);
    return m ? m[1] : srcPath;
  }

  async function render(state, mount) {
    const r = state.ingestResult || {};
    const dicom = state.dicomResult;
    const targets = state.targets || {};
    const targetEntries = Object.entries(targets);

    // 取り外し候補のユニークなボリューム一覧
    const ejectables = Array.from(new Set(
      (state.sources || [])
        .map(s => s.path)
        .filter(isEjectable)
        .map(volumeRoot)
    ));

    const newSessionBtn = el('button', { class: 'ghost', onclick: () => {
      state.reset();
      state.goto('patient');
    }}, '新しいセッションを開始');

    const dicomLine = dicom
      ? (dicom.ok
          ? el('div', { class: 'banner ok' }, `✓ DICOM送信成功: ${dicom.sent} 枚`)
          : el('div', { class: 'banner err' }, `✗ DICOM送信失敗: ${dicom.error || ''}`))
      : el('div', { class: 'banner' }, 'DICOM送信はスキップされました。');

    // 種別ごとに「フォルダを開く」ボタン
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

    // 取り外しセクション
    const ejectListEl = el('div');
    function renderEjectList() {
      ejectListEl.innerHTML = '';
      if (ejectables.length === 0) {
        ejectListEl.appendChild(el('div', { style: { fontSize: '12px', color: 'var(--fg-mute)' } },
          '取り外し可能なリムーバブルデバイス (/Volumes/) はありません。'));
        return;
      }
      ejectables.forEach((vol) => {
        const status = el('span', { style: { marginLeft: '8px', fontSize: '12px' } }, '');
        const btn = el('button', { class: 'primary', onclick: async () => {
          btn.disabled = true;
          status.textContent = '取り外し中...';
          status.style.color = 'var(--fg-mute)';
          const r = await window.App.ingest.ejectVolume(vol);
          if (r.ok) {
            status.textContent = '✓ 取り外せます（物理的に抜いてください）';
            status.style.color = 'var(--ok)';
            btn.textContent = '✓ 取り外し完了';
          } else if (r.alreadyEjected) {
            status.textContent = '（既に取り外し済み）';
            status.style.color = 'var(--fg-mute)';
            btn.textContent = '— 完了';
          } else {
            status.textContent = '✗ ' + (r.error || '失敗');
            status.style.color = 'var(--err)';
            btn.disabled = false;
          }
        }}, '📤 取り外す');
        ejectListEl.appendChild(el('div', { class: 'row', style: { alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)' } },
          el('div', { style: { flex: '2', fontFamily: 'SF Mono, Monaco, monospace', fontSize: '12px' } }, vol),
          el('div', { style: { flex: '1', textAlign: 'right' } }, btn, status),
        ));
      });
    }
    renderEjectList();

    const ejectAllBtn = ejectables.length > 1
      ? el('button', { class: 'ghost', style: { marginTop: '8px' }, onclick: async () => {
          for (const vol of ejectables) {
            await window.App.ingest.ejectVolume(vol);
          }
          renderEjectList();
        }}, '全てまとめて取り外す')
      : null;

    const ejectSection = ejectables.length > 0
      ? el('div', { class: 'card', style: { background: 'var(--bg)' } },
          el('h3', { style: { margin: '0 0 8px 0' } }, '📤 取り込み元デバイスの取り外し'),
          el('div', { style: { fontSize: '11px', color: 'var(--fg-mute)', marginBottom: '10px' } },
            'コピーが完了しました。SD カード等を安全に取り外せます。'),
          ejectListEl,
          ejectAllBtn,
        )
      : null;

    const root = el('div', { class: 'card' },
      el('h2', null, '完了'),
      targetsDisplay,
      el('div', { class: 'summary' },
        el('div', { class: 'stat' }, el('div', { class: 'num' }, String(r.copied || 0)), el('div', { class: 'label' }, 'コピー成功')),
        el('div', { class: 'stat' }, el('div', { class: 'num' }, String(r.skippedDup || 0)), el('div', { class: 'label' }, '差分スキップ')),
        el('div', { class: 'stat' }, el('div', { class: 'num' }, String(r.failed || 0)), el('div', { class: 'label' }, '失敗')),
        el('div', { class: 'stat' }, el('div', { class: 'num' }, String(r.deleted || 0)), el('div', { class: 'label' }, '元削除')),
        el('div', { class: 'stat' }, el('div', { class: 'num' }, String((r.dicomCandidates || []).length)), el('div', { class: 'label' }, 'DICOM対象')),
      ),
      dicomLine,
      el('div', { class: 'actions between' },
        newSessionBtn,
        el('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } }, ...folderButtons),
      ),
    );

    const wrapper = el('div', null, root);
    if (ejectSection) wrapper.appendChild(ejectSection);
    mount.replaceChildren(wrapper);

    // 取り外し候補があれば自動でモーダル確認
    if (ejectables.length > 0 && !state._ejectConfirmShown) {
      state._ejectConfirmShown = true; // 1度だけ表示
      setTimeout(() => {
        const body = el('div', null,
          el('p', null, 'コピーが完了しました。'),
          el('p', null, '取り込み元のデバイスを安全に取り外しますか？'),
          el('ul', { style: { fontSize: '12px', color: 'var(--fg-mute)', paddingLeft: '20px' } },
            ...ejectables.map(v => el('li', { style: { fontFamily: 'SF Mono, Monaco, monospace' } }, v))),
        );
        U.modal({
          title: 'デバイスを取り外しますか？',
          body,
          okText: 'はい、取り外す',
          cancelText: '後で',
          onOk: async () => {
            // 順次 eject
            const results = [];
            for (const vol of ejectables) {
              const r = await window.App.ingest.ejectVolume(vol);
              results.push({ vol, ...r });
            }
            renderEjectList();
            // 結果モーダル
            const okCount = results.filter(x => x.ok || x.alreadyEjected).length;
            const failCount = results.length - okCount;
            const resultBody = el('div', null,
              failCount === 0
                ? el('p', { style: { fontSize: '16px', fontWeight: '600', color: 'var(--ok)' } }, '✓ 取り外しが完了しました。')
                : el('p', { style: { fontSize: '16px', fontWeight: '600', color: 'var(--warn)' } }, `${okCount} 件成功、${failCount} 件失敗`),
              el('p', null, '物理的にデバイスを抜き取ってください。'),
              el('ul', { style: { fontSize: '12px', paddingLeft: '20px' } },
                ...results.map(x => el('li', { style: { fontFamily: 'SF Mono, Monaco, monospace' } },
                  (x.ok || x.alreadyEjected ? '✓ ' : '✗ ') + x.vol + (x.error ? ' — ' + x.error : '')))),
            );
            U.modal({
              title: failCount === 0 ? '取り外せます' : '取り外し結果',
              body: resultBody,
              okText: 'OK',
              cancelText: '',
            });
          },
        });
      }, 400);
    }
  }

  return { render };
})();
