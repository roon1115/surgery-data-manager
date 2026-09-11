window.Views = window.Views || {};
window.Views.source = (function() {
  const { el, formatBytes } = window.U;

  const ALL_TYPE_OPTIONS = [
    { key: 'anesthesia',     label: '麻酔モニター記録',  hint: 'CSV等' },
    { key: 'surgicalPhoto',  label: '手術写真',         hint: '写真→DICOM自動送信対象' },
    { key: 'laparoscope',    label: '腹腔鏡',           hint: '画像/動画' },
    { key: 'bronchoscope',   label: '気管支鏡',         hint: '画像/動画' },
    { key: 'endoscope',      label: '内視鏡',           hint: '画像/動画' },
  ];

  // 重複チェック結果1件をファイル1件へマージする。
  // 元データ削除の可否に効く選択状態を触るので、判定表を1か所に閉じてテストできるよう
  // 純関数として切り出してある（render のクロージャに埋めない）。
  //
  //   res.error あり           … 判定に関わる状態（sha256 / sha256Verified / selected /
  //                              autoDeselected / alreadyImported）を一切変更しない
  //   alreadyImported=true     … 手動操作されていなければ自動解除
  //   alreadyImported=false    … 手動操作されておらず、未決定(undefined) か
  //                              前回自動解除(autoDeselected) のときだけ選択に戻す
  //
  // 「ユーザーの明示操作を自動判定で上書きしない」が原則。手動でチェックした既取込ファイルが
  // 再チェックのたびに外れる／手動で外したファイルに autoDeselected が付いて後で勝手に
  // 復活する、の両方向を塞ぐ。
  //
  // 手動かどうかの判定は f.manualSelection（プレビューでの明示操作でだけ立つ）で行い、
  // autoDeselected は使わない。autoDeselected は「自動で外した」印であって
  // 「手動で触った」印ではないため、これで代用すると
  //   未取込 → 自動選択（autoDeselected=false）→ 再チェックで既取込に転じる
  // の経路が手動扱いになり、プレビューの表示（既取込は自動除外）と食い違ったまま
  // 取り込みへ再投入される（削除ON種別では元データ削除の対象に戻る）。
  function mergeCheckResult(f, res) {
    if (!f || !res) return;
    if (res.error) {
      // チェックできなかったファイル（stat 失敗・読み取りエラー等）。
      // 「重複ではなかった」と解釈して選択状態を書き換えると、前回自動除外された
      // ファイルが黙って再選択され、削除ON種別では元データ削除の対象に戻ってしまう。
      // sha256 / sha256Verified も上書きしない（前回のチェックで検証済みの sha を、
      // 転送エラー1回で失わないため）。
      f.checkError = res.error;
      return;
    }
    f.sha256 = res.sha256;
    // 中身を実際に読んで計算した sha だけ verified。stat 逆引きの推定ヒットは false のまま
    // 持ち回り、取り込み時に削除が絡む場合だけ main 側で実ハッシュに落としてもらう。
    f.sha256Verified = !!res.hashed;
    delete f.checkError;
    f.alreadyImported = !!res.alreadyImported;
    if (f.alreadyImported) {
      // 自動で選択解除したものには印を付け、再チェックで「重複ではなかった」と
      // 分かった場合に選択を復元できるようにする（推定ヒットが剥がれたケースで取りこぼさない）。
      // ユーザーの明示操作（f.manualSelection）だけは自動判定で上書きしない
      // （手動で選んだ既取込ファイルは選択のまま、手動で外したものは外れたまま）。
      if (!f.manualSelection) {
        f.selected = false;
        f.autoDeselected = true;
      }
    } else if (!f.manualSelection) {
      // 手動操作されていないファイルだけ自動で選択に戻す。
      // 「未決定 か 前回自動解除」の条件は残す（自動判定の外で false になった状態を
      // 勝手に true にしないため）。
      if (f.selected === undefined || f.autoDeselected) {
        f.selected = true;
        f.autoDeselected = false;
      }
    }
  }

  // 差分インポート（重複チェック）を切ったソースの1ファイル分の状態リセット。
  // 判定表（mergeCheckResult）と対になる副作用なので、同じく純関数として切り出してテストする。
  //   - 自動で外したものだけ選択に戻す（手動で外したファイルは尊重して触らない）
  //   - 前回チェックの判定（alreadyImported / checkError）は残さない
  //   - manualSelection も消す: フィルタを切った時点で「自動判定 vs 手動」の区別自体が
  //     無意味になる。残すと、フィルタを入れ直した次のチェックで、当時の一時的な手動操作が
  //     いつまでも自動解除を抑止し続ける（削除ON種別では元データ削除の対象に残る）。
  function resetDiffState(f) {
    if (!f) return;
    if (!f.manualSelection && f.autoDeselected) f.selected = true;
    f.autoDeselected = false;
    f.alreadyImported = false;
    delete f.checkError;
    delete f.manualSelection; // 参照している上の判定より後に消すこと
  }

  async function render(state, mount) {
    if (!state.sources) state.sources = []; // [{ path, name, files, summary, type, useHashDiff }]
    const cfg = state.settings || await window.App.settings.get();
    state.settings = cfg;
    const typeFolders = cfg.typeFolders || {};
    const enabledTypes = cfg.enabledTypes || {};
    // 設定で有効化された種別のみ
    const TYPE_OPTIONS = ALL_TYPE_OPTIONS.filter(opt => enabledTypes[opt.key] !== false);
    const defaultType = TYPE_OPTIONS.length > 0 ? TYPE_OPTIONS[0].key : '';

    const banner = el('div', { class: 'banner' },
      '接続されているデバイス（SDカード等）を選び、ソースごとに「種別」を1つ選んでください。'
      + ' 種別ごとの保存先（サブフォルダ）は設定画面で事前に決められます。'
      + ' 「手術写真」を選んだソースは、コピー後に DICOM サーバーへ自動送信できます。');

    const elList = el('div'); // ソース一覧表示

    const renderSources = () => {
      elList.innerHTML = '';
      if (state.sources.length === 0) {
        elList.appendChild(el('div', { class: 'banner warn' }, '取り込み元がまだ追加されていません。上のリストから追加してください。'));
        return;
      }
      state.sources.forEach((src, idx) => {
        const summary = src.summary || { photo: 0, video: 0, csv: 0, other: 0, totalBytes: 0 };

        // 種別ラジオ
        const elTypeSelect = el('select');
        TYPE_OPTIONS.forEach(opt => {
          const o = el('option', { value: opt.key }, opt.label);
          if (src.type === opt.key) o.selected = true;
          elTypeSelect.appendChild(o);
        });
        elTypeSelect.addEventListener('change', () => {
          src.type = elTypeSelect.value;
          renderSources(); // 再描画して送信先プレビューを更新
        });

        const subfolder = typeFolders[src.type] || '(未設定)';
        const isDicom = src.type === 'surgicalPhoto';

        const elIncremental = el('input', { type: 'checkbox' });
        elIncremental.checked = src.useHashDiff !== false;
        elIncremental.addEventListener('change', () => {
          src.useHashDiff = elIncremental.checked;
        });

        const removeBtn = el('button', { class: 'ghost', onclick: () => {
          state.sources.splice(idx, 1);
          renderSources();
        }}, '削除');

        const card = el('div', { class: 'card', style: { background: 'var(--bg)' } },
          el('div', { class: 'row', style: { alignItems: 'center' } },
            el('div', { style: { flex: '3' } },
              el('div', { style: { fontWeight: '600', fontSize: '13px' } }, src.name),
              el('div', { style: { fontSize: '11px', color: 'var(--fg-mute)' } }, src.path),
            ),
            el('div', { style: { flex: '1', textAlign: 'right' } }, removeBtn),
          ),
          el('div', { class: 'summary' },
            el('div', { class: 'stat' },
              el('div', { class: 'num' }, String(src.files?.length || 0)),
              el('div', { class: 'label' }, '総ファイル数'),
            ),
            el('div', { class: 'stat' },
              el('div', { class: 'num' }, String(summary.photo)),
              el('div', { class: 'label' }, '画像'),
            ),
            el('div', { class: 'stat' },
              el('div', { class: 'num' }, String(summary.video)),
              el('div', { class: 'label' }, '動画'),
            ),
            el('div', { class: 'stat' },
              el('div', { class: 'num' }, formatBytes(summary.totalBytes)),
              el('div', { class: 'label' }, '合計サイズ'),
            ),
          ),
          el('div', { class: 'row' },
            el('label', { class: 'field' },
              el('span', { class: 'label required' }, 'このソースの種別'),
              elTypeSelect,
              el('div', { style: { fontSize: '11px', color: 'var(--fg-mute)', marginTop: '2px' } },
                src.type ? `保存先: 患者フォルダ / ${subfolder} /` + (isDicom ? '   ＋DICOM送信候補' : '') : '⚠ 種別を選択してください'),
            ),
            el('label', { class: 'field' },
              el('span', { class: 'label' }, '差分インポート（前回以降のみ）'),
              el('div', { class: 'checkbox' }, elIncremental, ' SHA-256 で既取込ファイルを除外'),
            ),
          ),
        );
        elList.appendChild(card);
      });
    };

    const elVolumes = el('ul', { class: 'volume-list' });

    async function loadVolumes() {
      elVolumes.innerHTML = '';
      const r = await window.App.ingest.listVolumes();
      if (!r.ok) {
        elVolumes.appendChild(el('li', null, 'ボリュームの取得に失敗: ' + (r.error || '')));
        return;
      }
      // 設定で除外指定されているボリュームをフィルタ
      const excluded = new Set(cfg.excludedVolumes || []);
      const visibleVolumes = r.volumes.filter(v => !excluded.has(v.path));
      if (visibleVolumes.length === 0) {
        const hiddenCount = r.volumes.length - visibleVolumes.length;
        elVolumes.appendChild(el('li', null,
          hiddenCount > 0
            ? `検出されたボリュームはありますが、${hiddenCount}件が設定で除外されています。SDカード等を接続してから「再読み込み」を押してください。`
            : '検出されたボリュームはありません。SDカード等を接続してから「再読み込み」を押してください。'));
        return;
      }
      visibleVolumes.forEach(vol => {
        const item = el('li', null,
          el('div', { style: { flex: '1' } },
            el('div', { style: { fontWeight: '500' } }, vol.name),
            el('div', { style: { fontSize: '11px', color: 'var(--fg-mute)' } }, vol.path),
          ),
          el('button', { class: 'primary', onclick: () => addSource(vol.path, vol.name) }, '取り込み元に追加'),
        );
        elVolumes.appendChild(item);
      });
      // 除外件数を表示
      const hiddenCount = r.volumes.length - visibleVolumes.length;
      if (hiddenCount > 0) {
        elVolumes.appendChild(el('li', { style: { fontSize: '11px', color: 'var(--fg-mute)', fontStyle: 'italic' } },
          `（${hiddenCount} 件が設定で除外されています）`));
      }
    }

    async function addSource(srcPath, srcName) {
      const scan = await window.App.ingest.scanSource({ sourcePath: srcPath });
      if (!scan.ok) {
        U.modal({ title: 'スキャン失敗', body: scan.error || '' });
        return;
      }
      // 既存と重複しないよう確認
      if (state.sources.some(s => s.path === srcPath)) {
        U.modal({ title: '追加済み', body: 'このソースはすでに追加されています。' });
        return;
      }
      state.sources.push({
        path: srcPath,
        name: srcName,
        files: scan.files,
        summary: scan.summary,
        type: defaultType,  // 既定: 設定で有効な最初の種別（ユーザーは必要に応じて変更）
        useHashDiff: true,
      });
      renderSources();
      // 追加直後に取り込み元一覧へ視覚的フィードバック
      setTimeout(() => {
        const last = elList.lastElementChild;
        if (last) {
          last.style.transition = 'background 0.6s';
          last.style.background = 'rgba(56, 189, 248, 0.25)';
          last.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(() => { last.style.background = ''; }, 800);
        }
      }, 50);
    }

    const chooseBtn = el('button', { class: 'ghost', onclick: async () => {
      const r = await window.App.ingest.chooseSource();
      if (r.ok) {
        const name = r.path.split('/').filter(Boolean).pop() || r.path;
        await addSource(r.path, name);
      }
    }}, 'フォルダを手動で選択...');

    const reloadBtn = el('button', { class: 'ghost', onclick: loadVolumes }, '再読み込み');

    // 重複チェック → プレビュー遷移（種別確認ポップアップで「OK」後に呼ばれる）
    const proceedToCheck = async () => {
      // 差分インポート有効なソースは事前ハッシュチェックして重複ファイルにフラグ
      // → preview で既定除外 → 不要なプレビュー操作を省く
      const filesToCheck = [];
      const ownerLookup = []; // [{srcIdx, fIdx}] 並び
      // 前回チェックの残り香をプレビューへ持ち越さない（この実行の結果で上書きする）
      state.lastCheckErrorCount = 0;
      state.sources.forEach((src, srcIdx) => {
        if (src.useHashDiff === false) {
          // 差分インポートを切ったソースは、前回チェックで付いた判定を残さない。
          // 残すと「重複フィルタを切ったのに、前回自動除外されたファイルが
          // 選択解除・非表示のまま」になり、ユーザーの指示と画面が食い違う。
          src.files.forEach(resetDiffState);
          return;
        }
        src.files.forEach((f, fIdx) => {
          // main が使うのは path（対象の指定）と size（進捗バーの totalBytes）だけ。
          // sha256 / sha256Verified / mtime は main 側で無視される（判定は main 自身の
          // 台帳 checkLedger と自前の stat のみを根拠にする）ため送らない。
          // 元データ削除の可否がレンダラの申告で変わることはない。
          filesToCheck.push({ path: f.path, size: f.size });
          ownerLookup.push({ srcIdx, fIdx });
        });
      });

      if (filesToCheck.length === 0) {
        state.goto('preview');
        return;
      }

      // 進捗モーダル（キャンセル可能）
      const progressLabel = el('div', { style: { fontSize: '13px', marginBottom: '6px' } }, '重複ファイルをチェック中...');
      const progressDetail = el('div', { style: { fontSize: '12px', color: 'var(--fg-mute)' } }, `0 / ${filesToCheck.length}`);
      const progressName = el('div', { style: { fontSize: '12px', color: 'var(--fg-mute)', marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, '');
      const progressBar = el('div', { class: 'progress-bar', style: { marginTop: '8px' } },
        el('div', { class: 'fill', style: { width: '0%' } }));
      const cancelCheckBtn = el('button', { class: 'ghost', style: { marginTop: '10px' } }, 'キャンセル');
      cancelCheckBtn.onclick = async () => {
        cancelCheckBtn.disabled = true;
        cancelCheckBtn.textContent = '中断中...';
        await window.App.ingest.cancelCheck();
      };
      const m = document.getElementById('modal');
      const content = document.getElementById('modal-content');
      const okBtn = document.getElementById('modal-ok');
      const cancelBtn = document.getElementById('modal-cancel');
      content.innerHTML = '';
      content.appendChild(el('h3', null, '前処理'));
      content.appendChild(progressLabel);
      content.appendChild(progressDetail);
      content.appendChild(progressName);
      content.appendChild(progressBar);
      content.appendChild(cancelCheckBtn);
      okBtn.style.display = 'none';
      cancelBtn.style.display = 'none';
      m.classList.remove('hidden');

      const off = window.App.ingest.onCheckProgress((data) => {
        if (data.type === 'progress' || data.type === 'done') {
          const n = data.done != null ? data.done : data.total;
          const hasBytes = typeof data.totalBytes === 'number' && data.totalBytes > 0;
          // バー幅はバイト単位進捗が使えるならそちらを優先（大容量1本のハッシュ中でも動き続ける）。
          // totalBytes が無い（旧イベント形式）場合は件数比で従来どおり動かす。
          const pct = hasBytes
            ? (data.bytes / data.totalBytes) * 100
            : (data.total > 0 ? n / data.total * 100 : 0);
          progressBar.firstElementChild.style.width = pct.toFixed(1) + '%';

          const bytesSuffix = hasBytes ? `（${formatBytes(data.bytes)} / ${formatBytes(data.totalBytes)}）` : '';
          progressDetail.textContent = `${n} / ${data.total}${bytesSuffix}`;
          progressName.textContent = data.name ? `処理中: ${data.name}` : '';
        }
      });

      // モーダルの後片付けは try/finally で保証する。
      // これが無いと main 側の例外時にボタンのないモーダルが画面を覆ったまま操作不能になる
      let r = null;
      try {
        r = await window.App.ingest.checkDuplicates(filesToCheck);
      } catch (e) {
        r = { ok: false, error: String(e?.message || e) };
      } finally {
        off();
        okBtn.style.display = '';
        cancelBtn.style.display = '';
        m.classList.add('hidden');
      }

      // ユーザーがキャンセルした場合はこの画面に留まる（フラグ無しで先へ進めない）
      if (r && r.cancelled) return;

      if (r && r.ok && Array.isArray(r.results)) {
        // 結果を file にマージ
        r.results.forEach((res, i) => {
          if (!res) return;
          // main は「送った要素数・順序どおり」に結果を返す契約（不正要素もエラー行で位置を保つ）。
          // 万一ズレた場合は別ファイルへ判定を付けてしまうので、対応が取れない行は捨てる。
          const owner = ownerLookup[i];
          if (!owner) return;
          const f = state.sources[owner.srcIdx].files[owner.fIdx];
          mergeCheckResult(f, res);
        });
        state.lastDuplicateCount = r.duplicateCount || 0;
        // チェックできなかった件数（stat 失敗・読み取りエラー等）。プレビューで注記を出す。
        // これらのファイルは選択状態を一切変更していない＝「既取込は自動除外済み」という
        // プレビューの説明が全件には当てはまらないので、件数だけでも見せる。
        state.lastCheckErrorCount = r.results.filter((res) => res && res.error).length;
        state.goto('preview');
        return;
      }

      // チェック失敗: 黙って進むと「既取込は自動除外済み」というプレビュー表示と
      // 実態が食い違う（全ファイルが再コピー対象になる）ため、ユーザーに選ばせる
      state.lastDuplicateCount = 0;
      U.modal({
        title: '重複チェック失敗',
        body: el('div', null,
          el('p', null, '重複チェックを完了できませんでした: ' + (r?.error || '不明なエラー')),
          el('p', { style: { fontSize: '12px', color: 'var(--fg-mute)' } },
            'このまま進むと、取り込み済みのファイルも「既取込」と表示されず再コピー対象になります'
            + '（コピー時の差分判定は引き続き働くため、二重コピー自体は発生しません）。'),
        ),
        okText: 'このまま進む',
        cancelText: 'やり直す',
        onOk: () => state.goto('preview'),
      });
    };

    // 「次へ」: バリデーション → データ種別の最終確認ポップアップ → proceedToCheck
    const onNext = () => {
      if (state.sources.length === 0) {
        U.modal({ title: 'ソース未選択', body: '取り込み元を1つ以上追加してください。' });
        return;
      }
      const missingType = state.sources.find(s => !s.type);
      if (missingType) {
        U.modal({ title: '種別未選択', body: `「${missingType.name}」の種別を選択してください。` });
        return;
      }
      const totalFiles = state.sources.reduce((s, src) => s + (src.files?.length || 0), 0);
      if (totalFiles === 0) {
        U.modal({ title: 'ファイルなし', body: '選択されたソースに取り込み可能なファイルがありません。' });
        return;
      }

      // 各ソースの種別を一覧表示して最終確認
      const labelOf = (key) => {
        const opt = ALL_TYPE_OPTIONS.find(o => o.key === key);
        return opt ? opt.label : key;
      };
      const deleteAfterCopy = cfg.deleteAfterCopy || {};
      const listEl = el('ul', { style: { paddingLeft: '18px', margin: '8px 0', lineHeight: '1.9' } },
        ...state.sources.map(src => {
          const willDelete = deleteAfterCopy[src.type] === true;
          return el('li', null,
            el('span', { style: { color: 'var(--fg-mute)' } }, src.name),
            ' → ',
            el('strong', { style: { color: 'var(--accent)' } }, labelOf(src.type)),
            el('span', { style: { fontSize: '11px', color: 'var(--fg-mute)' } },
              `（${src.files?.length || 0} ファイル）`),
            willDelete
              ? el('span', { style: { marginLeft: '6px', color: 'var(--err)', fontSize: '11px' } },
                  '🗑 コピー後に元削除')
              : null,
          );
        }),
      );
      const body = el('div', null,
        el('p', { style: { marginBottom: '4px' } }, '以下のデータ種別で取り込みます。よろしいですか？'),
        listEl,
        el('p', { style: { fontSize: '12px', color: 'var(--fg-mute)' } },
          '種別が違う場合は「戻って修正」を押し、各ソースの種別を選び直してください。'),
      );
      U.modal({
        title: 'データ種別の確認',
        body,
        okText: 'この種別で取り込む',
        cancelText: '戻って修正',
        onOk: () => { proceedToCheck(); },
      });
    };

    // 取り込み元数バッジ（renderSources 呼出時に MutationObserver で自動更新）
    const sourceCountBadge = el('span', { style: { marginLeft: '8px', color: 'var(--accent)' } }, `(${state.sources.length})`);

    const root = el('div', null,
      // 1. 上部: 取り込み元一覧（既に追加したもの）
      el('div', { class: 'card' },
        el('div', { class: 'row', style: { alignItems: 'center', marginBottom: '8px' } },
          el('h2', { style: { flex: 1, margin: 0 } }, '取り込み元一覧', sourceCountBadge),
        ),
        banner,
        elList,
        el('div', { class: 'actions between' },
          el('button', { class: 'ghost', onclick: () => state.goto('patient') }, '← 患者情報へ'),
          el('button', { class: 'primary', onclick: onNext }, '次へ：プレビュー →'),
        ),
      ),
      // 2. 下部: 検出されたボリューム（追加候補）
      el('div', { class: 'card' },
        el('h2', null, '＋ 検出されたボリューム（' + (window.App.platform === 'darwin' ? '/Volumes' : 'ドライブ') + '）'),
        el('div', { style: { fontSize: '12px', color: 'var(--fg-mute)', marginBottom: '8px' } },
          '使いたいデバイスを「取り込み元に追加」してください。'),
        el('div', { class: 'row', style: { marginBottom: '8px' } }, reloadBtn, chooseBtn),
        elVolumes,
      ),
    );

    mount.replaceChildren(root);
    renderSources();
    loadVolumes();

    // renderSources 呼出毎にバッジ件数を更新
    const obs = new MutationObserver(() => {
      sourceCountBadge.textContent = `(${state.sources.length})`;
    });
    obs.observe(elList, { childList: true });
  }

  // _mergeCheckResult / _resetDiffState はテスト（scratchpad の ingest-smoke）から
  // 判定表と副作用を直接叩くための公開。アプリ本体からは render 内でのみ使う。
  return { render, _mergeCheckResult: mergeCheckResult, _resetDiffState: resetDiffState };
})();
