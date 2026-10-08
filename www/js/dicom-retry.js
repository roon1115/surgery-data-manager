(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DicomRetry = api;
})(typeof window !== 'undefined' ? window : null, function() {
  // 候補を順に見て「正の整数である最初の値」を採る。0・負値・欠損は InstanceNumber として
  // 無効なので採らない（無効な番号を記録すると再送時に採番済み扱いになり番号が衝突する）。
  function firstPositiveInt(...values) {
    for (const value of values) {
      if (Number.isInteger(value) && value > 0) return value;
    }
    return null;
  }

  // InstanceNumber は「そのファイルに最初に割り当てた番号」を失敗レコードへ透過させる。
  // 再送で番号が変わると、同じ SOP Instance UID の画像が別番号で届き、PACS 側の
  // 並び順が変わる／重複判定を惑わせるため（SOP UID と同じく再利用が原則）。
  function pickInstanceNumber(file, result) {
    return firstPositiveInt(file && file.instanceNumber, result && result.instanceNumber);
  }

  // 元データ（SD）が残る直後の送信だけ、SD の現物を読む。ただし「パスが同じ」だけでは
  // 信用しない: SD の差し替えや番号の振り直しで同じパスに別症例の写真が来ると、
  // 別の患者の写真が送られてしまう。main の readVerifiedSource が現物の SHA-256 を
  // コピー時の値（srcSha）と照合し、一致した bytes だけを返す。一致しない・読めない・
  // デコードできないときは NAS に保存済みの写真から読む（NAS は取り込み時に照合済み）。
  // srcPath を file:// で直接読む経路は持たない（同一ページ内のメモリキャッシュ混同を避ける）。
  // 戻す画像の識別子は呼び出し側の file.path のままにする。
  // deps: { readVerifiedSource({path,sha256}), decodeBytes(bytes,name), decodeFile(path),
  //         canDecode?(name), log?(text) }
  async function decodeWithFallback(file, deps) {
    const log = (deps && deps.log) || (() => {});
    // sourceState（呼び出し側が 1 回の送信で共有する）: SD が応答しない（時間切れ）が 2 回続いたら、
    // その送信の残りは SD を読まずに NAS から読む。1 枚ごとに 30 秒待つと 100 枚で 50 分止まり、
    // 時間切れ後も残る読み込みが main のスレッドプールを埋めるため（Opus レビュー 2 巡目）。
    const st = deps && deps.sourceState;
    const useSource = file.srcPath && file.srcSha && !(st && st.disabled)
      && !(deps.canDecode && !deps.canDecode(file.srcPath));
    if (useSource) {
      let reason = null;
      try {
        const r = await deps.readVerifiedSource({ path: file.srcPath, sha256: file.srcSha });
        if (r && r.ok && r.bytes) {
          try {
            return await deps.decodeBytes(r.bytes, file.srcPath);
          } catch (_) {
            reason = 'decode-failed';
          }
        } else {
          reason = (r && r.reason) || 'unknown';
        }
      } catch (_) {
        reason = 'ipc-error';
      }
      if (st) {
        st.timeouts = reason === 'timeout' ? (st.timeouts || 0) + 1 : 0;
        if (st.timeouts >= 2 && !st.disabled) {
          st.disabled = true;
          log('SD が応答しないため、残りの写真は NAS から読みます');
        }
      }
      // sha-mismatch だけが「中身が違う」。それ以外（抜いた・読めない・時間切れ）を同じ文言にすると
      // 「別の患者の写真が混ざったのか」と誤解させるので書き分ける（Opus レビュー 2 巡目）。
      log(reason === 'sha-mismatch'
        ? `SD の写真がコピー時と一致しないため NAS から読みます: ${file.name || ''}`
        : `SD の写真を読めないため NAS から読みます: ${file.name || ''}（${reason}）`);
    }
    return deps.decodeFile(file.path);
  }

  // 共有ドライブが応答しないとき、1 枚ごとに 60 秒待つと残りの枚数ぶん何十分も画面が固まる。
  // デコード時間切れが limit 回連続したら tripped になり、呼び出し側は残りをデコードせず
  // 失敗キューへ回す。時間切れ以外の失敗や成功で連続回数はリセットされる。
  function createDecodeTimeoutBreaker(limit = 3) {
    let streak = 0;
    let tripped = false;
    return {
      recordSuccess() { streak = 0; },
      recordFailure(err) {
        if (err && err.decodeTimeout) {
          streak += 1;
          if (streak >= limit) tripped = true;
        } else {
          streak = 0;
        }
      },
      isTripped() { return tripped; },
    };
  }

  // main が返した results を「files 上の index → result」に畳み込む。
  // バッチごとの indices（送信した画像の位置 → files 上の index）を介さないと、
  // デコード失敗でバッチ内の位置がずれたときに別ファイルの結果を拾ってしまう。
  function buildResultMap(batchResults) {
    const resultMap = new Map();
    for (const batch of batchResults || []) {
      const indices = (batch && batch.indices) || [];
      for (const result of (batch && batch.results) || []) {
        if (!result) continue; // 応答が埋まらなかった穴は「結果なし」として扱う
        const fileIndex = indices[result.index];
        if (fileIndex !== undefined) resultMap.set(fileIndex, result);
      }
    }
    return resultMap;
  }

  function collectFailures(files, decodeFailedIdx, batchResults) {
    const decodeSet = new Set(decodeFailedIdx || []);
    const resultMap = buildResultMap(batchResults);
    return (files || []).map((file, index) => {
      // デコード失敗でも既に採番済みの SOP UID は捨てない。
      // 一度送った（かもしれない）画像に別 UID を振り直すと PACS に重複登録され得るため。
      if (decodeSet.has(index)) return {
        path: file.path,
        name: file.name,
        sopUID: file.sopUID || null,
        instanceNumber: pickInstanceNumber(file, null),
        reason: 'decode',
      };
      const result = resultMap.get(index);
      if (!result || !result.ok) return {
        path: file.path,
        name: file.name,
        sopUID: result?.sopUID || file.sopUID || null,
        instanceNumber: pickInstanceNumber(file, result),
        reason: result?.status != null ? `status=0x${Number(result.status).toString(16)}` : (result?.reason || 'no-response'),
      };
      return null;
    }).filter(Boolean);
  }

  // 今回の送信で各ファイルに「実際に使われた」識別子（SOP UID / InstanceNumber）を確定する。
  // main が返した results の値を最優先する：レンダラ側で SOP UID を採番できなかった
  // （generateSopUID が null を返した）場合でも main は独自に採番して送っているため、
  // null のまま記録すると次の再送で別 UID が振られ、既に受理された画像が PACS に重複登録される。
  // results が無いファイル（例外・無応答）だけ、レンダラ側で採番した値へフォールバックする。
  function buildAttemptedFiles(files, sopUIDs, instanceNumbers, batchResults) {
    const resultMap = buildResultMap(batchResults);
    const uids = Array.isArray(sopUIDs) ? sopUIDs : [];
    const numbers = Array.isArray(instanceNumbers) ? instanceNumbers : [];
    return (Array.isArray(files) ? files : []).map((file, index) => {
      const result = resultMap.get(index);
      return {
        path: file && file.path,
        name: file && file.name,
        sopUID: (result && result.sopUID) || uids[index] || (file && file.sopUID) || null,
        instanceNumber: firstPositiveInt(
          result && result.instanceNumber,
          numbers[index],
          file && file.instanceNumber,
        ),
      };
    });
  }

  function mergeQueueFiles(existingFiles, newFiles) {
    const byPath = new Map();
    for (const file of Array.isArray(existingFiles) ? existingFiles : []) {
      if (file && file.path) byPath.set(file.path, { ...file });
    }
    for (const file of Array.isArray(newFiles) ? newFiles : []) {
      if (file && file.path) byPath.set(file.path, { ...file });
    }
    return Array.from(byPath.values());
  }

  function nextInstanceNumberAfter(startInstanceNumber, count) {
    const start = Number.isInteger(startInstanceNumber) && startInstanceNumber > 0 ? startInstanceNumber : 1;
    return start + Math.max(0, Number.isInteger(count) ? count : 0);
  }

  // ファイルごとの InstanceNumber を確定する。
  // 一度でも送信を試みたファイル（f.instanceNumber を持つ）は同じ番号を再利用し、
  // 番号を持たないファイルだけカーソルから新規採番する。再送のたびに番号を振り直すと、
  // 同じ SOP Instance UID の画像が前回と違う番号で届くため。
  //
  // 走査は必ず二段階にする。先頭から1パスでカーソルを進めると、後ろにある既存番号と
  // 新規採番がぶつかる：[{10}, {番号なし}, {11}] を開始値 2 で渡すと [10, 11, 11] になり、
  // 同一 Series 内で別画像が同じ InstanceNumber を持つ（PACS 上でどちらかが埋もれる）。
  // ① 全件の既存番号から maxExisting を求めてカーソルを max(開始値, maxExisting + 1) に置き、
  // ② 番号なしのファイルだけをそのカーソルから採番する。
  // 返す nextInstanceNumber は採番後のカーソル（= 採番済みの最大 + 1）。
  //
  // 既存番号どうしが重複している（= 記録済みデータが既に壊れている）場合は duplicates に
  // その番号を入れて返す。ここで自動的に振り直すと、既に PACS が受理した番号を書き換えて
  // しまい得るので、判断は呼出側（送信を中止して人が直す）に委ねる。
  function assignInstanceNumbers(files, startInstanceNumber) {
    const list = Array.isArray(files) ? files : [];
    const existing = list.map((file) => firstPositiveInt(file && file.instanceNumber));

    // ① 既存番号の走査（最大値と重複の検出）
    let maxExisting = 0;
    const seen = new Set();
    const duplicates = [];
    for (const n of existing) {
      if (n === null) continue;
      if (n > maxExisting) maxExisting = n;
      if (seen.has(n)) {
        if (!duplicates.includes(n)) duplicates.push(n);
      } else {
        seen.add(n);
      }
    }

    const start = Number.isInteger(startInstanceNumber) && startInstanceNumber > 0 ? startInstanceNumber : 1;
    let cursor = Math.max(start, maxExisting + 1);

    // ② 番号なしのファイルだけ採番する（既存番号はそのまま維持 = 再送の冪等性）
    const instanceNumbers = existing.map((n) => (n === null ? cursor++ : n));
    return { instanceNumbers, nextInstanceNumber: cursor, duplicates };
  }

  // SOP Instance UID を採番する（main 側 generateUID と同じ '2.25.<128bit乱数>' 形式）。
  // レンダラ側で先に採番しておくと、sendStudy が例外で返って results が得られなかった
  // 場合でも「どの UID で送ろうとしたか」を失敗レコードに残せる。再送で同じ UID を使えば
  // PACS 側で重複登録にならない。乱数源が無い環境では null を返し、main 側の採番に委ねる。
  function generateSopUID(randomSource) {
    try {
      const src = randomSource || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
      if (!src || typeof src.getRandomValues !== 'function') return null;
      const buf = new Uint8Array(16);
      src.getRandomValues(buf);
      let hex = '';
      for (let i = 0; i < buf.length; i++) hex += buf[i].toString(16).padStart(2, '0');
      const uid = '2.25.' + BigInt('0x' + hex).toString();
      return uid.length <= 64 ? uid : null; // DICOM UID は 64 文字以内
    } catch (_) {
      return null;
    }
  }

  return {
    decodeWithFallback,
    createDecodeTimeoutBreaker,
    collectFailures,
    buildAttemptedFiles,
    mergeQueueFiles,
    nextInstanceNumberAfter,
    assignInstanceNumbers,
    generateSopUID,
  };
});
