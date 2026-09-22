window.Views = window.Views || {};
window.Views.dicom = (function() {
  const { el } = window.U;
  const Retry = window.DicomRetry;

  // 一度にデコード＆送信するファイル数。大きすぎるとメモリ枯渇でレンダラがクラッシュする。
  // 2048x2048 RGB = 約12MB/枚。20枚なら ~240MB を一時保持。
  const BATCH_SIZE = 20;

  async function render(state, mount) {
    const candidates = (state.ingestResult && state.ingestResult.dicomCandidates) || [];
    const patient = state.patient || {};

    // 再送専用モード（開始画面のバナーから直接開いた場合）。
    // 取り込みフローを通っていないので送信候補も患者情報も無い。ここで通常の送信 UI を
    // 出すと「対象なし」の送信ボタンや空の患者バナーが並んで誤操作の元になるため、
    // 失敗キューの再送だけに絞る。
    const standalone = !!state.dicomStandalone
      || (candidates.length === 0 && !patient.id && !patient.nameRomaji);

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
    const backBtn = el('button', { class: 'ghost', onclick: () => {
      // 再送専用モードから抜けるときはフラグを必ず落とす。残したままだと次の取り込みで
      // DICOM 送信画面が再送専用表示になり、通常送信ができなくなる。
      if (standalone) {
        state.dicomStandalone = false;
        state.goto('patient');
      } else {
        state.goto('ingest');
      }
    } }, '← 戻る');

    // 通常送信を一度実行したか（完了後は送信ボタンを無効化する）。
    // ただし未送信が残っている間は「失敗分を再送信」として有効のままにする。
    let sendDone = false;

    const setButtonsBusy = (busy) => {
      sendBtn.disabled = busy;
      skipBtn.disabled = busy;
      backBtn.disabled = busy;
      state.dicomSending = busy; // app.js の設定ボタン等、画面外からの遷移もこのフラグで抑止する
    };

    // 未送信が残っている限り送信ボタンは「失敗分を再送信（N 枚）」として押せる状態にする。
    // 失敗しても完了扱いで無効化すると、その画面から再送する手段が無くなる（v0.3.19 までの問題）。
    function applyRetryButtonState() {
      const retry = state.dicomRetry;
      const n = (retry && Array.isArray(retry.files)) ? retry.files.length : 0;
      if (n > 0) {
        sendBtn.textContent = `失敗分を再送信（${n} 枚）`;
        sendBtn.disabled = false;
      } else {
        sendBtn.textContent = 'DICOM送信を実行';
        sendBtn.disabled = sendDone;
      }
    }

    function markSendFinishedUi() {
      skipBtn.textContent = '完了 →';
      skipBtn.classList.remove('ghost');
      skipBtn.classList.add('primary');
    }

    // ==== 送信コア（通常送信・失敗分の再送・再送キューの3経路から使う）====
    // files: [{path, name, sopUID?, instanceNumber?}]
    //        sopUID / instanceNumber を持つファイル（= 一度送信を試みた画像）は
    //        その値をそのまま再利用する（再送で PACS に重複登録させないため）。
    // opts:  { studyUID, seriesUID, startInstanceNumber, sopUIDs }（再送時に同じ Study へ追加する）
    //        InstanceNumber は opts ではなく files[].instanceNumber で引き継ぐ。
    // 返り値: { ok, sent, decodeFailed, sendFailed, firstError, total,
    //          failedFiles:[{path,name,sopUID,instanceNumber,reason}],
    //          attemptedFiles:[{path,name,sopUID,instanceNumber}]（files と同順・同数。
    //            今回確定した識別子。成功分も含むので、記録更新に失敗して再送対象を
    //            縮められないときはこちらを state に残す）,
    //          studyUID, seriesUID, nextInstanceNumber }
    //        既存 InstanceNumber の重複を検出した場合は1枚も送らずに
    //        ok:false / sent:0 / failedFiles=全件（reason:'instance-number-conflict'）で戻る。
    async function runSend(files, patientArg, examArg, opts = {}) {
      const total = files.length;
      const batchCount = Math.ceil(total / BATCH_SIZE);
      logLine(`送信開始: ${total} 枚を ${batchCount} バッチ（最大 ${BATCH_SIZE} 枚/バッチ）に分割`, 'ok');

      let studyUID = opts.studyUID || null;
      let seriesUID = opts.seriesUID || null;
      let totalSent = 0;
      let totalDecodeFailed = 0;
      let totalSendFailed = 0;
      let firstError = null;

      // InstanceNumber はファイル単位で最初に割り当てた番号を固定する。
      // 再送のたびに振り直すと、同じ SOP Instance UID の画像が前回と違う番号で届き、
      // PACS 上の並び順が変わる／同一画像の判定を惑わせるため。
      // 新規ファイルだけ「採番済みの最大 + 1」のカーソルから採番する（送信成功数から
      // 計算すると、部分失敗したバッチの次で番号が衝突して別画像が同じ番号になる）。
      const assigned = Retry.assignInstanceNumbers(files, opts.startInstanceNumber);
      const instanceNumbers = assigned.instanceNumbers;
      const nextInstanceNumber = assigned.nextInstanceNumber;

      // 既存レコードの InstanceNumber が重複していたら1枚も送らずに中止する。
      // 同じ番号の別画像を同一 Series へ送ると PACS 上でどちらかが埋もれる／同一画像と
      // 誤判定され、「送ったのに見えない」欠落になる。どちらの番号が正しいかはここでは
      // 判断できないので、自動で振り直さず人の対処に委ねる。
      // ただし files は1枚も落とさず全件を失敗として返す（黙って未送信が消えるのを防ぐ）。
      const duplicates = assigned.duplicates || [];
      if (duplicates.length > 0) {
        const dupText = duplicates.join(', ');
        logLine(`✗ InstanceNumber の重複を検出したため送信を中止しました（重複した番号: ${dupText}）`, 'err');
        // 1枚も送っていないので進捗バーは 0% に戻す（前回送信の 100% が残ると送れたように見える）
        elProgress.firstElementChild.style.width = '0%';
        // 記録は「入力のまま」返す。ここで新しい SOP UID や番号を振ると、
        // 送っていない画像の識別子が書き換わってしまう。
        const conflictFiles = files.map((f, i) => ({
          path: f.path,
          name: f.name,
          sopUID: (opts.sopUIDs && opts.sopUIDs[i]) || (f && f.sopUID) || null,
          // 未採番のファイルはここでも採番しない（送っていない画像に番号を付けると、
          // 「送信を試みた番号」という記録の意味が崩れる）。
          instanceNumber: Number.isInteger(f && f.instanceNumber) && f.instanceNumber > 0 ? f.instanceNumber : null,
        }));
        return {
          ok: false,
          sent: 0,
          decodeFailed: 0,
          sendFailed: total,
          firstError: `InstanceNumber が重複しています（${dupText}）。同じ番号のまま送ると PACS 上で画像が欠落するため送信を中止しました。`,
          total,
          failedFiles: conflictFiles.map((f) => ({ ...f, reason: 'instance-number-conflict' })),
          attemptedFiles: conflictFiles,
          studyUID,
          seriesUID,
          nextInstanceNumber,
        };
      }

      // SOP Instance UID をレンダラ側で先に採番しておく。
      // 再送で同じ UID を使えば PACS 側で重複登録にならない。sendStudy が例外で返らず
      // results が得られなかった場合でも「どの UID で送ろうとしたか」を失敗レコードに
      // 残せるよう、main 任せにせずここで確定させる（採番できなければ null で main に委ねる）。
      const sopUIDs = files.map((f, i) => (
        (opts.sopUIDs && opts.sopUIDs[i]) || (f && f.sopUID) || Retry.generateSopUID()
      ));

      const decodeFailedIdx = [];   // files 上の index
      const batchResults = [];      // [{ indices:[files上のindex], results:[main の results] }]

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
        const batchIndices = []; // decodedBatch の位置 → files 上の index（結果の突き合わせ用）
        for (let i = 0; i < batch.length; i++) {
          const c = batch[i];
          const overallIdx = batchStart + i;
          elStatus.textContent = `バッチ ${batchIdx + 1}/${batchCount}　デコード中 ${overallIdx + 1}/${total}`;
          elSubStatus.textContent = c.name;
          try {
            const dec = await window.Decode.decodeToRgb(c.path);
            decodedBatch.push(dec);
            batchIndices.push(overallIdx);
          } catch (e) {
            totalDecodeFailed++;
            decodeFailedIdx.push(overallIdx);
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

        let r;
        try {
          r = await window.App.dicom.sendStudy({
            patient: patientArg,
            exam: examArg,
            decodedImages: decodedBatch,
            studyUID,
            seriesUID,
            // instanceNumbers を優先して使わせる。startInstanceNumber はそれが
            // 無視された場合でも番号が巻き戻らないよう、このバッチ先頭の番号を渡す。
            startInstanceNumber: instanceNumbers[batchIndices[0]],
            instanceNumbers: batchIndices.map((idx) => instanceNumbers[idx]),
            sopUIDs: batchIndices.map((idx) => sopUIDs[idx] || null),
          });
        } catch (e) {
          // IPC 自体が落ちた場合でも、そのバッチだけを失敗として扱い残りの処理を続ける。
          // ここで throw すると他バッチの結果ごと失われ、未送信分が失敗キューに載らない。
          r = { ok: false, sent: 0, error: 'sendStudy例外: ' + (e?.message || e) };
        }

        // 初回送信で UID が確定するので保持
        if (!studyUID && r.studyUID) studyUID = r.studyUID;
        if (!seriesUID && r.seriesUID) seriesUID = r.seriesUID;

        batchResults.push({ indices: batchIndices, results: Array.isArray(r.results) ? r.results : [] });

        // 成功判定は main の ok に依存せず「送信数 == バッチ枚数」で行う。
        // 部分成功（10枚中1枚だけ成功）を成功扱いにすると、残りが失敗キューに載らず
        // 台帳上も回復不能な欠落になる。
        const sentInBatch = Math.min(decodedBatch.length, Math.max(0, r.sent || 0));
        const failed = decodedBatch.length - sentInBatch;
        totalSent += sentInBatch;
        if (r.ok && failed === 0) {
          logLine(`✓ バッチ ${batchIdx + 1}: ${sentInBatch} 枚送信成功（累計 ${totalSent}/${total}）`, 'ok');
        } else {
          totalSendFailed += failed;
          if (!firstError) firstError = r.error || `送信数不一致 (${sentInBatch}/${decodedBatch.length})`;
          logLine(`✗ バッチ ${batchIdx + 1}: ${failed} 枚失敗（成功 ${sentInBatch}）— ${r.error || '不明'}`, 'err');
        }

        sendProcessed += decodedBatch.length;
        updateBar();

        // メモリ解放: バッチを明示的に空に → GC が走りやすくなる
        decodedBatch.length = 0;
        await yieldToUI();
      }

      elProgress.firstElementChild.style.width = '100%';

      // 今回の送信で各ファイルに確定した識別子（SOP UID / InstanceNumber）。
      // 失敗分だけでなく呼出側にも返す。記録更新に失敗して成功済みを再送対象に残すとき、
      // ここで採番した値を引き継がないと次回別の UID・番号で送られ、PACS に重複登録される。
      // 値は main が返した results（= 実際に送信に使われた値）を最優先する。
      // レンダラ側で採番できず null を渡した場合は main が採番しているため、
      // レンダラの null をそのまま記録すると再送で別 UID になり重複登録の原因になる。
      const attemptedFiles = Retry.buildAttemptedFiles(files, sopUIDs, instanceNumbers, batchResults);

      // 「成功が確認できた画像以外」を全て未送信として拾う（応答が無かった画像も含む）。
      // 送信済み判定を甘くすると未送信が黙って消えるため、判定は collectFailures 側に一本化する。
      const failedFiles = Retry.collectFailures(
        attemptedFiles,
        decodeFailedIdx,
        batchResults,
      );

      return {
        ok: failedFiles.length === 0 && totalSent > 0,
        sent: totalSent,
        decodeFailed: totalDecodeFailed,
        sendFailed: totalSendFailed,
        firstError,
        total,
        failedFiles,
        attemptedFiles,
        studyUID,
        seriesUID,
        // 新規採番後のカーソル（= 採番済みの最大 + 1）。次の送信はここから採番する。
        nextInstanceNumber,
      };
    }

    const asciiStrip = (s) => String(s || '').replace(/[^\x20-\x7E]/g, '');

    // 送信ロック: onclick の最初の同期区間で取得する。
    // 自動送信（render 直後）と手動クリック／二重クリックが await 窓で重なると、
    // 同じ候補に対して runSend が並走し、別 Study として PACS に重複登録されるため。
    // 再送（失敗分・キュー行）も同じロックを共有する。
    let sendLocked = false;

    // ボタンの押下は「未送信が残っていれば再送、無ければ通常送信」。
    // 自動送信は startSend を直接呼ぶ（再送に化けて新しい候補が送られないのを防ぐ）。
    sendBtn.onclick = async () => {
      const retry = state.dicomRetry;
      if (retry && Array.isArray(retry.files) && retry.files.length > 0) await startRetry();
      else await startSend();
    };

    async function startSend() {
      if (sendLocked) return;
      sendLocked = true;
      setButtonsBusy(true);
      try {
        await doSend();
      } finally {
        sendLocked = false;
      }
    }

    // 失敗モーダルの「失敗分を再送信」から呼ぶ。ボタン経由と同じロックを取る。
    async function startRetry() {
      if (sendLocked) return;
      const retry = state.dicomRetry;
      if (!retry || !Array.isArray(retry.files) || retry.files.length === 0) return;
      sendLocked = true;
      setButtonsBusy(true);
      try {
        await doRetry(retry);
      } finally {
        sendLocked = false;
      }
    }

    // 失敗キューへの登録は例外時にも必ず行う（登録自体の失敗はログに残すだけ）。
    // 登録するフォルダは「手術写真」の保存先に固定する。state.targetFolder は表示用の
    // 代表（最初の種別）で、複数種別の取り込みでは麻酔記録などのフォルダを指し得る。
    // それを登録すると再送時に無関係な画像を患者情報付きで PACS へ送ってしまう。
    const recordFailure = async (error, info = {}) => {
      const target = (state.targets && state.targets.surgicalPhoto) || null;
      if (!target) {
        logLine('✗ 失敗を記録できません: 手術写真の保存先フォルダが不明です（再送は手動で行ってください）', 'err');
        return null;
      }
      let queued = null;
      try {
        const q = await window.App.dicom.queueFailure({
          target,
          patient: state.patient,
          error: error || null,
          // ファイル単位で残すことで、再送時に「未送信分だけ・同じ Study」に送れる
          files: info.files,
          studyUID: info.studyUID,
          seriesUID: info.seriesUID,
          nextInstanceNumber: info.nextInstanceNumber,
          sentCount: info.sentCount,
          totalCount: info.totalCount,
        });
        if (q && q.ok) {
          queued = q;
          logLine('失敗を記録しました（この画面や開始画面のバナーから再送できます）', 'warn');
        } else {
          logLine('✗ 失敗記録の保存に失敗: ' + (q?.error || '不明'), 'err');
        }
      } catch (qe) {
        logLine('✗ 失敗記録の保存に失敗: ' + (qe?.message || qe), 'err');
      }
      refreshPending();
      return queued;
    };

    async function doSend() {
      const cfg = state.settings || await window.App.settings.get();
      if (!cfg.dicom.host) {
        U.modal({ title: '設定不備', body: 'DICOM接続先（Host）が未設定です。設定画面で入力してください。' });
        setButtonsBusy(false);
        applyRetryButtonState();
        return;
      }
      const selected = checkboxes
        .map((cb, i) => cb.checked ? candidates[i] : null)
        .filter(Boolean);
      if (selected.length === 0) {
        U.modal({ title: '対象なし', body: '送信する写真にチェックを入れてください。' });
        setButtonsBusy(false);
        applyRetryButtonState();
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

      try {
        const r = await runSend(selected, patientArg, examArg);
        const failedFiles = r.failedFiles || [];

        if (r.ok) {
          elStatus.textContent = `✓ 送信成功（${r.sent} / ${r.total} 枚）`;
          elSubStatus.textContent = '';
          logLine(`完了: ${r.sent} 枚送信成功`, 'ok');
          state.dicomRetry = null;
        } else {
          // 失敗数はデコード失敗も含める（デコード失敗＝その画像は PACS に届いていない）
          const totalFailed = failedFiles.length || ((r.sendFailed || 0) + (r.decodeFailed || 0));
          const reason = r.firstError || (r.decodeFailed > 0 ? `デコード失敗 ${r.decodeFailed} 枚` : '不明');
          elStatus.textContent = `送信完了（成功 ${r.sent} / 失敗 ${totalFailed} / 対象 ${r.total}）`;
          elSubStatus.textContent = `エラー: ${reason}`;
          if (r.sendFailed > 0) {
            logLine(`送信失敗: ${r.sendFailed} 枚 — 初回エラー: ${r.firstError || '不明'}`, 'err');
          }
          if (r.decodeFailed > 0) {
            logLine(`デコード失敗: ${r.decodeFailed} 枚（PACS には届いていません）`, 'err');
          }
          // 送信失敗・デコード失敗のどちらでも、未送信画像が残る限り必ず失敗キューに記録する
          // （ログだけでは画面を離れた時点で追跡不能になり、永続的な欠落になる）
          const queued = await recordFailure(reason, {
            files: failedFiles,
            studyUID: r.studyUID,
            seriesUID: r.seriesUID,
            nextInstanceNumber: r.nextInstanceNumber,
            sentCount: Math.max(0, r.total - failedFiles.length),
            totalCount: r.total,
          });

          // 失敗分の再送に必要な情報を state に持つ（完了画面へ移動して戻っても復元できる）
          state.dicomRetry = failedFiles.length > 0 ? {
            files: failedFiles,
            studyUID: r.studyUID,
            seriesUID: r.seriesUID,
            nextInstanceNumber: r.nextInstanceNumber,
            patientArg,
            examArg,
            queueId: (queued && queued.id != null) ? queued.id : null,
            totalCount: r.total,
          } : null;

          // 自動送信では利用者が画面を見ていないことが多いため、失敗はモーダルで必ず知らせる
          const canRetry = failedFiles.length > 0;
          U.modal({
            title: 'DICOM送信に失敗した画像があります',
            body: el('div', null,
              el('p', null, `成功 ${r.sent} 枚 / 失敗 ${totalFailed} 枚（対象 ${r.total} 枚）`),
              el('p', { style: { fontSize: '12px' } }, `理由: ${reason}`),
              el('p', { style: { fontSize: '12px', color: 'var(--fg-mute)' } },
                canRetry
                  ? '失敗分は記録済みです。「失敗分を再送信」で、失敗した写真だけを同じ Study に送り直せます（送信済み分と重複しません）。あとで送る場合はこの画面の送信ボタン、または開始画面のバナーから再送できます。'
                  : '失敗分は記録済みです。この画面の再送キューから送り直せます。ネットワークが遅い場合は時間をおいて再送してください。'),
            ),
            okText: canRetry ? '失敗分を再送信' : 'OK',
            cancelText: canRetry ? 'あとで再送する' : '',
            onOk: canRetry ? () => {
              startRetry().catch((e) => {
                logLine('✗ 再送で想定外のエラー: ' + (e?.message || e), 'err');
                setButtonsBusy(false);
                applyRetryButtonState();
              });
            } : undefined,
          });
        }
        state.dicomResult = {
          ok: r.ok,
          sent: r.sent,
          failed: (r.failedFiles || []).length,
          error: r.ok ? null : (r.firstError || (r.decodeFailed > 0 ? `デコード失敗 ${r.decodeFailed} 枚` : null)),
        };
      } catch (e) {
        // sendStudy / decode 等が例外で抜けた場合も、結果と失敗キューを必ず残す
        // （ファイル単位の情報が取れないので、フォルダ単位の記録になる）
        const msg = e?.message || String(e);
        elStatus.textContent = '✗ 送信中にエラーが発生しました';
        elSubStatus.textContent = msg;
        logLine('✗ 送信中に例外: ' + msg, 'err');
        state.dicomResult = { ok: false, sent: 0, error: msg };
        await recordFailure(msg);
      } finally {
        sendDone = true;
        setButtonsBusy(false);
        applyRetryButtonState();
        markSendFinishedUi();
      }
    }

    // 失敗分だけを「同じ Study / Series / SOP Instance UID」で送り直す。
    // SOP Instance UID を再利用するので、応答が返る前に打ち切った画像が実は PACS に
    // 保存済みだったとしても二重登録にならない。
    async function doRetry(retry) {
      const files = Array.isArray(retry.files) ? retry.files.slice() : [];
      if (files.length === 0) {
        setButtonsBusy(false);
        applyRetryButtonState();
        return;
      }
      const totalCount = Number.isInteger(retry.totalCount) ? retry.totalCount : files.length;
      const prevSent = (state.dicomResult && state.dicomResult.sent) || 0;
      elStatus.textContent = `失敗分を再送信中（${files.length} 枚）...`;
      elSubStatus.textContent = '';
      logLine(`再送開始: 未送信 ${files.length} 枚を同じ Study に追加送信します（送信済み分と重複しません）`, 'warn');

      try {
        const rr = await runSend(files, retry.patientArg, retry.examArg, {
          studyUID: retry.studyUID,
          seriesUID: retry.seriesUID,
          startInstanceNumber: retry.nextInstanceNumber,
          sopUIDs: files.map((f) => f.sopUID || null),
        });
        const remaining = rr.failedFiles || [];

        if (remaining.length === 0) {
          elStatus.textContent = `✓ 再送成功（${rr.sent} 枚）`;
          elSubStatus.textContent = '';
          logLine(`✓ 再送成功: ${rr.sent} 枚を同じ Study に送信しました`, 'ok');
          if (retry.queueId != null) {
            const rem = await window.App.dicom.removePending(retry.queueId).catch(() => null);
            if (rem && rem.ok) logLine('失敗キューの記録を削除しました', 'ok');
            else logLine('✗ 失敗キューの記録を削除できませんでした（記録が残るだけで、再送しても重複はしません）', 'warn');
          }
          state.dicomRetry = null;
          state.dicomResult = { ok: true, sent: prevSent + rr.sent, failed: 0, error: null };
        } else {
          const reason = rr.firstError || (rr.decodeFailed > 0 ? `デコード失敗 ${rr.decodeFailed} 枚` : '不明');
          elStatus.textContent = `再送完了（成功 ${rr.sent} / 未送信 ${remaining.length}）`;
          elSubStatus.textContent = `エラー: ${reason}`;
          logLine(`✗ 再送でも失敗（成功 ${rr.sent} / 未送信 ${remaining.length}）— ${reason}`, 'err');

          // 残りの未送信分でキューの記録を縮める（成功した分を再送対象に残さない）
          const next = {
            files: remaining,
            studyUID: rr.studyUID || retry.studyUID,
            seriesUID: rr.seriesUID || retry.seriesUID,
            nextInstanceNumber: rr.nextInstanceNumber,
            patientArg: retry.patientArg,
            examArg: retry.examArg,
            queueId: retry.queueId,
            totalCount,
          };
          // 永続化（キュー更新 / 新規記録）の成功をコミット点にする。
          // 記録を縮められていないのに state だけ縮めると、画面を離れた時点で
          // 「未送信はもっとあった」という事実が消え、未送信が黙って消える。
          // 記録できたかどうかは ok で判断する（id が返らない保存経路でも、
          // 記録自体は成功しているのに「失敗」と誤判定しないため）。
          const queued = await persistRetryFailure(next, reason);
          if (queued && queued.ok !== false) {
            if (queued.id != null) next.queueId = queued.id;
            state.dicomRetry = next;
          } else {
            // 記録できなかったので再送対象は元のまま（今回成功した分も残す）。
            // SOP Instance UID も InstanceNumber も再利用するため、成功済みを
            // もう一度送っても PACS 側では重複登録にならない。多めに再送する方が安全。
            // 残す files は今回確定した識別子つきのもの（attemptedFiles）にする。
            // 元の files（UID を持たない旧レコード由来など）をそのまま残すと、
            // 次の再送で別 UID が採番されて本当の重複登録になる。
            state.dicomRetry = {
              ...next,
              files: Array.isArray(rr.attemptedFiles) && rr.attemptedFiles.length === files.length
                ? rr.attemptedFiles : files,
              totalCount,
            };
            logLine('⚠ 記録の更新に失敗したため、次の再送では成功済みの写真も再送されます（同じ UID で送るので重複登録はされません）', 'err');
          }
          state.dicomResult = {
            ok: false,
            sent: prevSent + rr.sent,
            // 次に再送される枚数を持つ（記録更新に失敗したときは成功済みも含む）
            failed: state.dicomRetry.files.length,
            error: reason,
          };
        }
      } catch (e) {
        // 例外時も再送情報は保持したまま（未送信を黙って捨てない）
        const msg = e?.message || String(e);
        elStatus.textContent = '✗ 再送中にエラーが発生しました';
        elSubStatus.textContent = msg;
        logLine('✗ 再送中に例外: ' + msg, 'err');
      } finally {
        setButtonsBusy(false);
        applyRetryButtonState();
        markSendFinishedUi();
        refreshPending();
      }
    }

    // 再送でも失敗したときのキュー更新。
    // 既存レコードがあれば files を縮める（updatePending）。まだ無ければ新規に記録する。
    async function persistRetryFailure(next, reason) {
      const sentCount = Math.max(0, next.totalCount - next.files.length);
      if (next.queueId == null) {
        return await recordFailure(reason, {
          files: next.files,
          studyUID: next.studyUID,
          seriesUID: next.seriesUID,
          nextInstanceNumber: next.nextInstanceNumber,
          sentCount,
          totalCount: next.totalCount,
        });
      }
      try {
        // attempts（失敗回数の表示）はキュー側の現在値から進める
        const list = await window.App.dicom.listPending().catch(() => null);
        const cur = (list && list.ok && Array.isArray(list.items))
          ? list.items.find((it) => it.id === next.queueId) : null;
        const up = await window.App.dicom.updatePending({
          id: next.queueId,
          files: next.files,
          studyUID: next.studyUID,
          seriesUID: next.seriesUID,
          nextInstanceNumber: next.nextInstanceNumber,
          sentCount,
          totalCount: next.totalCount,
          attempts: ((cur && cur.attempts) || 0) + 1,
          lastError: reason || null,
        });
        if (!up || !up.ok) {
          logLine('✗ 失敗キューの更新に失敗: ' + (up?.error || '不明'), 'err');
          return null;
        }
        logLine(`失敗キューを更新しました（未送信 ${next.files.length} 枚）`, 'warn');
        return { ok: true, id: next.queueId };
      } catch (e) {
        logLine('✗ 失敗キューの更新に失敗: ' + (e?.message || e), 'err');
        return null;
      }
    }

    // フォルダを走査して「今も存在するファイルのパス集合」を返す。
    // 走査できない場合（NAS 未マウント等）は null を返して存在チェックを諦める。
    // 「消えた」と誤判定して記録から落とすより、送信を試みて失敗を記録する方が安全なため。
    async function listExistingPaths(folder) {
      if (!folder) return null;
      try {
        const scan = await window.App.ingest.scanSource({ sourcePath: folder });
        if (!scan || !scan.ok || !Array.isArray(scan.files)) return null;
        return new Set(scan.files.map((f) => f.path));
      } catch (_) {
        return null;
      }
    }

    // ==== 過去の送信失敗（再送キュー）====
    // ファイル単位の記録がある場合は「未送信分だけを同じ Study に追加送信」する。
    // 旧レコード（files が無い）は従来どおりフォルダ全体を新しい Study として送る。
    const pendingSection = el('div', null);
    async function refreshPending() {
      const r = await window.App.dicom.listPending().catch(() => null);
      const items = (r && r.ok && Array.isArray(r.items)) ? r.items : [];
      pendingSection.innerHTML = '';
      if (items.length === 0) {
        if (standalone) {
          pendingSection.appendChild(el('div', { class: 'banner ok' },
            '未送信の DICOM 記録はありません。'));
        }
        return;
      }

      const list = el('ul', { class: 'file-list' });
      for (const it of items) {
        const files = Array.isArray(it.files) ? it.files : [];
        const totalCount = Number.isInteger(it.totalCount) ? it.totalCount : null;
        const label = `${it.patientName || it.patient_name || '(名前なし)'} / ${it.procedure || '-'} / ${it.studyDate || it.study_date || '-'}`
          + `（失敗 ${(it.attempts || 0) + 1} 回目の記録）`;
        const folder = it.dstPath || it.dst_path || '';
        const lastError = it.lastError || it.last_error || '';
        const detail = files.length > 0
          ? `未送信 ${files.length} 枚 / 対象 ${totalCount != null ? totalCount : files.length} 枚`
          : 'ファイル単位の記録なし（フォルダ全体を新しい Study として送ります）';
        const resendBtn = el('button', { class: 'ghost' }, '再送...');
        const removeBtn = el('button', { class: 'ghost' }, '記録を削除');

        // 再送の共通前処理/後処理。通常送信と同じロックを取り、並走による重複送信を防ぐ。
        const runQueueResend = async (job) => {
          if (sendLocked) return;
          sendLocked = true;
          setButtonsBusy(true);
          resendBtn.disabled = true;
          try {
            await job();
          } catch (e) {
            logLine('✗ 再送中に例外: ' + (e?.message || e), 'err');
          } finally {
            sendLocked = false;
            setButtonsBusy(false);
            applyRetryButtonState();
            resendBtn.disabled = false;
            refreshPending();
          }
        };

        const patientArg = {
          id: asciiStrip(it.patientId || it.patient_id),
          name: asciiStrip(it.patientName || it.patient_name),
        };
        const dateIso = (it.studyDate || it.study_date || U.todayIso()) + 'T' + new Date().toTimeString().slice(0, 8);
        const examArg = { datetime: dateIso, desc: asciiStrip(it.procedure) };

        // --- ファイル単位の記録がある場合: 未送信分だけを同じ Study に追加送信 ---
        const resendFiles = () => {
          U.modal({
            title: '失敗分を再送しますか？',
            body: el('div', null,
              el('p', null, `未送信の ${files.length} 枚を同じ Study に追加送信します（送信済み分と重複しません）。`),
              el('div', { class: 'preview' }, folder),
            ),
            okText: '再送する',
            cancelText: 'キャンセル',
            onOk: () => runQueueResend(async () => {
              // 記録時点のファイルが消えている場合がある（手動削除等）。送れないものは
              // ログに出したうえで記録に残す（黙って消さない）。
              const existing = await listExistingPaths(folder);
              let missing = [];
              let sendable = files;
              if (existing && files.some((f) => existing.has(f.path))) {
                sendable = files.filter((f) => existing.has(f.path));
                missing = files.filter((f) => !existing.has(f.path));
              } else if (existing) {
                // 1枚も一致しない＝フォルダが移動した等の可能性。存在判定は信用せず送信を試みる
                logLine('再送: 記録したファイルがフォルダ内に見つかりませんでした。そのまま送信を試みます', 'warn');
              }
              for (const m of missing) {
                logLine('✗ 再送: ファイルが見つかりません — ' + (m.name || m.path), 'err');
              }
              if (sendable.length === 0) {
                logLine('✗ 再送: 送信できるファイルがありません（記録は残します）', 'err');
                return;
              }

              const rr = await runSend(sendable, patientArg, examArg, {
                studyUID: it.studyUID,
                seriesUID: it.seriesUID,
                startInstanceNumber: it.nextInstanceNumber,
                sopUIDs: sendable.map((f) => f.sopUID || null),
              });
              // 見つからなかったファイルも未送信として残す（和集合）
              const remaining = Retry.mergeQueueFiles(missing, rr.failedFiles || []);
              const total = totalCount != null ? totalCount : files.length;

              if (remaining.length === 0) {
                logLine(`✓ 再送成功（${rr.sent} 枚）。記録をキューから削除します`, 'ok');
                const rem = await window.App.dicom.removePending(it.id).catch(() => null);
                if (!rem || !rem.ok) {
                  logLine('✗ 失敗キューの記録を削除できませんでした（記録が残るだけで、再送しても重複はしません）', 'warn');
                }
                if (state.dicomRetry && state.dicomRetry.queueId === it.id) state.dicomRetry = null;
              } else {
                logLine(`✗ 再送でも失敗（成功 ${rr.sent} / 未送信 ${remaining.length}）。記録は残します`, 'err');
                const up = await window.App.dicom.updatePending({
                  id: it.id,
                  files: remaining,
                  studyUID: rr.studyUID || it.studyUID,
                  seriesUID: rr.seriesUID || it.seriesUID,
                  nextInstanceNumber: rr.nextInstanceNumber,
                  sentCount: Math.max(0, total - remaining.length),
                  totalCount: total,
                  attempts: (it.attempts || 0) + 1,
                  lastError: rr.firstError || '再送でも失敗',
                }).catch(() => null);
                // 記録を縮められたときだけ state も縮める（永続更新がコミット点）。
                // 失敗したまま state を縮めると、記録（元のまま）と画面上の未送信数が
                // 食い違い、成功していない写真まで未送信リストから消えることがある。
                if (!up || !up.ok) {
                  logLine('✗ 失敗キューの更新に失敗（記録は元のまま残ります）', 'err');
                  if (state.dicomRetry && state.dicomRetry.queueId === it.id) {
                    logLine('⚠ 記録の更新に失敗したため、次の再送では成功済みの写真も再送されます（同じ UID で送るので重複登録はされません）', 'err');
                  }
                } else if (state.dicomRetry && state.dicomRetry.queueId === it.id) {
                  state.dicomRetry = {
                    ...state.dicomRetry,
                    files: remaining,
                    studyUID: rr.studyUID || it.studyUID,
                    seriesUID: rr.seriesUID || it.seriesUID,
                    nextInstanceNumber: rr.nextInstanceNumber,
                    totalCount: total,
                  };
                }
              }
            }),
          });
        };

        // --- 旧レコード（files が無い）: フォルダ全体を新しい Study として送る ---
        const resendFolder = () => {
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
            onOk: () => runQueueResend(async () => {
              const scan = await window.App.ingest.scanSource({ sourcePath: folder });
              if (!scan.ok) {
                logLine('✗ 再送: フォルダを読めません — ' + (scan.error || folder), 'err');
                return;
              }
              const scanned = (scan.files || [])
                .filter(f => window.Decode.isCanvasSupportedExt(f.ext))
                .map(f => ({ path: f.path, name: f.relPath || f.path }));
              if (scanned.length === 0) {
                logLine('✗ 再送: 送信可能な画像がフォルダにありません — ' + folder, 'err');
                return;
              }
              const rr = await runSend(scanned, patientArg, examArg);
              if (rr.ok) {
                logLine(`✓ 再送成功（${rr.sent} 枚）。記録をキューから削除します`, 'ok');
                await window.App.dicom.removePending(it.id);
              } else {
                const remaining = rr.failedFiles || [];
                logLine(`✗ 再送でも失敗（成功 ${rr.sent} / 失敗 ${remaining.length}）。記録は残します`, 'err');
                // 旧レコードもここでファイル単位の記録に格上げする（次回は重複せず再送できる）
                const up = await window.App.dicom.updatePending({
                  id: it.id,
                  files: remaining,
                  studyUID: rr.studyUID,
                  seriesUID: rr.seriesUID,
                  nextInstanceNumber: rr.nextInstanceNumber,
                  sentCount: Math.max(0, scanned.length - remaining.length),
                  totalCount: scanned.length,
                  attempts: (it.attempts || 0) + 1,
                  lastError: rr.firstError || '再送でも失敗',
                }).catch(() => null);
                if (!up || !up.ok) logLine('✗ 失敗キューの更新に失敗（記録は元のまま残ります）', 'err');
              }
            }),
          });
        };

        resendBtn.onclick = () => { if (files.length > 0) resendFiles(); else resendFolder(); };

        removeBtn.onclick = () => {
          U.modal({
            title: '失敗記録を削除しますか？',
            body: '再送せずに記録だけを消します。写真自体は保存先フォルダに残っています。',
            okText: '削除',
            cancelText: 'キャンセル',
            onOk: async () => {
              await window.App.dicom.removePending(it.id);
              if (state.dicomRetry && state.dicomRetry.queueId === it.id) {
                state.dicomRetry = null;
                applyRetryButtonState();
              }
              refreshPending();
            },
          });
        };

        list.appendChild(el('li', null,
          el('div', { style: { flex: '1', fontSize: '12px' } },
            el('div', null, label),
            el('div', { style: { fontSize: '11px', color: 'var(--fg-mute)' } }, detail),
            lastError ? el('div', { style: { fontSize: '11px', color: 'var(--err)' } }, '最終エラー: ' + lastError) : null,
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

    const root = standalone
      ? el('div', { class: 'card' },
          el('h2', null, 'DICOM 再送'),
          dicomInfo,
          el('div', { class: 'banner warn' },
            '未送信として記録された写真だけを再送します（新しい取り込みは行いません）。'),
          pendingSection,
          el('h3', null, '進捗'),
          elStatus, elSubStatus,
          elProgress,
          el('h3', null, 'ログ'),
          elLog,
          el('div', { class: 'actions between' },
            backBtn,
            el('div', null),
          ),
        )
      : el('div', { class: 'card' },
          el('h2', null, 'DICOM 送信'),
          dicomInfo,
          el('div', { class: 'banner warn' },
            `PatientID = "${patient.id || ''}"、PatientName = "${patient.nameRomaji || ''}"（英数）として送信します。`
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

    // 完了画面などから戻ってきたとき、未送信が残っていれば再送ボタンを復元する
    // （失敗キューにも残っているが、同じ Study に追加できるのはこの経路だけ）
    if (!standalone && state.dicomRetry && Array.isArray(state.dicomRetry.files) && state.dicomRetry.files.length > 0) {
      sendDone = true;
      markSendFinishedUi();
      applyRetryButtonState();
      logLine(`前回の送信で ${state.dicomRetry.files.length} 枚が未送信です。「失敗分を再送信」で同じ Study に送り直せます。`, 'warn');
    }

    // コピー完了直後の遷移なら、確認ボタンを待たずに送信を自動開始する。
    // フラグは1回で消費し、「← 戻る」からの再表示や再送操作では自動実行しない。
    if (!standalone && state.autoDicomSend) {
      state.autoDicomSend = false;
      logLine('コピー完了に続けて自動送信を開始します', 'ok');
      // render() を送信完了までブロックしない。
      // 送信中は画面内ボタン無効化＋ state.dicomSending で app.js 側の遷移も抑止する。
      // onclick 自身が try/catch/finally で完結するため、ここは想定外の保険のみ。
      startSend().catch((e) => {
        logLine('✗ 自動送信で想定外のエラー: ' + (e?.message || e), 'err');
        setButtonsBusy(false);
        applyRetryButtonState();
      });
    }
  }

  return { render };
})();
