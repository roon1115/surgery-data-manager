const { ipcMain } = require('electron');
const crypto = require('crypto');
const settings = require('./settings-handler');
const db = require('./db');
const dicomLog = require('./dicom-log');

let dimse = null;
try {
  dimse = require('dcmjs-dimse');
} catch (_) {
  dimse = null;
}

function generateUID() {
  const buf = crypto.randomBytes(16);
  const big = BigInt('0x' + buf.toString('hex'));
  return '2.25.' + big.toString();
}

function dicomDate(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  return m ? m[1] + m[2] + m[3] : '';
}

function dicomTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function pickTransferSyntax(uid) {
  if (!dimse) return null;
  const TS = dimse.constants.TransferSyntax;
  switch (uid) {
    case '1.2.840.10008.1.2': return TS.ImplicitVRLittleEndian;
    case '1.2.840.10008.1.2.1': return TS.ExplicitVRLittleEndian;
    default: return TS.ImplicitVRLittleEndian;
  }
}

function asciiOnly(s) {
  return String(s || '').replace(/[^\x20-\x7E]/g, '').trim();
}

function buildDataset(opts) {
  if (!dimse) throw new Error('dcmjs-dimse not installed');
  const { Dataset } = dimse;
  const {
    patient, exam, studyUID, seriesUID, sopUID, modality, charset,
    instanceNumber, width, height, rgb, transferSyntax,
  } = opts;

  const studyDate = dicomDate(exam?.datetime);
  const studyTime = dicomTime(exam?.datetime);
  const pixelBytes = Buffer.from(rgb);

  const elements = {
    SpecificCharacterSet: charset || 'ISO_IR 100',
    SOPClassUID: '1.2.840.10008.5.1.4.1.1.7',
    SOPInstanceUID: sopUID,
    ImageType: ['DERIVED', 'SECONDARY'],
    StudyInstanceUID: studyUID,
    StudyDate: studyDate,
    StudyTime: studyTime,
    AccessionNumber: '',
    ReferringPhysicianName: '',
    StudyID: '1',
    StudyDescription: asciiOnly(exam?.desc),
    SeriesInstanceUID: seriesUID,
    SeriesNumber: '1',
    Modality: modality || 'OT',
    Manufacturer: 'Stella',
    ManufacturerModelName: 'SurgeryDataManager',
    DateOfSecondaryCapture: studyDate,
    TimeOfSecondaryCapture: studyTime,
    PatientName: asciiOnly(patient?.name),
    PatientID: asciiOnly(patient?.id),
    PatientBirthDate: dicomDate(patient?.dob),
    PatientSex: asciiOnly(patient?.sex),
    InstanceNumber: String(instanceNumber),
    PatientOrientation: '',
    SamplesPerPixel: 3,
    PhotometricInterpretation: 'RGB',
    PlanarConfiguration: 0,
    Rows: height,
    Columns: width,
    BitsAllocated: 8,
    BitsStored: 8,
    HighBit: 7,
    PixelRepresentation: 0,
    PixelData: [pixelBytes.buffer.slice(pixelBytes.byteOffset, pixelBytes.byteOffset + pixelBytes.byteLength)],
  };

  return new Dataset(elements, pickTransferSyntax(transferSyntax));
}

// 送信中の「生きた」通信量を読む。優先順位つきで、取れた経路名も返す（ログの activitySource 用）。
//
// Client.getStatistics() は dcmjs-dimse 0.3.3 では **ソケット close 時にしか** 更新されない
// （`p.on("close",()=>{this.statistics.addFromOtherStatistics(p.getStatistics()),this.network=void 0,...`）。
// そのため送信中は常に 0 で、これだけを見ると低速回線で abort が誤発火する。
// 送信中に生きているのは Client.send() が作る Network（client.network）側:
//   - network.socket: Node の net.Socket。PDU は socket.write() で書かれるが、bytesWritten は
//     「書き込みを受け付けた量」でキューに積んだ時点で全量に跳ねる。実際に送り出せた量は
//     bytesWritten - writableLength（キュー内・未完了の分を引く）で、低速回線でも少しずつ進む。
//   - network.getStatistics(): addBytesSent も socket.write の直後（キュー投入時）に加算されるため
//     送出側の進みは粗いが、受信側（応答）は 'data' ごとに生きている。
// socket を第一候補にするのは、上記のとおり送出の進捗を最も正確に反映するため。
//
// writePending: ソケットにまだ書き込み待ちのデータがあるか（writableLength > 0 または writableNeedDrain）。
// ライブラリは画像を「相手と合意した最大 PDU 長（相手が 0＝無制限なら 4MB）」ごとに 1 回の socket.write で
// 書くため、bytesWritten - writableLength はその 1 書き込みが完了するまで動かない。相手の最大 PDU 長が
// 大きく回線が遅いと、1 PDU の送出中ずっと「バイトが動かない」ように見える（4MB を 30KB/s で送ると
// 約 136 秒）。書き込み待ちが残っている間は「詰まっているのではなく送出中」と区別するために使う。
// 死んだ回線でも書き込み待ちは残るので、これだけで無期限に待たないよう sampleActivity 側で上限を設ける。
const PDU_TIMEOUT_MS = 10 * 60 * 1000; // ライブラリの pduTimeout（client.send に渡す値）と、書き込み待ち中の進捗扱いの上限を兼ねる
const ACTIVITY_RANK = { none: 0, client: 1, network: 2, socket: 3 };
function readLiveActivity(client) {
  const net = client && client.network;
  try {
    const sock = net && net.socket;
    if (sock && typeof sock.bytesWritten === 'number') {
      return {
        source: 'socket',
        sent: Math.max(0, sock.bytesWritten - (sock.writableLength || 0)),
        received: sock.bytesRead || 0,
        writePending: (sock.writableLength || 0) > 0 || sock.writableNeedDrain === true,
      };
    }
  } catch (_) { /* 次の経路へ */ }
  try {
    const st = net && typeof net.getStatistics === 'function' ? net.getStatistics() : null;
    if (st) return { source: 'network', sent: st.getBytesSent(), received: st.getBytesReceived() };
  } catch (_) { /* 次の経路へ */ }
  try {
    const st = client && typeof client.getStatistics === 'function' ? client.getStatistics() : null;
    if (st) return { source: 'client', sent: st.getBytesSent(), received: st.getBytesReceived() };
  } catch (_) { /* 統計未対応 */ }
  return null;
}

// runClient: dcmjs-dimse の Client を「無応答タイムアウト」付きで実行する。
//
// タイムアウトは総時間ではなく **無応答（進捗なし）が timeoutMs 続いたとき** に発火する。
// v0.3.18 では総時間 60 秒の固定だったため、遅い経路（Wi-Fi・Tailscale 等）で大きなバッチの
// 転送が 60 秒を超えると、まだ順調に送れている最中に abort で打ち切り、
// 残りの画像が PACS に届かなかった（v0.3.16 以前は abort しなかったので裏で届いていた）。
// setup 側は C-STORE 応答のたびに ctl.touch() を呼び、ctl.progress.sent を更新する。
function runClient(setup, timeoutMs = 30000, kind = 'echo', pollMs = 2000, closeGraceMs = 5000) {
  if (!dimse) return Promise.resolve({ ok: false, error: 'dcmjs-dimse not installed' });
  const { Client } = dimse;
  return new Promise((resolve) => {
    let settled = false;
    let closed = false;
    let released = false;
    let pendingRelease = null;
    let releaseGrace = null;
    let pendingAfterClose = null; // タイムアウト時: closed を待ってから返す値
    let closeGrace = null;
    let t = null;
    let timedOut = false;
    const progress = { sent: 0, total: 0, results: [] };
    // 活動監視: 取れた経路のうち最も優先度の高いものを activitySource に残す。
    let activitySource = 'none';
    let lastLive = null;
    let lastBytes = 0;
    let lastProgressAt = Date.now(); // バイトが最後に実際に動いた時刻（書き込み待ち中の進捗扱いの起点）
    let peerMaxPdu; // 相手と合意した最大 PDU 長（0＝無制限）。associationAccepted で読み、取れなければ出さない
    // 通信量が前回から動いていれば true（呼出側が touch で無応答タイマーを再武装する）。
    //
    // 加えて「バイトは動いていないが、ソケットに書き込み待ちが残っている」間は、最後に実際にバイトが
    // 動いた時刻から PDU_TIMEOUT_MS（10 分）までは進捗扱い（true）にする。1 PDU（最大 4MB 等）の
    // socket.write が完了するまで bytesWritten - writableLength が動かないため、遅い回線で
    // 無進捗 120 秒の誤 abort を防ぐ。10 分を超えたら従来どおり false（＝無進捗として abort に向かう）。
    // 本当に止まった回線でもライブラリ側 pduTimeout（同じ 10 分）で終わるので、無期限には待たない。
    // 実際の上限はもっと短い: ライブラリは接続後も socket.setTimeout(connectTimeout=180 秒) を残しており、
    // 1 PDU の書き込みが 180 秒完了しなければ networkError で確定する（Opus レビュー 3 巡目の指摘）。
    // つまり相手の最大 PDU が 4MB（無制限申告）で約 23KB/s 未満の回線では 180 秒で失敗する。Horos は
    // 最大 PDU が小さい（実測の疑似 PACS は 256KB）ため影響しない。失敗分は同じ UID で再送される。
    const sampleActivity = () => {
      const live = readLiveActivity(client);
      if (!live) return false;
      if (ACTIVITY_RANK[live.source] > ACTIVITY_RANK[activitySource]) activitySource = live.source;
      // close 直前に network が外れると 'client'(0) に落ちるので、より良い経路で読めた最後の値を保持する
      if (!lastLive || ACTIVITY_RANK[live.source] >= ACTIVITY_RANK[lastLive.source] || live.sent > 0) lastLive = live;
      const bytes = live.sent + live.received;
      if (bytes !== lastBytes) { lastBytes = bytes; lastProgressAt = Date.now(); return true; }
      if (live.writePending && Date.now() - lastProgressAt < PDU_TIMEOUT_MS) return true;
      return false;
    };
    // ソケットを破棄して滞留データを捨てる（abort は A-ABORT を書くだけでソケットを閉じない）。
    const destroySocket = () => {
      try { client.network?.socket?.destroy(); } catch (_) { /* 既に閉じている等 */ }
    };
    const settle = (value) => {
      if (settled) return;
      settled = true;
      if (t) clearTimeout(t);
      if (closeGrace) clearTimeout(closeGrace);
      if (releaseGrace) clearTimeout(releaseGrace);
      // bytesSent: close 後の Client 統計（送った PDU の総量・確定値）を第一に、無ければ送信中に
      // 最後に読めた生きた値を使う。どちらも 0（=取れていない）ならフィールドを出さない。
      sampleActivity();
      let bytesSent;
      try { bytesSent = client.getStatistics?.().getBytesSent(); } catch (_) { /* 統計未対応 */ }
      if (!(bytesSent > 0) && lastLive && lastLive.sent > 0) bytesSent = lastLive.sent;
      const out = { ...value, activitySource };
      if (bytesSent > 0) out.bytesSent = bytesSent;
      if (peerMaxPdu !== undefined) out.peerMaxPdu = peerMaxPdu;
      resolve(out);
    };
    const finishRelease = (release) => {
      if (!pendingRelease) return;
      const value = pendingRelease;
      pendingRelease = null;
      settleAndStop({ ...value, release });
    };
    const settleAfterRelease = (value) => {
      if (settled || pendingAfterClose) return;
      // 全応答後は無応答タイマーを止め、A-RELEASE または close を最大3秒待つ。
      // 次バッチの接続が前バッチの解放と重ならないようにするため。
      if (t) clearTimeout(t);
      pendingRelease = value;
      if (released) return finishRelease('released');
      if (closed) return finishRelease('closed');
      releaseGrace = setTimeout(() => finishRelease('3s timeout'), 3000);
    };
    // タイムアウト: Promise を失敗で確定するだけでは association と未完了 C-STORE が生き残り、
    // 呼出側が「失敗」として次バッチや再送を始めた後に旧クライアントが PACS へ遅延到達して
    // 重複登録になる。association を明示 abort し、closed を待ってから確定する
    // （closed が来ない場合も closeGraceMs＝5 秒で打ち切る）。結果は「送信状況不明」として返すが、
    // 応答済み（=PACS が受理済み）の枚数は sent として正しく返す。
    // client.abort() は A-ABORT PDU を書くだけでソケットは閉じない。closed が来ないまま確定するときは
    // ソケットを destroy して滞留データを捨てる（古い association が最大 10 分残り、遅れて届く
    // 重複を PACS が受理するのを防ぐ）。
    const onTimeout = () => {
      if (settled) return;
      timedOut = true; // 以後は活動監視・応答で再武装しない（abort 後に再発火して二重に abort/ログしないため）
      if (kind === 'send') dicomLog.log('send.timeout', { sent: progress.sent, total: progress.total });
      if (kind === 'send') dicomLog.log('send.abort', { sent: progress.sent, total: progress.total });
      try { client.abort(); } catch (_) { /* 未接続など */ }
      const value = {
        ok: false,
        indeterminate: true,
        sent: progress.sent,
        failed: Math.max(0, progress.total - progress.sent),
        results: progress.results,
        error: `timeout（${Math.round(timeoutMs / 1000)}秒間応答なし。受理済み ${progress.sent}/${progress.total} 枚。未受理分は再送時に重複しない）`,
      };
      if (closed) return settleAndStop(value);
      pendingAfterClose = value;
      closeGrace = setTimeout(() => {
        settleAndStop(value);
        if (!closed) destroySocket(); // 確定（統計の読み取り）の後に破棄する
      }, closeGraceMs);
    };
    const armTimer = () => {
      if (t) clearTimeout(t);
      t = setTimeout(onTimeout, timeoutMs);
    };
    // 再武装してよいのは「まだ送受信中」のときだけ。タイムアウト済み・全応答後（解放待ち）に
    // 再武装すると、abort 済みの association に対して onTimeout が再度走る。
    const rearm = () => { if (!settled && !timedOut && !pendingRelease) armTimer(); };
    const touch = () => { if (settled) return; sampleActivity(); rearm(); };
    armTimer();

    const client = new Client();

    // 応答イベントだけでは「1 枚の転送が timeoutMs を超える」低速経路（例: 12MB/枚を 1.5Mbps
    // 以下で送る）を救えないため、送受信バイト数を定期的に見て、バイトが動いている限り進捗とみなす。
    // 読み先は readLiveActivity（socket → network → client の順）。Client.getStatistics() は
    // close 時にしか更新されないので、それだけに頼ると送信中は常に 0 で効かない。
    // どの経路も取れなければ従来どおり応答ベースの再武装だけになる。
    const activityPoll = setInterval(() => {
      if (settled) { clearInterval(activityPoll); return; }
      try {
        if (sampleActivity()) rearm();
      } catch (_) { /* 統計未対応でも応答ベースの再武装は残る */ }
    }, pollMs); // 通信量の確認間隔（pollMs は試験で短縮するための引数。既定 2 秒）
    const origSettle = settle;
    // settle 時にポーリングも止める（settle は const なので内側で差し替え）
    const settleAndStop = (value) => { clearInterval(activityPoll); origSettle(value); };
    // 応答が揃う前に相手が接続を閉じた／A-ABORT を送ってきたときの確定値（送信状況不明）。
    // 枚数つきの注記。C-ECHO（kind='echo'）には枚数が無いので省く（「受理済み 0/0 枚」と出さない）
    const progressNote = () => (kind === 'echo' ? '' : `（受理済み ${progress.sent}/${progress.total} 枚。未受理分は再送時に重複しない）`);
    const unfinishedValue = (error) => ({
      ok: false,
      indeterminate: true,
      sent: progress.sent,
      failed: Math.max(0, progress.total - progress.sent),
      results: progress.results,
      error,
    });
    client.on('networkError', (err) => {
      settleAndStop({ ok: false, sent: progress.sent, results: progress.results, error: `network: ${err?.message || err}` });
      // ライブラリは networkError で socket.end() しか呼ばず、書き込みキューに残った C-STORE データが
      // 確定後（再送開始後）も旧ソケットから流れ続け得る。同じ SOP UID とはいえ旧接続と再送が同時に
      // 同じインスタンスを書く状態を避けるため、確定後に破棄する（closeGrace / abort 受信時と同じ扱い）。
      if (!closed) destroySocket();
    });
    client.on('associationRejected', () => settleAndStop({ ok: false, sent: 0, results: progress.results, error: 'association rejected' }));
    client.on('associationAccepted', (assoc) => {
      // 相手の最大 PDU 長を send.end ログ（peerMaxPdu）に残す。大きいほど 1 書き込みが長く進捗が粗くなり、
      // 遅い回線での無進捗判定の原因調査に要る。取れなければ出さない。
      try {
        const v = assoc?.getMaxPduLength?.() ?? client.network?.association?.getMaxPduLength?.();
        if (Number.isFinite(v) && v >= 0) peerMaxPdu = v;
      } catch (_) { /* 取れなければ出さない */ }
      touch(); // 接続確立も進捗
    });
    client.on('associationReleased', () => {
      released = true;
      finishRelease('released');
    });
    client.on('closed', () => {
      closed = true;
      if (pendingAfterClose) return settleAndStop(pendingAfterClose);
      if (pendingRelease) return finishRelease('closed');
      // 応答が揃う前に相手が接続を閉じた（PACS 側の A-ABORT やタイムアウト）。networkError が来ない
      // 経路では、ここで確定しないと無進捗タイムアウト（120 秒）まで待ち続ける（2026-10-08 の模擬で
      // 実測: 相手が 60 秒で A-ABORT → 180 秒後にようやく失敗表示）。受理済み枚数はそのまま返す。
      if (!settled) {
        settleAndStop(unfinishedValue(`接続が相手側で閉じられました${progressNote()}`));
      }
    });

    try {
      setup(client, settleAndStop, { touch, progress, settleAfterRelease });
      // 相手が A-ABORT だけ送って接続を閉じない場合、closed も networkError も来ず無進捗タイムアウト
      // （120 秒）まで待つことになる。Client は network の 'abort' を転送しないので、send() が network を
      // 作った直後（setup 内で send 済み）に network へ直接つなぐ。network が無ければ何もしない。
      client.network?.on?.('abort', () => {
        if (settled || pendingAfterClose) return; // 確定済み・自分で abort 済みなら closed を待つ既存の流れに任せる
        const error = `相手側から A-ABORT を受信しました${progressNote()}`;
        if (pendingRelease) finishRelease('abort'); // 全応答後の解放待ち中ならその旨で確定
        else settleAndStop(unfinishedValue(error));
        if (!closed) destroySocket(); // 相手が閉じないなら自分で閉じる（古い association を残さない）
      });
    } catch (e) {
      settleAndStop({ ok: false, sent: progress.sent, error: String(e?.message || e) });
    }
  });
}

ipcMain.handle('dicom:echo', async (_e, args = {}) => {
  const started = Date.now();
  const cfg = settings.getAll().dicom;
  const callingAet = (args.callingAet || cfg.callingAet || 'SURGERY').trim();
  const calledAet = (args.calledAet || cfg.calledAet || 'STELLADICOM').trim();
  const host = (args.host || cfg.host || '').trim();
  const port = parseInt(args.port ?? cfg.port, 10) || 104;
  const finish = (result) => {
    dicomLog.log('echo', { host, port, calledAet, callingAet, ok: result.ok, error: result.error, ms: Date.now() - started });
    return result;
  };
  if (!dimse) return finish({ ok: false, error: 'dcmjs-dimse not installed' });
  if (!host) return finish({ ok: false, error: 'host is empty' });

  const result = await runClient((client, settle) => {
    const { requests, constants } = dimse;
    const req = new requests.CEchoRequest();
    req.on('response', (response) => {
      const status = response.getStatus();
      if (status === constants.Status.Success) settle({ ok: true });
      else settle({ ok: false, error: `C-ECHO failed (status=0x${status.toString(16)})` });
    });
    client.addRequest(req);
    client.send(host, port, callingAet, calledAet);
  });
  return finish(result);
});

// main 側の排他: 同時に走る C-STORE 送信は1系列だけ。
// レンダラのロックをすり抜けた多重呼び出し（再描画・二重クリック）で同じ画像が
// 別 Study として PACS に重複登録されるのを止める。バッチは直列 await なので影響しない。
let sendStudyBusy = false;

ipcMain.handle('dicom:sendStudy', async (_e, args = {}) => {
  if (!dimse) return { ok: false, error: 'dcmjs-dimse not installed' };
  if (sendStudyBusy) return { ok: false, sent: 0, error: '別のDICOM送信が実行中です' };
  sendStudyBusy = true;
  try {
    return await sendStudyImpl(args);
  } finally {
    sendStudyBusy = false;
  }
});

async function sendStudyImpl(args) {
  const started = Date.now();
  const cfg = settings.getAll().dicom;
  const host = (args.host || cfg.host || '').trim();
  const port = parseInt(args.port ?? cfg.port, 10);
  const calledAet = (args.calledAet || cfg.calledAet || '').trim();
  const callingAet = (args.callingAet || cfg.callingAet || 'SURGERY').trim();
  // 早期 return でも send.end を残す。ログに無いと「送信ボタンを押したのに何も起きない」原因が
  // 追えない（設定不完全・画像 0 枚など）。
  const earlyReturn = (error, count) => {
    const result = { ok: false, error };
    dicomLog.log('send.end', {
      host, port, calledAet, count, ...result,
      sent: 0, failed: count, indeterminate: false, ms: Date.now() - started,
    });
    return result;
  };
  if (!host || !port || !calledAet) return earlyReturn('DICOM接続先設定が不完全です', 0);

  const modality = args.modality || cfg.modality || 'OT';
  const charset = args.charset || cfg.charset || 'ISO_IR 100';
  const transferSyntax = args.transferSyntax || cfg.transferSyntax || '1.2.840.10008.1.2';

  const decodedImages = Array.isArray(args.decodedImages) ? args.decodedImages : [];
  if (decodedImages.length === 0) return earlyReturn('送信対象の画像がありません', 0);

  const patient = args.patient || {};
  const exam = args.exam || {};
  // バッチ送信に対応: 呼出側から studyUID/seriesUID/startInstanceNumber を渡すことで
  // 同じ Study に追加できる。指定なしなら新規生成（後方互換）。
  const studyUID = args.studyUID || generateUID();
  const seriesUID = args.seriesUID || generateUID();
  const startInstance = Number.isInteger(args.startInstanceNumber) && args.startInstanceNumber > 0
    ? args.startInstanceNumber : 1;
  const requestedSopUIDs = Array.isArray(args.sopUIDs) ? args.sopUIDs : [];
  const sopUIDs = decodedImages.map((_, i) => requestedSopUIDs[i] || generateUID());
  // InstanceNumber は呼出側がファイル単位で固定して渡す（再送でも同じ番号で送るため）。
  // 指定が無い要素だけ従来どおり startInstanceNumber からの連番にする（後方互換）。
  const requestedInstanceNumbers = Array.isArray(args.instanceNumbers) ? args.instanceNumbers : [];
  const instanceNumbers = decodedImages.map((_, i) => {
    const n = requestedInstanceNumbers[i];
    return Number.isInteger(n) && n > 0 ? n : startInstance + i;
  });
  const logFields = {
    host, port, calledAet, count: decodedImages.length,
    studyUID12: studyUID, seriesUID12: seriesUID, startInstanceNumber: startInstance,
    patientName: patient.name || patient.nameRomaji, patientId: patient.id,
  };
  dicomLog.log('send.start', logFields);

  let datasets;
  try {
    datasets = decodedImages.map((img, i) => buildDataset({
      patient, exam, studyUID, seriesUID,
      sopUID: sopUIDs[i],
      modality, charset,
      instanceNumber: instanceNumbers[i],
      width: img.width,
      height: img.height,
      rgb: new Uint8Array(img.rgb),
      transferSyntax,
    }));
  } catch (e) {
    const result = { ok: false, error: `dataset構築失敗: ${e?.message || e}`, studyUID, seriesUID };
    dicomLog.log('send.end', { ...logFields, ...result, sent: 0, failed: decodedImages.length, indeterminate: false, ms: Date.now() - started });
    return result;
  }

  // バッチごとに新規 association を張る。Study/Series UID は呼出側で固定される。
  const result = await runClient((client, settle, ctl) => {
    const { requests, constants } = dimse;
    let sent = 0;
    let lastError = null;
    let pending = datasets.length;
    const results = new Array(datasets.length);
    ctl.progress.results = results;
    ctl.progress.total = datasets.length;

    datasets.forEach((ds, index) => {
      const req = new requests.CStoreRequest(ds);
      req.on('response', (response) => {
        const status = response.getStatus();
        const ok = status === constants.Status.Success;
        results[index] = { index, ok, status, sopUID: sopUIDs[index], instanceNumber: instanceNumbers[index] };
        if (ok) sent++;
        else lastError = `C-STORE status=0x${status.toString(16)}`;
        ctl.progress.sent = sent;
        ctl.touch(); // 応答が来ている限りタイムアウトしない（遅い経路でも打ち切らない）
        if (--pending === 0) {
          // 部分成功は失敗として返す（ok は全件成功のときだけ）。
          // 呼出側が ok だけを見て「バッチ成功」と扱うと未送信分が失敗キューに残らず欠落するため。
          if (sent === datasets.length) ctl.settleAfterRelease({ ok: true, sent, failed: 0, results });
          else ctl.settleAfterRelease({ ok: false, sent, failed: datasets.length - sent, results, error: lastError || `C-STORE 部分失敗 (${sent}/${datasets.length})` });
        }
      });
      client.addRequest(req);
    });

    // dcmjs-dimse 自身の PDU タイムアウト（既定 60 秒）を伸ばす。ライブラリは「PDU を 1 つも受信しない時間」で
    // 接続を切るため、1 枚（最大 12MB）の送出に 60 秒超かかる遅い回線では、こちらの活動監視が順調と
    // 判定していてもライブラリ側で "Exceeded PDU timeout" になり画像が届かなかった（2026-10-08 の帯域制限
    // 模擬で実測）。本当に止まった場合は上の無応答（バイトが動かない）120 秒の監視で abort するので、
    // ライブラリ側は 10 分にしておく（ただし socket 側の 180 秒タイムアウトは残るので、1 PDU の書き込みが
    // 180 秒以上止まる回線はそちらで失敗する。上の readLiveActivity のコメント参照）。
    client.send(host, port, callingAet, calledAet, { pduTimeout: PDU_TIMEOUT_MS });
  }, 120000, 'send'); // 無進捗 120 秒でタイムアウト（総時間ではない。応答かバイトの進みが続く限り継続）。
  // 60 秒から延ばした理由: ソケットの進捗は Node の書き込みキューの減りでしか見えず、カーネルの送信
  // バッファ（macOS は net.inet.tcp.autosndbufmax=4MB まで自動拡張）に入った分は見えない。遅い回線ではその分が送られ切る
  // まで「進捗なし」に見えるため、30KB/s 級でも誤って打ち切らない余裕を持たせる。

  // networkError/timeout/abort では応答イベントが来ない画像がある。応答済みの結果を保ち、
  // 未応答だけを失敗にすることで、保存済み画像を再送対象へ混ぜない。
  const responseResults = Array.isArray(result.results) ? result.results : [];
  const byIndex = new Map(responseResults.filter(Boolean).map((it) => [it.index, it]));
  const results = datasets.map((_, index) => byIndex.get(index) || ({
    index, ok: false, status: null, sopUID: sopUIDs[index], instanceNumber: instanceNumbers[index],
    reason: result.error || 'no-response',
  }));
  const sent = results.filter((it) => it.ok).length;
  const finalResult = { ...result, ok: sent === datasets.length, sent, failed: datasets.length - sent, results, studyUID, seriesUID };
  dicomLog.log('send.end', {
    ...logFields, ...finalResult,
    indeterminate: !!finalResult.indeterminate,
    release: finalResult.release || null,
    ms: Date.now() - started,
  });
  return finalResult;
}

const hasFileLevelInfo = (rec) => Array.isArray(rec && rec.files) && rec.files.length > 0;
// 失敗キューの診断ログ。記録の検索（db.listPendingDicom）も含めて関数内の try/catch に閉じ込める。
// 引数側で検索すると呼出側の評価中に例外が出て、DB 更新や IPC の戻り値（=未送信の記録）まで
// 巻き込むため。診断ログの障害で本処理の結果を変えてはならない。
function findQueueRec(id) {
  try { return db.listPendingDicom().find((it) => it && it.id === id) || null; } catch (_) { return null; }
}
// preRec: 削除のように「実行後は検索できない」操作のため、実行前に控えた記録を渡せる。
function logQueue(event, id, preRec) {
  try {
    const rec = preRec || findQueueRec(id);
    if (!rec) return;
    dicomLog.log(event, {
      id: rec.id, dstPath: rec.dstPath || rec.dst_path,
      files: Array.isArray(rec.files) ? rec.files.length : 0,
      attempts: rec.attempts || 0,
      lastError: rec.lastError || rec.last_error || null,
      patientName: rec.patientName || rec.patient_name,
      patientId: rec.patientId || rec.patient_id,
    });
  } catch (e) {
    console.warn('DICOM queue log failed:', e);
  }
}

ipcMain.handle('dicom:queueFailure', async (_e, args = {}) => {
  if (!args.target || !args.patient) return { ok: false, error: 'invalid args' };
  // 同じフォルダの失敗記録への相乗り（dedup）は、記録の意味が完全に一致するときだけ行う。
  // フォルダが同じでも Study が違えば別の送信であり、混ぜると未送信の範囲が壊れる：
  //   - 旧レコード（files 無し）は「このフォルダ全体が未送信かもしれない」という意味。
  //     そこへファイル単位の失敗を merge すると、フォルダ全体という範囲が消えて
  //     未送信が黙って落ちる。
  //   - 別 Study の失敗を混ぜると、再送時に他 Study の SOP UID を持つ画像まで
  //     同じ Study へ送られ、PACS に重複登録され得る。
  // 一致しないものは既存レコードに触らず、新しいレコードを別に作る（キューに複数行
  // 並ぶが、レンダラ側の一覧・再送・削除はいずれも id 単位なので同じ dstPath でも扱える）。
  const sameFolder = db.listPendingDicom().filter(
    (it) => it && it.id != null && (it.dstPath || it.dst_path) === args.target
  );
  const incomingFiles = (Array.isArray(args.files) ? args.files : []).filter((f) => f && f.path);

  // 既存レコードの更新条件: 既存も今回もファイル単位、かつ同じ Study。
  // studyUID が取れなかった（IPC 例外等で main の応答が無い）ときは同一性を判断できないので
  // 相乗りしない。判断できないまま混ぜる方が、キューが1行増えるより危険。
  // Series も一致を要求する。同じ Study 内で別 Series の失敗を混ぜると、旧 Series の files が
  // 新しい seriesUID で再送され、受理済み SOP UID と属性が食い違う（PACS 上で重複・競合）。
  const mergeable = incomingFiles.length > 0 && args.studyUID && args.seriesUID
    ? sameFolder.find((it) => hasFileLevelInfo(it) && it.studyUID === args.studyUID && it.seriesUID === args.seriesUID)
    : null;
  if (mergeable) {
    const merged = new Map();
    for (const file of mergeable.files) if (file?.path) merged.set(file.path, file);
    for (const file of incomingFiles) merged.set(file.path, file);
    db.updatePendingDicom(mergeable.id, {
      attempts: (mergeable.attempts || 0) + 1,
      lastError: args.error || mergeable.lastError || mergeable.last_error || null,
      files: Array.from(merged.values()),
      // studyUID / seriesUID は一致が相乗りの条件なので上書きしない（同一性の基準を書き換えない）
      nextInstanceNumber: args.nextInstanceNumber,
      sentCount: args.sentCount,
      totalCount: args.totalCount,
    });
    logQueue('queue.update', mergeable.id);
    return { ok: true, deduped: true, id: mergeable.id };
  }

  // 旧レコード（フォルダ単位）どうしは従来どおり attempts を増やすだけ。
  // ファイル単位の情報を持たないので studyUID 等は触らない（触ると意味が壊れる）。
  if (incomingFiles.length === 0) {
    const folderRec = sameFolder.find((it) => !hasFileLevelInfo(it));
    if (folderRec) {
      db.updatePendingDicom(folderRec.id, {
        attempts: (folderRec.attempts || 0) + 1,
        lastError: args.error || folderRec.lastError || folderRec.last_error || null,
      });
      logQueue('queue.update', folderRec.id);
      return { ok: true, deduped: true, id: folderRec.id };
    }
  }

  const id = db.queueDicom({
    dstPath: args.target,
    patientId: args.patient.id || '',
    patientName: args.patient.nameRomaji || args.patient.name || '',
    procedure: args.patient.procedure || '',
    studyDate: args.patient.date || '',
    // path を持たない要素は再送に使えないので落とす。全部落ちたら files 無し
    // （＝フォルダ全体が未送信かもしれない）の記録として残す方が安全側。
    files: incomingFiles.length > 0 ? incomingFiles : undefined,
    studyUID: args.studyUID,
    seriesUID: args.seriesUID,
    nextInstanceNumber: args.nextInstanceNumber,
    sentCount: args.sentCount,
    totalCount: args.totalCount,
    lastError: args.error || null,
  });
  logQueue('queue.add', id);
  return { ok: true, id };
});

ipcMain.handle('dicom:updatePending', async (_e, args = {}) => {
  if (!Number.isInteger(args.id)) return { ok: false, error: 'invalid id' };
  const allowed = {};
  for (const key of ['files', 'studyUID', 'seriesUID', 'nextInstanceNumber', 'sentCount', 'totalCount', 'attempts', 'lastError']) {
    if (args[key] !== undefined) allowed[key] = args[key];
  }
  db.updatePendingDicom(args.id, allowed);
  logQueue('queue.update', args.id);
  return { ok: true, id: args.id };
});

ipcMain.handle('dicom:listPending', async () => {
  return { ok: true, items: db.listPendingDicom() };
});

// 再送成功時・ユーザー操作でキューから削除する
ipcMain.handle('dicom:removePending', async (_e, args = {}) => {
  const id = args.id;
  if (!Number.isInteger(id)) return { ok: false, error: 'invalid id' };
  const rec = findQueueRec(id); // 削除後は検索できないので先に控える（失敗してもログが無いだけ）
  db.updatePendingDicom(id, { remove: true });
  logQueue('queue.remove', id, rec);
  return { ok: true };
});

ipcMain.handle('dicom:logLine', async (_e, args = {}) => {
  if (typeof args.text !== 'string' || !['ok', 'warn', 'err'].includes(args.level)) return { ok: false };
  // レンダラは定型文だけを送る。main 側も自由文を受け取らず患者情報の混入を防ぐ。
  if (!/^(?:送信開始: \d+ 枚|送信成功: \d+ 枚|送信失敗: \d+ 枚|コピー完了に続けて自動送信を開始します)$/.test(args.text)) return { ok: false };
  dicomLog.log('ui', { level: args.level, text: args.text.slice(0, 200) });
  return { ok: true };
});

module.exports = { generateUID, sendStudyImpl, runClient };
