window.Views = window.Views || {};
window.Views.dicom = (function() {
  const { el } = window.U;

  // 一度にデコード＆送信するファイル数。大きすぎるとメモリ枯渇でレンダラがクラッシュする。
  // 2048x2048 RGB = 約12MB/枚。20枚なら ~240MB を一時保持。
  const BATCH_SIZE = 20;

  async function render(state, mount) {
    const candidates = (state.ingestResult && state.ingestResult.dicomCandidates) || [];

    const elList = el('ul', { class: 'file-list' });
    const checkboxes = [];

    // 一括選択/解除
    const allCb = el('input', { type: 'checkbox' });
    allCb.checked = true;
    allCb.addEventListener('change', () => {
      checkboxes.forEach(cb => { cb.checked = allCb.checked; });
    });

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
    const elSubStatus = el('div', { style: { fontSize: '11px', color: 'var(--fg-mute)', marginTop: '2px' } }, '');
    const elLog = el('div', { class: 'log' });

    function logLine(text, cls) {
      const line = el('div', { class: cls || '' }, text);
      elLog.appendChild(line);
      elLog.scrollTop = elLog.scrollHeight;
    }

    // GC/イベントループに譲るための yield ヘルパ
    const yieldToUI = () => new Promise(r => setTimeout(r, 0));

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

      const total = selected.length;
      const batchCount = Math.ceil(total / BATCH_SIZE);
      logLine(`送信開始: ${total} 枚を ${batchCount} バッチ（最大 ${BATCH_SIZE} 枚/バッチ）に分割`, 'ok');

      const studyDateIso = (state.patient.date || U.todayIso()) + 'T' + new Date().toTimeString().slice(0, 8);
      const patientArg = {
        id: state.patient.id.replace(/[^\x20-\x7E]/g, ''),
        name: state.patient.nameRomaji.replace(/[^\x20-\x7E]/g, ''),
      };
      const examArg = {
        datetime: studyDateIso,
        desc: state.patient.procedure.replace(/[^\x20-\x7E]/g, ''),
      };

      let studyUID = null;
      let seriesUID = null;
      let totalSent = 0;
      let totalDecodeFailed = 0;
      let totalSendFailed = 0;
      let firstError = null;

      for (let batchIdx = 0; batchIdx < batchCount; batchIdx++) {
        const batchStart = batchIdx * BATCH_SIZE;
        const batch = selected.slice(batchStart, batchStart + BATCH_SIZE);

        // === デコードフェーズ ===
        const decodedBatch = [];
        for (let i = 0; i < batch.length; i++) {
          const c = batch[i];
          const overallIdx = batchStart + i;
          elStatus.textContent = `バッチ ${batchIdx + 1}/${batchCount}　デコード中 ${overallIdx + 1}/${total}`;
          elSubStatus.textContent = c.name;
          // 進捗バー: デコードを 0〜50%、送信を 50〜100% としてバッチごとに加算
          const decodeProgress = (overallIdx + 1) / total * 50;
          elProgress.firstElementChild.style.width = decodeProgress.toFixed(1) + '%';
          try {
            const dec = await window.Decode.decodeToRgb(c.path);
            decodedBatch.push(dec);
          } catch (e) {
            totalDecodeFailed++;
            logLine('✗ decode失敗: ' + c.name + ' — ' + (e?.message || e), 'err');
          }
          await yieldToUI();
        }

        if (decodedBatch.length === 0) {
          logLine(`バッチ ${batchIdx + 1} はデコード成功画像なし、スキップ`, 'warn');
          continue;
        }

        // === 送信フェーズ ===
        elStatus.textContent = `バッチ ${batchIdx + 1}/${batchCount}　C-STORE 送信中（${decodedBatch.length} 枚）...`;
        elSubStatus.textContent = '';

        const r = await window.App.dicom.sendStudy({
          patient: patientArg,
          exam: examArg,
          decodedImages: decodedBatch,
          studyUID,
          seriesUID,
          startInstanceNumber: totalSent + 1,
        });

        // 初回送信で UID が確定するので保持
        if (!studyUID && r.studyUID) studyUID = r.studyUID;
        if (!seriesUID && r.seriesUID) seriesUID = r.seriesUID;

        if (r.ok) {
          totalSent += r.sent || 0;
          logLine(`✓ バッチ ${batchIdx + 1}: ${r.sent} 枚送信成功（累計 ${totalSent}/${total}）`, 'ok');
        } else {
          const failed = decodedBatch.length - (r.sent || 0);
          totalSent += r.sent || 0;
          totalSendFailed += failed;
          if (!firstError) firstError = r.error;
          logLine(`✗ バッチ ${batchIdx + 1}: ${failed} 枚失敗 — ${r.error || '不明'}`, 'err');
        }

        // 進捗バー更新: デコード50% + 送信進捗（残り50%）
        const sendProgress = 50 + ((batchIdx + 1) / batchCount) * 50;
        elProgress.firstElementChild.style.width = sendProgress.toFixed(1) + '%';

        // メモリ解放: バッチを明示的に空に → GC が走りやすくなる
        decodedBatch.length = 0;
        await yieldToUI();
      }

      elProgress.firstElementChild.style.width = '100%';
      const r = { ok: totalSendFailed === 0 && totalSent > 0, sent: totalSent, error: firstError };
      if (r.ok) {
        elStatus.textContent = `✓ 送信成功（${totalSent} / ${total} 枚）`;
        elSubStatus.textContent = '';
        logLine(`完了: ${totalSent} 枚送信成功`, 'ok');
      } else {
        elStatus.textContent = `送信完了（成功 ${totalSent} / 失敗 ${totalSendFailed} / 対象 ${total}）`;
        elSubStatus.textContent = firstError ? `初回エラー: ${firstError}` : '';
        logLine(`失敗: ${totalSendFailed} 枚 — 初回エラー: ${firstError || '不明'}`, 'err');
        if (totalSendFailed > 0) {
          await window.App.dicom.queueFailure({
            target: state.targetFolder,
            patient: state.patient,
          });
          logLine('失敗分を再送キューに登録しました', 'warn');
        }
      }
      if (totalDecodeFailed > 0) {
        logLine(`デコード失敗: ${totalDecodeFailed} 枚`, 'warn');
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
      el('div', { class: 'row', style: { alignItems: 'center', marginTop: '8px', marginBottom: '4px' } },
        el('h3', { style: { margin: 0, flex: 1 } }, `送信候補（${candidates.length} 枚）`),
        el('div', { class: 'checkbox', style: { fontSize: '12px', flex: 'none' } }, allCb, ' 一括選択'),
      ),
      el('div', { style: { maxHeight: '260px', overflow: 'auto' } }, elList),
      el('h3', null, '進捗'),
      elStatus, elSubStatus,
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
