'use strict';

// www/js/dicom-retry.js の純関数ヘルパのユニットテスト。
// DOM/Electron 環境に依存しない純関数のみを扱うので node:test だけで完結させる。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collectFailures,
  buildAttemptedFiles,
  mergeQueueFiles,
  nextInstanceNumberAfter,
  assignInstanceNumbers,
  generateSopUID,
} = require('../www/js/dicom-retry.js');

test('collectFailures: decode失敗・ステータス失敗・無応答をfiles順に集める', () => {
  const files = [
    { path: '/a.jpg', name: 'a.jpg' },
    { path: '/b.jpg', name: 'b.jpg' },
    { path: '/c.jpg', name: 'c.jpg' },
    { path: '/d.jpg', name: 'd.jpg' },
    { path: '/e.jpg', name: 'e.jpg' },
  ];
  const decodeFailedIdx = [1]; // b がデコード失敗
  const batchResults = [
    {
      indices: [0, 2, 3, 4], // files[2]=c はデコード対象外だが送信バッチには含まれる
      results: [
        { index: 0, ok: true, sopUID: 's0' }, // indices[0]=0 -> files[0]=a は成功
        { index: 1, ok: false, status: 0xa700, sopUID: 's2' }, // indices[1]=2 -> files[2]=c は失敗
        { index: 3, ok: true, sopUID: 's4' }, // indices[3]=4 -> files[4]=e は成功
        // indices[2]=3 に対応する結果が無い -> files[3]=d は無応答扱い
      ],
    },
  ];

  const failures = collectFailures(files, decodeFailedIdx, batchResults);

  assert.equal(failures.length, 3);

  assert.equal(failures[0].path, '/b.jpg');
  assert.equal(failures[0].reason, 'decode');
  assert.equal(failures[0].sopUID, null);

  assert.equal(failures[1].path, '/c.jpg');
  assert.equal(failures[1].reason, 'status=0xa700');
  assert.equal(failures[1].sopUID, 's2');

  assert.equal(failures[2].path, '/d.jpg');
  assert.equal(failures[2].reason, 'no-response');
});

test('collectFailures: filesのinstanceNumberを失敗レコードへ透過させる', () => {
  // 再送で InstanceNumber が変わらないこと（H2）を保証する。
  const files = [
    { path: '/a.jpg', name: 'a.jpg', sopUID: 's0', instanceNumber: 11 }, // 成功
    { path: '/b.jpg', name: 'b.jpg', sopUID: 's1', instanceNumber: 12 }, // decode失敗
    { path: '/c.jpg', name: 'c.jpg', sopUID: 's2', instanceNumber: 13 }, // status失敗
    { path: '/d.jpg', name: 'd.jpg', sopUID: 's3', instanceNumber: 14 }, // 無応答
    { path: '/e.jpg', name: 'e.jpg', sopUID: 's4' },                     // 番号なし（旧レコード由来）
  ];
  const batchResults = [
    {
      indices: [0, 2, 3, 4],
      results: [
        { index: 0, ok: true, sopUID: 's0', instanceNumber: 11 },
        { index: 1, ok: false, status: 0xa700, sopUID: 's2', instanceNumber: 13 },
        // indices[2]=3 は応答なし
        { index: 3, ok: false, status: 0xa700, sopUID: 's4', instanceNumber: 21 }, // main からの番号のみ
      ],
    },
  ];

  const failures = collectFailures(files, [1], batchResults);
  const byPath = Object.fromEntries(failures.map((f) => [f.path, f]));

  assert.equal(failures.length, 4);
  assert.equal(byPath['/b.jpg'].instanceNumber, 12); // decode失敗でも番号を捨てない
  assert.equal(byPath['/b.jpg'].reason, 'decode');
  assert.equal(byPath['/c.jpg'].instanceNumber, 13);
  assert.equal(byPath['/d.jpg'].instanceNumber, 14); // 無応答でも番号を捨てない
  assert.equal(byPath['/e.jpg'].instanceNumber, 21); // files に無ければ main の結果から拾う
});

test('collectFailures: instanceNumberがどこにも無ければnull（0や負値も採らない）', () => {
  const files = [
    { path: '/a.jpg', name: 'a.jpg' },
    { path: '/b.jpg', name: 'b.jpg', instanceNumber: 0 },
  ];
  const failures = collectFailures(files, [], [{ indices: [0, 1], results: [] }]);
  assert.equal(failures.length, 2);
  assert.equal(failures[0].instanceNumber, null);
  assert.equal(failures[1].instanceNumber, null);
});

test('buildAttemptedFiles: mainが実際に使った sopUID / instanceNumber を最優先する', () => {
  // レンダラ側で UID を採番できなかった（generateSopUID が null）ファイルは main が採番して
  // 送っている。null のまま記録すると再送で別 UID になり PACS に重複登録されるため、
  // main の results の値を必ず拾う。
  const files = [
    { path: '/a.jpg', name: 'a.jpg' },
    { path: '/b.jpg', name: 'b.jpg' },
    { path: '/c.jpg', name: 'c.jpg' },
  ];
  const sopUIDs = [null, 'renderer-b', null];   // a と c はレンダラで採番できなかった
  const instanceNumbers = [1, 2, 3];
  const batchResults = [
    {
      indices: [0, 1, 2],
      results: [
        { index: 0, ok: true, sopUID: 'main-a', instanceNumber: 1 },
        { index: 1, ok: false, status: 0xa700, sopUID: 'renderer-b', instanceNumber: 2 },
        // indices[2]=2（c）は応答なし → レンダラ側の値にフォールバック
      ],
    },
  ];

  const attempted = buildAttemptedFiles(files, sopUIDs, instanceNumbers, batchResults);

  assert.equal(attempted.length, 3);
  assert.equal(attempted[0].sopUID, 'main-a'); // レンダラが null でも main の UID が入る
  assert.equal(attempted[0].instanceNumber, 1);
  assert.equal(attempted[1].sopUID, 'renderer-b');
  assert.equal(attempted[2].sopUID, null);     // 応答が無ければ採番できていないので null
  assert.equal(attempted[2].instanceNumber, 3);
  assert.equal(attempted[2].name, 'c.jpg');
});

test('buildAttemptedFiles: main が別の instanceNumber を使っていればその値を採る', () => {
  const files = [{ path: '/a.jpg', name: 'a.jpg', instanceNumber: 4, sopUID: 'old-a' }];
  const batchResults = [
    { indices: [0], results: [{ index: 0, ok: false, status: 0xa700, sopUID: 'main-a', instanceNumber: 9 }] },
  ];
  const attempted = buildAttemptedFiles(files, ['old-a'], [4], batchResults);
  assert.equal(attempted[0].sopUID, 'main-a');
  assert.equal(attempted[0].instanceNumber, 9); // 実際に送られた番号を記録する
});

test('buildAttemptedFiles: デコード失敗でバッチ内の位置がずれても indices で対応づく', () => {
  const files = [
    { path: '/a.jpg', name: 'a.jpg' },
    { path: '/b.jpg', name: 'b.jpg' }, // デコード失敗 → 送信バッチに含まれない
    { path: '/c.jpg', name: 'c.jpg' },
  ];
  const batchResults = [
    {
      indices: [0, 2], // decodedImages[1] は files[2]
      results: [
        { index: 0, ok: true, sopUID: 'main-a', instanceNumber: 1 },
        { index: 1, ok: true, sopUID: 'main-c', instanceNumber: 3 },
      ],
    },
  ];
  const attempted = buildAttemptedFiles(files, [null, null, null], [1, 2, 3], batchResults);
  assert.equal(attempted[0].sopUID, 'main-a');
  assert.equal(attempted[1].sopUID, null); // デコード失敗の b は送られていない
  assert.equal(attempted[1].instanceNumber, 2);
  assert.equal(attempted[2].sopUID, 'main-c');
  assert.equal(attempted[2].instanceNumber, 3);
});

test('buildAttemptedFiles: 空・欠損入力でも落ちない', () => {
  assert.deepEqual(buildAttemptedFiles(null, null, null, null), []);
  const attempted = buildAttemptedFiles([{ path: '/a.jpg', name: 'a.jpg' }], null, null, [
    { indices: [0], results: [null] }, // 応答が埋まらなかった穴
  ]);
  assert.equal(attempted.length, 1);
  assert.equal(attempted[0].sopUID, null);
  assert.equal(attempted[0].instanceNumber, null);
});

test('buildAttemptedFiles の出力を collectFailures に渡すと main の値が失敗レコードに載る', () => {
  // runSend と同じ経路（attemptedFiles → collectFailures）を通し、優先順位が保たれることを確認する。
  const files = [{ path: '/a.jpg', name: 'a.jpg' }];
  const batchResults = [
    { indices: [0], results: [{ index: 0, ok: false, status: 0xa700, sopUID: 'main-a', instanceNumber: 7 }] },
  ];
  const attempted = buildAttemptedFiles(files, [null], [1], batchResults);
  const failures = collectFailures(attempted, [], batchResults);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].sopUID, 'main-a');
  assert.equal(failures[0].instanceNumber, 7);
  assert.equal(failures[0].reason, 'status=0xa700');
});

test('assignInstanceNumbers: 既存番号は再利用し、新規だけカーソルから採番する', () => {
  const files = [
    { path: '/a.jpg', instanceNumber: 3 }, // 再送分（前回の番号を維持）
    { path: '/b.jpg' },                    // 新規
    { path: '/c.jpg', instanceNumber: 5 }, // 再送分
    { path: '/d.jpg' },                    // 新規
  ];
  const r = assignInstanceNumbers(files, 7);
  assert.deepEqual(r.instanceNumbers, [3, 7, 5, 8]);
  assert.equal(r.nextInstanceNumber, 9);
});

test('assignInstanceNumbers: 再利用した番号以下には新規採番しない（番号衝突の防止）', () => {
  const files = [
    { path: '/a.jpg', instanceNumber: 10 },
    { path: '/b.jpg' },
    { path: '/c.jpg' },
  ];
  const r = assignInstanceNumbers(files, 2); // カーソルが古くても 10 とは衝突しない
  assert.deepEqual(r.instanceNumbers, [10, 11, 12]);
  assert.equal(r.nextInstanceNumber, 13);
});

test('assignInstanceNumbers: 後ろにある既存番号とも衝突しない（二段階走査）', () => {
  // 先頭から1パスで採番すると [10, 11, 11] になり、files[1] と files[2] が同じ番号になる。
  const files = [
    { path: '/a.jpg', instanceNumber: 10 },
    { path: '/b.jpg' },                     // 新規
    { path: '/c.jpg', instanceNumber: 11 }, // 後ろにある既存番号
  ];
  const r = assignInstanceNumbers(files, 2);
  assert.deepEqual(r.instanceNumbers, [10, 12, 11]);
  assert.equal(r.nextInstanceNumber, 13);
  assert.deepEqual(r.duplicates, []);

  // 採番した番号が Series 内で一意であること（衝突の直接検査）
  assert.equal(new Set(r.instanceNumbers).size, r.instanceNumbers.length);
});

test('assignInstanceNumbers: 既存番号どうしの重複を duplicates で返す', () => {
  const files = [
    { path: '/a.jpg', instanceNumber: 5 },
    { path: '/b.jpg', instanceNumber: 5 }, // 記録済みデータが壊れている
    { path: '/c.jpg', instanceNumber: 5 }, // 3回目は duplicates に重ねて入れない
    { path: '/d.jpg', instanceNumber: 7 },
    { path: '/e.jpg' },
  ];
  const r = assignInstanceNumbers(files, 1);
  assert.deepEqual(r.duplicates, [5]);
  // 呼出側が中止を選べるよう、番号自体は自動で振り直さない（既存はそのまま返す）
  assert.deepEqual(r.instanceNumbers, [5, 5, 5, 7, 8]);
  assert.equal(r.nextInstanceNumber, 9);
});

test('assignInstanceNumbers: 重複が無ければ duplicates は空', () => {
  const r = assignInstanceNumbers([{ path: '/a.jpg', instanceNumber: 3 }, { path: '/b.jpg' }], 1);
  assert.deepEqual(r.duplicates, []);
});

test('assignInstanceNumbers: 番号なし・不正な開始値は1から連番、空配列も許容', () => {
  const r = assignInstanceNumbers(
    [{ path: '/a.jpg' }, { path: '/b.jpg', instanceNumber: 0 }, { path: '/c.jpg', instanceNumber: -2 }],
    undefined,
  );
  assert.deepEqual(r.instanceNumbers, [1, 2, 3]);
  assert.equal(r.nextInstanceNumber, 4);

  const empty = assignInstanceNumbers(null, 5);
  assert.deepEqual(empty.instanceNumbers, []);
  assert.equal(empty.nextInstanceNumber, 5);
});

test('assignInstanceNumbers: 同じfilesを再度渡しても番号が変わらない（再送の冪等性）', () => {
  const first = assignInstanceNumbers([{ path: '/a.jpg' }, { path: '/b.jpg' }], 1);
  const withNumbers = [
    { path: '/a.jpg', instanceNumber: first.instanceNumbers[0] },
    { path: '/b.jpg', instanceNumber: first.instanceNumbers[1] },
  ];
  const second = assignInstanceNumbers(withNumbers, first.nextInstanceNumber);
  assert.deepEqual(second.instanceNumbers, first.instanceNumbers);
  assert.equal(second.nextInstanceNumber, first.nextInstanceNumber);
});

test('mergeQueueFiles: pathで和集合を取り、同じpathは新しい方で置換する', () => {
  const existing = [
    { path: '/a.jpg', name: 'a.jpg', v: 1 },
    { path: '/b.jpg', name: 'b.jpg', v: 1 },
  ];
  const incoming = [
    { path: '/b.jpg', name: 'b.jpg', v: 2 },
    { path: '/c.jpg', name: 'c.jpg', v: 1 },
  ];

  const merged = mergeQueueFiles(existing, incoming);
  const byPath = Object.fromEntries(merged.map((f) => [f.path, f]));

  assert.equal(merged.length, 3);
  assert.equal(byPath['/a.jpg'].v, 1);
  assert.equal(byPath['/b.jpg'].v, 2); // 新しい方で置換されている
  assert.equal(byPath['/c.jpg'].v, 1);
});

test('mergeQueueFiles: null/非配列を許容する', () => {
  assert.deepEqual(mergeQueueFiles(null, undefined), []);
  assert.deepEqual(mergeQueueFiles(undefined, null), []);

  const existing = [{ path: '/a.jpg', name: 'a.jpg' }];
  const merged = mergeQueueFiles(existing, 'not-an-array');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].path, '/a.jpg');
});

test('nextInstanceNumberAfter: 開始番号+件数、既定値、負の件数の丸め', () => {
  assert.equal(nextInstanceNumberAfter(5, 3), 8);
  assert.equal(nextInstanceNumberAfter(undefined, 2), 3);
  assert.equal(nextInstanceNumberAfter(1, -1), 1);
});

test('generateSopUID: "2.25."始まり・数字のみ・64文字以内・呼ぶたびに異なる', () => {
  const uid1 = generateSopUID();
  const uid2 = generateSopUID();

  assert.ok(uid1, 'uid1 が生成されること');
  assert.ok(uid1.startsWith('2.25.'));
  assert.ok(uid1.length <= 64);
  assert.match(uid1.slice('2.25.'.length), /^[0-9]+$/);

  assert.notEqual(uid1, uid2);
});

test('generateSopUID: getRandomValuesが無ければnullを返す', () => {
  assert.equal(generateSopUID({}), null);
});
