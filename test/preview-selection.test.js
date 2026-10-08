'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = { window: { Views: {}, U: {} } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../www/js/views/preview.js'), 'utf8'), context);
const { defaultSelection, applyPreviewDefault, isCameraManagementFile } = context.window.Views.preview;

const MEDIA = ['surgicalPhoto', 'laparoscope', 'bronchoscope', 'endoscope'];

test('カメラの管理ファイルを判定する（ファイル名・拡張子・フォルダ）', () => {
  const mgmt = [
    'CONTENTS.CPS', 'contents.xml', 'FILEINFO.TBL', 'GROUPINF.DAT', 'groupinf.bin',
    'DCIM/100CANON/IMG_0001.THM', 'a.ctg', 'BDMV/INDEX.BDM', 'b.mpl', 'c.cpi', 'x.tbl', 'y.b00', 'z.d00',
    'MISC/AUTPRINT.MRK', 'misc/sub/anything.txt',
    'AVCHD/BDMV/PLAYLIST/00000.MPL', 'PRIVATE/AVCHD/BDMV/INDEX.BDM',
    'PRIVATE/M4ROOT/CLIP/C0001M01.XML', 'PRIVATE/AVCHD/ACVC/DEFAULT/CAMCORD.BIN',
  ];
  for (const relPath of mgmt) assert.equal(isCameraManagementFile({ relPath, path: '/Volumes/SD/' + relPath }), true, relPath);
});

test('写真・動画・RAW・内視鏡の録画ファイルは管理ファイル扱いにしない', () => {
  const media = [
    'DCIM/100CANON/IMG_0001.JPG', 'IMG_0002.CR2', 'IMG_0003.CR3', 'a.nef', 'a.arw', 'a.dng', 'a.orf', 'a.rw2', 'a.raf',
    'rec/case1.mpg', 'rec/case1.ts', 'rec/case1.m2ts', 'rec/00001.dcm', 'MOV_0001.MP4', 'x.heic', 'notes.csv',
    // AVCHD/PRIVATE 配下でも映像本体（.MTS）は対象。XML 等だけが管理ファイル
    'AVCHD/BDMV/STREAM/00000.MTS', 'PRIVATE/M4ROOT/CLIP/C0001.MP4',
    // 管理ファイル用フォルダ名でなければ .xml 等は通常ファイル
    'reports/summary.xml', 'data/file.bin',
  ];
  for (const relPath of media) assert.equal(isCameraManagementFile({ relPath }), false, relPath);
});

test('相対パスが無い時は名前だけで判定し、絶対パスの private を PRIVATE/ と取り違えない', () => {
  assert.equal(isCameraManagementFile({ path: '/private/var/data/file.xml' }), false);
  assert.equal(isCameraManagementFile({ path: '/private/var/data/CONTENTS.CPS' }), true);
  assert.equal(isCameraManagementFile({ relPath: 'CAM/a.xml', path: '/private/CAM/a.xml' }), false);
  assert.equal(isCameraManagementFile({}), false);
});

test('写真系の種別では管理ファイルだけ既定で外し、それ以外は（kind 不問で）選択する', () => {
  for (const type of MEDIA) {
    for (const relPath of ['a.jpg', 'a.mpg', 'a.cr3', 'a.dcm', 'a.mts']) {
      assert.equal(defaultSelection(type, { relPath, kind: 'other' }), true, `${type}/${relPath}`);
      // 重複チェックが先に true にしていても結果は同じ
      assert.equal(defaultSelection(type, { relPath, selected: true }), true);
    }
    // 重複チェックが先に true にしていても、管理ファイルはプレビューで外す。
    assert.equal(defaultSelection(type, { relPath: 'CONTENTS.CPS', selected: true }), false, type);
  }
});

test('麻酔記録は全種類を従来どおり選択し、種別変更時は外した分だけ戻す', () => {
  for (const relPath of ['a.csv', 'CONTENTS.CPS', 'a.thm']) {
    assert.equal(defaultSelection('anesthesia', { relPath }), true);
  }
  assert.equal(defaultSelection('anesthesia', { relPath: 'a.csv', selected: false }), false);
  assert.equal(defaultSelection('anesthesia', { relPath: 'a.thm', selected: false, previewDefaultExcluded: true }), true);
  assert.equal(defaultSelection('anesthesia', { relPath: 'a.thm', selected: false, previewDefaultExcluded: true, alreadyImported: true }), false);
  assert.equal(defaultSelection('surgicalPhoto', { relPath: 'a.jpg', selected: false }), false);
});

test('個別の手動選択を上書きせず autoDeselected も付けない', () => {
  const selected = { relPath: 'a.thm', selected: true, manualSelection: true };
  const unselected = { relPath: 'a.jpg', selected: false, manualSelection: true };
  assert.equal(defaultSelection('surgicalPhoto', selected), true);
  assert.equal(defaultSelection('surgicalPhoto', unselected), false);
  assert.equal(defaultSelection('surgicalPhoto', { relPath: 'a.thm' }), false);
  assert.deepEqual(selected, { relPath: 'a.thm', selected: true, manualSelection: true });
  assert.equal(Object.hasOwn(selected, 'autoDeselected'), false);
});

test('既定の適用はファイルごとに 1 回だけ（再描画で選び直しを巻き戻さない）', () => {
  const mgmt = { relPath: 'CONTENTS.CPS' };
  const photo = { relPath: 'a.jpg' };
  applyPreviewDefault('surgicalPhoto', mgmt);
  applyPreviewDefault('surgicalPhoto', photo);
  assert.equal(mgmt.selected, false);
  assert.equal(photo.selected, true);
  assert.equal(mgmt.previewDefaultApplied, true);
  // 「全選択」「全解除」相当の操作（manualSelection は立てない）
  mgmt.selected = true;
  photo.selected = false;
  applyPreviewDefault('surgicalPhoto', mgmt); // render の再実行
  applyPreviewDefault('surgicalPhoto', photo);
  assert.equal(mgmt.selected, true);
  assert.equal(photo.selected, false);
});

test('種別が変わった時だけ新しい種別の既定を 1 回適用し直す', () => {
  const f = { relPath: 'a.thm' };
  applyPreviewDefault('surgicalPhoto', f);
  assert.equal(f.selected, false);
  assert.equal(f.previewDefaultExcluded, true);
  applyPreviewDefault('anesthesia', f);
  assert.equal(f.selected, true);
  assert.equal(f.previewDefaultExcluded, false);
  f.selected = false;
  applyPreviewDefault('anesthesia', f);
  assert.equal(f.selected, false);
});
