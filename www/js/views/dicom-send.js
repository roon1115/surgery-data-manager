window.Views = window.Views || {};
window.Views.dicom = (function() {
  const { el } = window.U;

  async function render(state, mount) {
    const candidates = (state.ingestResult && state.ingestResult.dicomCandidates) || [];

    const elList = el('ul', { class: 'file-list' });
    const checkboxes = [];
    candidates.forEach((c, i) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = true;
      cb.dataset.index = String(i);
      checkboxes.push(cb);
      elList.appendChild(el('li', null,
        el('div', { class: 'checkbox', style: { flex: '1' } },
          cb,
          el('span', null, c.name),
        ),
      ));
    });

    const elProgress = el('div', { class: 'progress-bar' }, el('div', { class: 'fill', style: { width: '0%' } }));
    const elStatus = el('div', { style: { fontSize: '12px', color: 'var(--fg-mute)' } }, '待機中');
    const elLog = el('div', { class: 'log' });

    function logLine(text, cls) {
      const line = el('div', { class: cls || '' }, text);
      elLog.appendChild(line);
      elLog.scrollTop = elLog.scrollHeight;
    }

    const sendBtn = el('button', { class: 'primary' }, 'DICOM送信を実行');
    const skipBtn = el('button', { class: 'ghost', onclick: () => state.goto('done') }, '完了画面へ');
    const backBtn = el('button', { class: 'ghost', onclick: () => state.goto('ingest') }, '← 戻る');

    sendBtn.onclick = async () => {
      const cfg = state.settings || await window.App.settings.get();
      if (!cfg.dicom.host) {
        U.modal({ title: '設定不備', body: 'DICOM接続先（Host）が未設定です。設定画面で入力してください。' });
        return;
      }
      const selected = checkboxes
        .map((cb, i) => cb.checked ? candidates[i] : null)
        .filter(Boolean);
      if (selected.length === 0) {
        U.modal({ title: '対象なし', body: '送信する写真にチェックを入れてください。' });
        return;
      }

      sendBtn.disabled = true;
      skipBtn.disabled = true;
      backBtn.disabled = true;

      // レンダラ側で各画像をRGB decode → メインに渡す
      const decodedImages = [];
      const failures = [];
      for (let i = 0; i < selected.length; i++) {
        const c = selected[i];
        elStatus.textContent = `デコード中 ${i + 1} / ${selected.length}: ${c.name}`;
        try {
          const dec = await window.Decode.decodeToRgb(c.path);
          decodedImages.push(dec);
          logLine('✓ decode: ' + c.name, 'ok');
        } catch (e) {
          failures.push({ name: c.name, error: String(e?.message || e) });
          logLine('✗ decode失敗: ' + c.name + ' — ' + (e?.message || e), 'err');
        }
        elProgress.firstElementChild.style.width = (((i + 1) / selected.length) * 50).toFixed(1) + '%';
      }

      if (decodedImages.length === 0) {
        elStatus.textContent = 'デコード成功した画像がありません';
        sendBtn.disabled = false;
        skipBtn.disabled = false;
        backBtn.disabled = false;
        return;
      }

      // DICOM送信
      elStatus.textContent = `C-STORE 送信中 (${decodedImages.length} 枚)...`;
      const studyDateIso = (state.patient.date || U.todayIso()) + 'T' + new Date().toTimeString().slice(0, 8);
      const r = await window.App.dicom.sendStudy({
        patient: {
          id: state.patient.id.replace(/[^\x20-\x7E]/g, ''),
          name: state.patient.nameRomaji.replace(/[^\x20-\x7E]/g, ''),
        },
        exam: {
          datetime: studyDateIso,
          desc: state.patient.procedure.replace(/[^\x20-\x7E]/g, ''),
        },
        decodedImages,
      });

      elProgress.firstElementChild.style.width = '100%';
      if (r.ok) {
        elStatus.textContent = `✓ 送信成功（${r.sent} 枚）`;
        logLine('DICOM C-STORE 完了: ' + r.sent + ' 枚', 'ok');
      } else {
        elStatus.textContent = `送信失敗: ${r.error || ''}`;
        logLine('DICOM C-STORE 失敗: ' + (r.error || ''), 'err');
        // 失敗時は再送キューに積む
        await window.App.dicom.queueFailure({
          target: state.targetFolder,
          patient: state.patient,
        });
        logLine('再送キューに登録しました（設定画面から再送可能）', 'warn');
      }
      state.dicomResult = r;

      sendBtn.disabled = true;
      skipBtn.disabled = false;
      backBtn.disabled = false;
      skipBtn.textContent = '完了 →';
      skipBtn.classList.remove('ghost');
      skipBtn.classList.add('primary');
    };

    const cfg = state.settings || await window.App.settings.get();
    const dicomInfo = el('div', { class: 'banner ok' },
      `送信先: ${cfg.dicom.calledAet}@${cfg.dicom.host}:${cfg.dicom.port}（自局: ${cfg.dicom.callingAet}）`
    );

    const root = el('div', { class: 'card' },
      el('h2', null, 'DICOM 送信'),
      dicomInfo,
      el('div', { class: 'banner warn' },
        `PatientID = "${state.patient.id}"、PatientName = "${state.patient.nameRomaji}"（英数）として送信します。`
      ),
      el('h3', null, `送信候補（${candidates.length} 枚）`),
      elList,
      el('h3', null, '進捗'),
      elStatus,
      elProgress,
      el('h3', null, 'ログ'),
      elLog,
      el('div', { class: 'actions between' },
        backBtn,
        el('div', null, skipBtn, ' ', sendBtn),
      ),
    );
    mount.replaceChildren(root);
  }

  return { render };
})();
