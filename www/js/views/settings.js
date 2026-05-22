window.Views = window.Views || {};
window.Views.settings = (function() {
  const { el } = window.U;

  async function render(state, mount) {
    const cfg = await window.App.settings.get();
    state.settings = cfg;

    const elOutputRoot = el('input', { type: 'text', value: cfg.outputRoot || '', placeholder: '/Volumes/Stella_8TB/...' });
    const elBrowse = el('button', { class: 'ghost', onclick: async () => {
      const r = await window.App.settings.chooseOutputRoot();
      if (r.ok) elOutputRoot.value = r.path;
    }}, 'フォルダを選択');

    const elAet = el('input', { type: 'text', value: cfg.dicom.callingAet || '', placeholder: 'SURGERY' });
    const elCalledAet = el('input', { type: 'text', value: cfg.dicom.calledAet || '', placeholder: 'STELLADICOM' });
    const elHost = el('input', { type: 'text', value: cfg.dicom.host || '', placeholder: 'stelladicom.local または IPアドレス' });
    const elPort = el('input', { type: 'number', value: cfg.dicom.port || 104, min: 1, max: 65535 });
    const elModality = el('input', { type: 'text', value: cfg.dicom.modality || 'OT', placeholder: 'OT' });
    const elTs = el('select', null,
      el('option', { value: '1.2.840.10008.1.2' }, 'Implicit VR Little Endian'),
      el('option', { value: '1.2.840.10008.1.2.1' }, 'Explicit VR Little Endian'),
    );
    elTs.value = cfg.dicom.transferSyntax || '1.2.840.10008.1.2';

    // 5種別の保存先フォルダ
    const tf = cfg.typeFolders || {};
    const makeTypeFolderRow = (typeKey, defaultValue) => {
      const input = el('input', {
        type: 'text',
        value: tf[typeKey] || '',
        placeholder: `絶対パス推奨（例: /Volumes/Stella_8TB/${defaultValue}）。空欄なら出力ルート/${defaultValue}`,
      });
      const browseBtn = el('button', { class: 'ghost', onclick: async () => {
        const r = await window.App.settings.chooseTypeFolder(typeKey);
        if (r.ok) input.value = r.path;
      }}, '選択...');
      return { input, browseBtn };
    };
    const rAnesthesia = makeTypeFolderRow('anesthesia', '麻酔記録');
    const rSurgicalPhoto = makeTypeFolderRow('surgicalPhoto', '手術写真');
    const rLaparoscope = makeTypeFolderRow('laparoscope', '腹腔鏡');
    const rBronchoscope = makeTypeFolderRow('bronchoscope', '気管支鏡');
    const rEndoscope = makeTypeFolderRow('endoscope', '内視鏡');

    const updateStatus = el('span', { style: { marginLeft: '8px', color: 'var(--fg-mute)' } }, '');
    const updateCheckBtn = el('button', { class: 'ghost', onclick: async () => {
      updateStatus.textContent = '確認中...';
      updateStatus.style.color = 'var(--fg-mute)';
      const r = await window.App.updater.check({ silent: false });
      if (!r.ok) {
        updateStatus.textContent = '✗ ' + (r.error || '失敗');
        updateStatus.style.color = 'var(--err)';
      } else if (r.hasUpdate) {
        updateStatus.textContent = `✓ 新版あり: ${r.latestVersion}（現在 ${r.currentVersion}）`;
        updateStatus.style.color = 'var(--accent)';
      } else {
        updateStatus.textContent = `✓ 最新（${r.currentVersion}）`;
        updateStatus.style.color = 'var(--ok)';
      }
    }}, '今すぐアップデートを確認');

    const echoStatus = el('span', { style: { marginLeft: '8px', color: 'var(--fg-mute)' } }, '');
    const echoBtn = el('button', { class: 'ghost', onclick: async () => {
      echoStatus.textContent = '通信中...';
      echoStatus.style.color = 'var(--fg-mute)';
      const r = await window.App.dicom.echo({
        callingAet: elAet.value.trim(),
        calledAet: elCalledAet.value.trim(),
        host: elHost.value.trim(),
        port: parseInt(elPort.value, 10),
      });
      if (r.ok) {
        echoStatus.textContent = '✓ 接続OK';
        echoStatus.style.color = 'var(--ok)';
      } else {
        echoStatus.textContent = '✗ ' + (r.error || '失敗');
        echoStatus.style.color = 'var(--err)';
      }
    }}, 'C-ECHO で疎通確認');

    const onSave = async () => {
      const partial = {
        outputRoot: elOutputRoot.value.trim(),
        dicom: {
          callingAet: elAet.value.trim(),
          calledAet: elCalledAet.value.trim(),
          host: elHost.value.trim(),
          port: parseInt(elPort.value, 10) || 104,
          modality: elModality.value.trim() || 'OT',
          transferSyntax: elTs.value,
        },
        typeFolders: {
          anesthesia: rAnesthesia.input.value.trim(),
          surgicalPhoto: rSurgicalPhoto.input.value.trim(),
          laparoscope: rLaparoscope.input.value.trim(),
          bronchoscope: rBronchoscope.input.value.trim(),
          endoscope: rEndoscope.input.value.trim(),
        },
      };
      await window.App.settings.save(partial);
      state.settings = await window.App.settings.get();
      state.goto('patient');
    };

    // 編集ロック対象の input/select 一覧（フォルダ選択ボタンや C-ECHO/アプデ確認は除外）
    const editableEls = [
      elOutputRoot, elBrowse,
      elAet, elCalledAet, elHost, elPort, elModality, elTs,
      rAnesthesia.input, rAnesthesia.browseBtn,
      rSurgicalPhoto.input, rSurgicalPhoto.browseBtn,
      rLaparoscope.input, rLaparoscope.browseBtn,
      rBronchoscope.input, rBronchoscope.browseBtn,
      rEndoscope.input, rEndoscope.browseBtn,
    ];

    // 既定はロック状態
    let unlocked = false;
    const saveBtn = el('button', { class: 'primary', onclick: onSave, disabled: true }, '保存して次へ');
    const skipBtn = el('button', { class: 'ghost', onclick: () => state.goto('patient') }, '変更せず次へ →');

    function applyLock() {
      for (const e of editableEls) {
        if (e.tagName === 'BUTTON') {
          e.disabled = !unlocked;
        } else {
          e.disabled = !unlocked;
          e.style.opacity = unlocked ? '' : '0.6';
        }
      }
      saveBtn.disabled = !unlocked;
      unlockBtn.textContent = unlocked ? '🔓 編集モード中（クリックでロック）' : '🔒 編集する...';
      unlockBtn.className = unlocked ? 'danger' : 'primary';
      lockBanner.className = unlocked ? 'banner warn' : 'banner';
      lockBanner.textContent = unlocked
        ? '⚠ 編集モード中です。各項目は変更可能になっています。'
        : '🔒 設定はロックされています。誤って変更されるのを防いでいます。変更が必要な場合は「編集する」を押してください。';
    }

    const unlockBtn = el('button', null, '');
    const lockBanner = el('div', null, '');
    unlockBtn.onclick = () => {
      if (!unlocked) {
        // ロック解除前に警告
        U.modal({
          title: '⚠ 設定を変更しますか？',
          body: el('div', null,
            el('p', null, '設定を変更すると、以下に影響します:'),
            el('ul', { style: { paddingLeft: '20px', fontSize: '13px', lineHeight: '1.6' } },
              el('li', null, 'データの保存先パスが変わる → 新規取込分は新しい場所に作られる'),
              el('li', null, 'DICOM 接続先が変わる → 別の PACS に送信される'),
              el('li', null, '取り込み履歴 (差分判定 / 過去患者呼び出し) は引き継がれる'),
            ),
            el('p', { style: { marginTop: '12px', fontWeight: '600' } }, '本当に編集モードを有効にしますか？'),
          ),
          okText: 'はい、編集する',
          cancelText: 'キャンセル',
          onOk: () => {
            unlocked = true;
            applyLock();
          },
        });
      } else {
        // すでに編集モード中ならロック（保存せずキャンセル）
        unlocked = false;
        applyLock();
      }
    };

    const root = el('div', { class: 'card' },
      el('h2', null, '設定'),
      lockBanner,
      el('div', { class: 'actions', style: { marginTop: 0, marginBottom: '12px', borderBottom: 'none', borderTop: 'none', position: 'static', padding: 0 } },
        unlockBtn,
      ),
      el('h3', null, '出力ルート（ネットワークHDD/NAS）'),
      el('div', { class: 'row' },
        el('div', { style: { flex: '4' } }, elOutputRoot),
        el('div', { style: { flex: '1' } }, elBrowse),
      ),
      el('div', { class: 'banner warn', style: { marginTop: '10px' } },
        'NASがマウントされていない場合は事前にFinderで接続してください。`/Volumes/` 以下のパスを指定します。'
      ),
      el('h3', null, 'DICOM 送信先（StellaDICOM 等）'),
      el('div', { class: 'row' },
        el('label', { class: 'field' }, el('span', { class: 'label' }, 'Calling AE Title（自局）'), elAet),
        el('label', { class: 'field' }, el('span', { class: 'label' }, 'Called AE Title（相手局）'), elCalledAet),
      ),
      el('div', { class: 'row' },
        el('label', { class: 'field', style: { flex: '3' } }, el('span', { class: 'label' }, 'Host'), elHost),
        el('label', { class: 'field', style: { flex: '1' } }, el('span', { class: 'label' }, 'Port'), elPort),
        el('label', { class: 'field', style: { flex: '1' } }, el('span', { class: 'label' }, 'Modality'), elModality),
      ),
      el('label', { class: 'field' },
        el('span', { class: 'label' }, 'Transfer Syntax'),
        elTs,
      ),
      el('div', { class: 'row', style: { alignItems: 'center' } },
        echoBtn,
        echoStatus,
      ),
      el('h3', null, '種別ごとの保存先フォルダ'),
      el('div', { style: { fontSize: '11px', color: 'var(--fg-mute)', marginBottom: '6px' } },
        '各種別のデータは指定フォルダ配下に「患者フォルダ」を作って収納されます（例: 手術写真/2026-05-22_P0001_モモ_去勢術/）。',
        el('br'),
        '絶対パス推奨。空欄や相対パスにすると「出力ルート」配下として解決されます。'),
      (function() {
        const makeRow = (label, row, hint) => el('label', { class: 'field' },
          el('span', { class: 'label' }, label),
          el('div', { class: 'row' },
            el('div', { style: { flex: '4' } }, row.input),
            el('div', { style: { flex: '1' } }, row.browseBtn),
          ),
          hint ? el('div', { style: { fontSize: '11px', color: 'var(--fg-mute)', marginTop: '2px' } }, hint) : null,
        );
        return el('div', null,
          makeRow('麻酔モニター記録', rAnesthesia),
          makeRow('手術写真（DICOM送信対象）', rSurgicalPhoto),
          makeRow('腹腔鏡', rLaparoscope),
          makeRow('気管支鏡', rBronchoscope),
          makeRow('内視鏡', rEndoscope),
        );
      })(),

      el('h3', null, '自動アップデート'),
      el('div', { style: { fontSize: '11px', color: 'var(--fg-mute)', marginBottom: '6px' } },
        '起動時に GitHub Releases から最新版を自動確認します。新版があれば通知ダイアログが表示されます。'),
      el('div', { class: 'row', style: { alignItems: 'center' } },
        updateCheckBtn,
        updateStatus,
      ),
      el('div', { class: 'actions between' },
        skipBtn,
        saveBtn,
      ),
    );

    mount.replaceChildren(root);
    applyLock(); // 初期化
  }

  return { render };
})();
