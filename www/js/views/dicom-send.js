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

    const setButtonsBusy = (busy) => {
      sendBtn.disabled = busy;
      skipBtn.disabled = busy;
      backBtn.disabled = busy;
      state.dicomSending = busy; // app.js の設定ボタン等、画面外からの遷移もこのフラグで抑止する
    };

    // ==== 送信コア（通常送信と再送キューの両方から使う）====
    // files: [{path, name}] / 返り値: { ok, sent, decodeFailed, sendFailed, firstError, total }
    async function runSend(files, patientArg, examArg) {
      const total = files.length;
      const batchCount = Math.ceil(total / BATCH_SIZE);
      logLine(`送信開始: ${total} 枚を ${batchCount} バッチ（最大 ${BATCH_SIZE} 枚/バッチ）に分割`, 'ok');

      let studyUID = null;
      let seriesUID = null;
      let totalSent = 0;
      let totalDecodeFailed = 0;
      let totalSendFailed = 0;
      let firstError = null;

      // 進捗は「1枚 = デコード0.5 + 送信0.5」の単一式で単調に増やす
      // （フェーズごとの別計算だとバッチ境界で逆戻りして見える）
      let decodedCount = 0;   // デコード処理済み（成功/失敗とも）
      let sendProcessed = 0;  // 送信処理済み（成功/失敗とも）
      const updateBar = () => {
        const p = ((decodedCount * 0.5 + sendProcessed * 0.5) / total) * 100;
        elProgress.firstElementChild.style.width = Math.min(100, p).toFixed(1) + '%';
      };

      for (let batchIdx = 0; batchIdx < batchCount; batchIdx++) {
        const batchStart = batchIdx * BATCH_SIZE;
        const batch = files.slice(batchStart, batchStart + BATCH_SIZE);

        // === デコードフェーズ ===
        const decodedBatch = [];
        for (let i = 0; i < batch.length; i++) {
          const c = batch[i];
          const overallIdx = batchStart + i;
          elStatus.textContent = `バッチ ${batchIdx + 1}/${batchCount}　デコード中 ${overallIdx + 1}/${total}`;
          elSubStatus.textContent = c.name;
          try {
            const dec = await window.Decode.decodeToRgb(c.path);
            decodedBatch.push(dec);
          } catch (e) {
            totalDecodeFailed++;
            logLine('✗ decode失敗: ' + c.name + ' — ' + (e?.message || e), 'err');
          }
          decodedCount = overallIdx + 1;
          updateBar();
          await yieldToUI();
        }

        if (decodedBatch.length === 0) {
          logLine(`バッチ ${batchIdx + 1} はデコード成功画像なし、スキップ`, 'warn');
          sendProcessed += 0; // デコード全滅バッチは送信対象なし
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

        sendProcessed += decodedBatch.length;
        updateBar();

        // メモリ解放: バッチを明示的に空に → GC が走りやすくなる
        decodedBatch.length = 0;
        await yieldToUI();
      }

      elProgress.firstElementChild.style.width = '100%';
      return {
        ok: totalSendFailed === 0 && totalDecodeFailed === 0 && totalSent > 0,
        sent: totalSent,
        decodeFailed: totalDecodeFailed,
        sendFailed: totalSendFailed,
        firstError,
        total,
      };
    }

    const asciiStrip = (s) => String(s || '').replace(/[^\x20-\x7E]/g, '');

    // 送信ロック: onclick の最初の同期区間で取得する。
    // 自動送信（render 直後）と手動クリック／二重クリックが await 窓で重なると、
    // 同じ候補に対して runSend が並走し、別 Study として PACS に重複登録されるため。
    let sendLocked = false;

    sendBtn.onclick = async () => {
      if (sendLocked) return;
      sendLocked = true;
      setButtonsBusy(true);
      try {
        await doSend();
      } finally {
        sendLocked = false;
      }
    };

    async function doSend() {
      const cfg = state.settings || await window.App.settings.get();
      if (!cfg.dicom.host) {
        U.modal({ title: '設定不備', body: 'DICOM接続先（Host）が未設定です。設定画面で入力してください。' });
        setButtonsBusy(false);
        return;
      }
      const selected = checkboxes
        .map((cb, i) => cb.checked ? candidates[i] : null)
        .filter(Boolean);
      if (selected.length === 0) {
        U.modal({ title: '対象なし', body: '送信する写真にチェックを入れてください。' });
        setButtonsBusy(false);
        return;
      }

      const studyDateIso = (state.patient.date || U.todayIso()) + 'T' + new Date().toTimeString().slice(0, 8);
      const patientArg = {
        id: asciiStrip(state.patient.id),
        name: asciiStrip(state.patient.nameRomaji),
      };
      const examArg = {
        datetime: studyDateIso,
        desc: asciiStrip(state.patient.procedure),
      };

      // 失敗キューへの登録は例外時にも必ず行う（登録自体の失敗はログに残すだけ）
      const recordFailure = async (error) => {
        try {
          await window.App.dicom.queueFailure({
            target: state.targetFolder,
            patient: state.patient,
            error: error || null,
          });
          logLine('失敗を記録しました（次回この画面を開いたとき再送できます）', 'warn');
        } catch (qe) {
          logLine('✗ 失敗記録の保存に失敗: ' + (qe?.message || qe), 'err');
        }
        refreshPending();
      };

      try {
        const r = await runSend(selected, patientArg, examArg);

        if (r.ok) {
          elStatus.textContent = `✓ 送信成功（${r.sent} / ${r.total} 枚）`;
          elSubStatus.textContent = '';
          logLine(`完了: ${r.sent} 枚送信成功`, 'ok');
        } else {
          elStatus.textContent = `送信完了（成功 ${r.sent} / 失敗 ${r.sendFailed} / 対象 ${r.total}）`;
          elSubStatus.textContent = r.firstError ? `初回エラー: ${r.firstError}` : '';
          if (r.sendFailed > 0) {
            logLine(`失敗: ${r.sendFailed} 枚 — 初回エラー: ${r.firstError || '不明'}`, 'err');
            await recordFailure(r.firstError);
          }
        }
        if (r.decodeFailed > 0) {
          logLine(`デコード失敗: ${r.decodeFailed} 枚`, 'warn');
        }
        state.dicomResult = { ok: r.ok, sent: r.sent, error: r.firstError };
      } catch (e) {
        // sendStudy / decode 等が例外で抜けた場合も、結果と失敗キューを必ず残す
        // （部分送信の可能性があるため、再送時の重複警告は再送モーダル側で表示される）
        const msg = e?.message || String(e);
        elStatus.textContent = '✗ 送信中にエラーが発生しました';
        elSubStatus.textContent = msg;
        logLine('✗ 送信中に例外: ' + msg, 'err');
        state.dicomResult = { ok: false, sent: 0, error: msg };
        await recordFailure(msg);
      } finally {
        setButtonsBusy(false);
        sendBtn.disabled = true;
        skipBtn.textContent = '完了 →';
        skipBtn.classList.remove('ghost');
        skipBtn.classList.add('primary');
      }
    }

    // ==== 過去の送信失敗（再送キュー）====
    // 以前は「キューに登録」しか実装されておらず、再送する手段が無かった。
    // ここで一覧表示し、フォルダ内の写真を新しい Study として再送するか、記録を削除できる。
    const pendingSection = el('div', null);
    async function refreshPending() {
      const r = await window.App.dicom.listPending().catch(() => null);
      const items = (r && r.ok && Array.isArray(r.items)) ? r.items : [];
      pendingSection.innerHTML = '';
      if (items.length === 0) return;

      const list = el('ul', { class: 'file-list' });
      for (const it of items) {
        const label = `${it.patientName || it.patient_name || '(名前なし)'} / ${it.procedure || '-'} / ${it.studyDate || it.study_date || '-'}`
          + `（失敗 ${(it.attempts || 0) + 1} 回目の記録）`;
        const folder = it.dstPath || it.dst_path || '';
        const resendBtn = el('button', { class: 'ghost' }, '再送...');
        const removeBtn = el('button', { class: 'ghost' }, '記録を削除');

        resendBtn.onclick = () => {
          U.modal({
            title: '失敗分を再送しますか？',
            body: el('div', null,
              el('p', null, '以下のフォルダ内の写真を、新しい Study として送信します：'),
              el('div', { class: 'preview' }, folder),
              el('p', { style: { fontSize: '12px', color: 'var(--warn, #b45309)' } },
                '⚠ 前回一部が送信済みだった場合、その写真は送信先に重複して登録されます。'),
            ),
            okText: '再送する',
            cancelText: 'キャンセル',
            onOk: async () => {
              // 通常送信が完了済みで sendBtn が意図的に無効なら、再送後もそれを維持する
              const sendBtnWasDisabled = sendBtn.disabled;
              setButtonsBusy(true);
              resendBtn.disabled = true;
              try {
                const scan = await window.App.ingest.scanSource({ sourcePath: folder });
                if (!scan.ok) {
                  logLine('✗ 再送: フォルダを読めません — ' + (scan.error || folder), 'err');
                  return;
                }
                const files = (scan.files || [])
                  .filter(f => window.Decode.isCanvasSupportedExt(f.ext))
                  .map(f => ({ path: f.path, name: f.relPath || f.path }));
                if (files.length === 0) {
                  logLine('✗ 再送: 送信可能な画像がフォルダにありません — ' + folder, 'err');
                  return;
                }
                const patientArg = { id: asciiStrip(it.patientId || it.patient_id), name: asciiStrip(it.patientName || it.patient_name) };
                const dateIso = (it.studyDate || it.study_date || U.todayIso()) + 'T' + new Date().toTimeString().slice(0, 8);
                const examArg = { datetime: dateIso, desc: asciiStrip(it.procedure) };
                const rr = await runSend(files, patientArg, examArg);
                if (rr.ok) {
                  logLine(`✓ 再送成功（${rr.sent} 枚）。記録をキューから削除します`, 'ok');
                  await window.App.dicom.removePending(it.id);
                } else {
                  logLine(`✗ 再送でも失敗（成功 ${rr.sent} / 失敗 ${rr.sendFailed + rr.decodeFailed}）。記録は残します`, 'err');
                }
              } finally {
                setButtonsBusy(false);
                sendBtn.disabled = sendBtnWasDisabled;
                resendBtn.disabled = false;
                refreshPending();
              }
            },
          });
        };

        removeBtn.onclick = () => {
          U.modal({
            title: '失敗記録を削除しますか？',
            body: '再送せずに記録だけを消します。写真自体は保存先フォルダに残っています。',
            okText: '削除',
            cancelText: 'キャンセル',
            onOk: async () => {
              await window.App.dicom.removePending(it.id);
              refreshPending();
            },
          });
        };

        list.appendChild(el('li', null,
          el('div', { style: { flex: '1', fontSize: '12px' } },
            el('div', null, label),
            el('div', { style: { fontSize: '11px', color: 'var(--fg-mute)', fontFamily: 'SF Mono, monospace' } }, folder),
          ),
          resendBtn, ' ', removeBtn,
        ));
      }
      pendingSection.appendChild(el('div', { class: 'banner warn', style: { marginTop: '8px' } },
        `過去に送信に失敗した記録が ${items.length} 件あります。再送するか、不要なら記録を削除してください。`));
      pendingSection.appendChild(list);
    }

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
      pendingSection,
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
    refreshPending();

    // コピー完了直後の遷移なら、確認ボタンを待たずに送信を自動開始する。
    // フラグは1回で消費し、「← 戻る」からの再表示や再送操作では自動実行しない。
    if (state.autoDicomSend) {
      state.autoDicomSend = false;
      logLine('コピー完了に続けて自動送信を開始します', 'ok');
      // render() を送信完了までブロックしない。
      // 送信中は画面内ボタン無効化＋ state.dicomSending で app.js 側の遷移も抑止する。
      // onclick 自身が try/catch/finally で完結するため、ここは想定外の保険のみ。
      sendBtn.onclick().catch((e) => {
        logLine('✗ 自動送信で想定外のエラー: ' + (e?.message || e), 'err');
        setButtonsBusy(false);
      });
    }
  }

  return { render };
})();
