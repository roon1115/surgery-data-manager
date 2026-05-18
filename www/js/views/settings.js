window.Views = window.Views || {};
window.Views.settings = (function() {
  const { el } = window.U;

  async function render(state, mount) {
    const cfg = await window.App.settings.get();
    state.settings = cfg;

    const elOutputRoot = el('input', { type: 'text', value: cfg.outputRoot || '', placeholder: '/Volumes/Stella_8TB/...' });
    const elBrowse = el('button', { class: 'ghost', onclick: async () => {
      const r = await window.App.settings.chooseOutputRoot();
      if (r.ok) {
        elOutputRoot.value = r.path;
      }
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

    // 5種別の保存先サブフォルダ名入力
    const tf = cfg.typeFolders || {};
    const elTfAnesthesia = el('input', { type: 'text', value: tf.anesthesia || '麻酔記録', placeholder: '麻酔記録' });
    const elTfSurgicalPhoto = el('input', { type: 'text', value: tf.surgicalPhoto || '手術写真', placeholder: '手術写真' });
    const elTfLaparoscope = el('input', { type: 'text', value: tf.laparoscope || '腹腔鏡', placeholder: '腹腔鏡' });
    const elTfBronchoscope = el('input', { type: 'text', value: tf.bronchoscope || '気管支鏡', placeholder: '気管支鏡' });
    const elTfEndoscope = el('input', { type: 'text', value: tf.endoscope || '内視鏡', placeholder: '内視鏡' });

    const elUpdateUrl = el('input', {
      type: 'text',
      value: cfg.updateUrl || '',
      placeholder: 'https://.../latest.json（DropboxやGitHub Releasesに置く）',
    });
    const updateStatus = el('span', { style: { marginLeft: '8px', color: 'var(--fg-mute)' } }, '');
    const updateCheckBtn = el('button', { class: 'ghost', onclick: async () => {
      updateStatus.textContent = '確認中...';
      updateStatus.style.color = 'var(--fg-mute)';
      // 保存してから確認
      await window.App.settings.save({ updateUrl: elUpdateUrl.value.trim() });
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
      // 入力中の値で疎通テスト
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
        updateUrl: elUpdateUrl.value.trim(),
        typeFolders: {
          anesthesia: elTfAnesthesia.value.trim() || '麻酔記録',
          surgicalPhoto: elTfSurgicalPhoto.value.trim() || '手術写真',
          laparoscope: elTfLaparoscope.value.trim() || '腹腔鏡',
          bronchoscope: elTfBronchoscope.value.trim() || '気管支鏡',
          endoscope: elTfEndoscope.value.trim() || '内視鏡',
        },
      };
      await window.App.settings.save(partial);
      state.settings = await window.App.settings.get();
      state.goto('patient');
    };

    const root = el('div', { class: 'card' },
      el('h2', null, '設定'),
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
      el('h3', null, '種別ごとの保存先サブフォルダ'),
      el('div', { style: { fontSize: '11px', color: 'var(--fg-mute)', marginBottom: '6px' } },
        '患者フォルダ配下に作成されるサブフォルダ名。空欄にすると既定値が使われます。'),
      el('div', { class: 'row' },
        el('label', { class: 'field' }, el('span', { class: 'label' }, '麻酔モニター記録'), elTfAnesthesia),
        el('label', { class: 'field' }, el('span', { class: 'label' }, '手術写真（DICOM送信対象）'), elTfSurgicalPhoto),
      ),
      el('div', { class: 'row' },
        el('label', { class: 'field' }, el('span', { class: 'label' }, '腹腔鏡'), elTfLaparoscope),
        el('label', { class: 'field' }, el('span', { class: 'label' }, '気管支鏡'), elTfBronchoscope),
        el('label', { class: 'field' }, el('span', { class: 'label' }, '内視鏡'), elTfEndoscope),
      ),

      el('h3', null, '自動アップデート'),
      el('label', { class: 'field' },
        el('span', { class: 'label' }, 'latest.json の配信URL（任意）'),
        elUpdateUrl,
        el('div', { style: { fontSize: '11px', color: 'var(--fg-mute)', marginTop: '2px' } },
          'Dropbox公開リンク、GitHub Releases、その他HTTP/HTTPSで公開可能なJSONファイルのURLを指定。設定すると起動時に新版を自動チェックします。'),
      ),
      el('div', { class: 'row', style: { alignItems: 'center' } },
        updateCheckBtn,
        updateStatus,
      ),
      el('div', { class: 'actions' },
        el('button', { class: 'primary', onclick: onSave }, '保存して次へ'),
      ),
    );

    mount.replaceChildren(root);
  }

  return { render };
})();
