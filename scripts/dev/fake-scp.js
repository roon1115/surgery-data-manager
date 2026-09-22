'use strict';

// 開発用の疑似 PACS（DICOM SCP）。
// 再送機能の手動検証用に C-ECHO / C-STORE を受けるだけの最小サーバで、画像の永続化は行わない。
// 受理した SOP Instance UID を標準出力に1行ずつ出すので、実際の送信ログと突き合わせて
// 「何枚届いたか」「同じ画像を二重に送っていないか」を目視で確認できる。
//
// 使い方:
//   PORT=11112 MODE=ok node scripts/dev/fake-scp.js
//   PORT=11112 MODE=fail-nth N=3 node scripts/dev/fake-scp.js   # 3枚目ごとに 0xA700 で失敗させる
//   PORT=11112 MODE=hang-after N=3 node scripts/dev/fake-scp.js # 最初の association で3枚受理後、応答を止める（回線切断を模す）
//
// 出力フォーマット（1行1イベント）:
//   STORE <sopUID> <instanceNumber>  正常受理
//   DUP   <sopUID> <instanceNumber>  同じ SOP UID を2度受理（再送の重複検証用）
//   FAIL  <sopUID>                   fail-nth で失敗ステータスを返した
//   HANG  <sopUID>                   hang-after で応答を返さず放置した

const dcmjsDimse = require('dcmjs-dimse');
const { Server, Scp } = dcmjsDimse;
const { CEchoResponse, CStoreResponse } = dcmjsDimse.responses;
const { PresentationContextResult, TransferSyntax, Status } = dcmjsDimse.constants;

const PORT = Number(process.env.PORT) || 11112;
const MODE = process.env.MODE || 'ok'; // 'ok' | 'fail-nth' | 'hang-after'
const N = Number(process.env.N) || 3;

// プロセス寿命の間だけ保持するサーバ全体の状態。
// 疑似 PACS は1プロセス=1台のサーバとして振る舞うので、association をまたいでも共有する。
const seenSopUIDs = new Set(); // 正常に受理済みの SOP UID（再送での重複検知用）
let storeCounter = 0; // fail-nth: 受理した C-STORE の通し番号（1始まり）
let associationCount = 0; // hang-after: 何本目の association か（1本目だけ詰まらせて回線切断を模す）

class FakeScp extends Scp {
  constructor(socket, opts) {
    super(socket, opts);
    this.associationIndex = 0;
    this.storesInThisAssociation = 0;
  }

  // 全 presentation context を Implicit/Explicit VR LE で受理する（SOP Class は問わない）。
  // 疑似 PACS なので実運用のような abstract syntax の絞り込みはしない。
  associationRequested(association) {
    associationCount += 1;
    this.associationIndex = associationCount;

    const contexts = association.getPresentationContexts();
    contexts.forEach((c) => {
      const context = association.getPresentationContext(c.id);
      const transferSyntaxes = context.getTransferSyntaxUids();
      let accepted = false;
      transferSyntaxes.forEach((transferSyntax) => {
        if (
          transferSyntax === TransferSyntax.ImplicitVRLittleEndian ||
          transferSyntax === TransferSyntax.ExplicitVRLittleEndian
        ) {
          context.setResult(PresentationContextResult.Accept, transferSyntax);
          accepted = true;
        }
      });
      if (!accepted) {
        context.setResult(PresentationContextResult.RejectTransferSyntaxesNotSupported);
      }
    });

    this.sendAssociationAccept();
  }

  cEchoRequest(request, callback) {
    const response = CEchoResponse.fromRequest(request);
    response.setStatus(Status.Success);
    callback(response);
  }

  cStoreRequest(request, callback) {
    const dataset = request.getDataset();
    const sopUID = dataset ? dataset.getElement('SOPInstanceUID') : undefined;
    const instanceNumber = dataset ? dataset.getElement('InstanceNumber') : undefined;

    // hang-after: 最初の association に限り、N 枚受理した後は callback を呼ばずに放置する。
    // クライアント側は無進捗タイムアウトで失敗扱いになる（＝回線が途中で切れた状況の再現）。
    // 2本目以降の association（＝再送時の再接続）は通常どおり応答する（回線復旧を模す）。
    if (MODE === 'hang-after' && this.associationIndex === 1 && this.storesInThisAssociation >= N) {
      console.log(`HANG ${sopUID}`);
      return;
    }

    // fail-nth: 重複かどうかに関わらず、受理した通し番号が N の倍数のときだけ失敗を返す。
    if (MODE === 'fail-nth') {
      storeCounter += 1;
      if (storeCounter % N === 0) {
        console.log(`FAIL ${sopUID}`);
        const response = CStoreResponse.fromRequest(request);
        response.setStatus(0xa700); // Refused: Out of Resources 相当を模した失敗ステータス
        callback(response);
        return;
      }
    }

    if (sopUID && seenSopUIDs.has(sopUID)) {
      console.log(`DUP ${sopUID} ${instanceNumber}`);
    } else {
      if (sopUID) seenSopUIDs.add(sopUID);
      console.log(`STORE ${sopUID} ${instanceNumber}`);
    }
    this.storesInThisAssociation += 1;

    const response = CStoreResponse.fromRequest(request);
    response.setStatus(Status.Success);
    callback(response);
  }

  associationReleaseRequested() {
    this.sendAssociationReleaseResponse();
  }
}

const server = new Server(FakeScp);
server.on('networkError', (e) => {
  console.error('Network error:', e);
});
server.listen(PORT);
console.log(`fake-scp listening on port ${PORT} (MODE=${MODE}, N=${N})`);
