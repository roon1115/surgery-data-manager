#!/usr/bin/env python3
"""Surgery Data Manager 画像入りマニュアル PDF を生成

使い方:
  1. スクショ再撮影:  SDM_SCREENSHOT=1 npx electron .   (→ /tmp/sdm-screenshots)
  2. PDF生成:        <venv>/bin/python scripts/build_manual_pdf.py
  出力: dist/画像転送マニュアル.pdf

VERSION / PUB_DATE はアプリのバージョンに合わせて更新すること。
"""
import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Image,
    Table, TableStyle,
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

pdfmetrics.registerFont(UnicodeCIDFont('HeiseiMin-W3'))
pdfmetrics.registerFont(UnicodeCIDFont('HeiseiKakuGo-W5'))

JP_FONT = 'HeiseiKakuGo-W5'
JP_FONT_MIN = 'HeiseiMin-W3'

SHOT_DIR = '/tmp/sdm-screenshots'
OUTPUT_PDF = '/Users/macbookns/Dropbox/Manus-Claude/手術データ管理アプリ/dist/画像転送マニュアル.pdf'
VERSION = 'v0.3.14'
PUB_DATE = '2026-06-01'

styles = getSampleStyleSheet()
style_title = ParagraphStyle('JPTitle', parent=styles['Title'], fontName=JP_FONT, fontSize=24,
    leading=30, alignment=TA_CENTER, spaceAfter=12, textColor=colors.HexColor('#0f172a'))
style_subtitle = ParagraphStyle('JPSubtitle', parent=styles['Normal'], fontName=JP_FONT_MIN, fontSize=11,
    leading=16, alignment=TA_CENTER, spaceAfter=4, textColor=colors.HexColor('#475569'))
style_h1 = ParagraphStyle('JPH1', parent=styles['Heading1'], fontName=JP_FONT, fontSize=18,
    leading=24, spaceBefore=12, spaceAfter=8, textColor=colors.HexColor('#0ea5e9'))
style_h2 = ParagraphStyle('JPH2', parent=styles['Heading2'], fontName=JP_FONT, fontSize=14,
    leading=20, spaceBefore=10, spaceAfter=6, textColor=colors.HexColor('#0f172a'))
style_body = ParagraphStyle('JPBody', parent=styles['Normal'], fontName=JP_FONT_MIN, fontSize=10,
    leading=16, alignment=TA_LEFT, spaceAfter=6)
style_code = ParagraphStyle('JPCode', parent=styles['Code'], fontName='Courier', fontSize=9,
    leading=12, leftIndent=10, backColor=colors.HexColor('#f1f5f9'),
    borderColor=colors.HexColor('#cbd5e1'), borderWidth=0.5, borderPadding=4, spaceAfter=8)
style_caption = ParagraphStyle('JPCaption', parent=styles['Italic'], fontName=JP_FONT_MIN, fontSize=8,
    leading=11, alignment=TA_CENTER, spaceAfter=10, textColor=colors.HexColor('#64748b'))
style_step = ParagraphStyle('JPStep', parent=styles['Normal'], fontName=JP_FONT, fontSize=12,
    leading=18, spaceBefore=8, spaceAfter=4, textColor=colors.HexColor('#0ea5e9'))
style_note = ParagraphStyle('JPNote', parent=styles['Normal'], fontName=JP_FONT_MIN, fontSize=9,
    leading=13, leftIndent=8, textColor=colors.HexColor('#475569'),
    backColor=colors.HexColor('#fef3c7'), borderPadding=6, borderColor=colors.HexColor('#fcd34d'),
    borderWidth=0.5, spaceAfter=8)


def add_image(story, path, caption, max_width=160 * mm):
    from PIL import Image as PILImage
    img = PILImage.open(path)
    w, h = img.size
    aspect = h / w
    new_w = max_width
    new_h = max_width * aspect
    if new_h > 200 * mm:
        new_h = 200 * mm
        new_w = new_h / aspect
    story.append(Image(path, width=new_w, height=new_h))
    story.append(Paragraph(caption, style_caption))


def make_table(data, col_widths=None):
    t = Table(data, colWidths=col_widths)
    t.setStyle(TableStyle([
        ('FONT', (0, 0), (-1, -1), JP_FONT_MIN, 9),
        ('FONT', (0, 0), (-1, 0), JP_FONT, 9),
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#e2e8f0')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.HexColor('#0f172a')),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#cbd5e1')),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
    ]))
    return t


def build_pdf():
    doc = SimpleDocTemplate(
        OUTPUT_PDF, pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm,
        topMargin=18 * mm, bottomMargin=18 * mm,
        title='Surgery Data Manager 画像転送マニュアル',
        author='Stella Animal Hospital',
    )
    story = []

    # ========= カバー =========
    story.append(Spacer(1, 40 * mm))
    story.append(Paragraph('Surgery Data Manager', style_title))
    story.append(Paragraph('画像転送マニュアル', style_title))
    story.append(Spacer(1, 8 * mm))
    story.append(Paragraph('手術データ（写真・動画・麻酔記録）の取り込みと DICOM 送信', style_subtitle))
    story.append(Spacer(1, 30 * mm))
    story.append(Paragraph('ステラどうぶつ病院', style_subtitle))
    story.append(Spacer(1, 4 * mm))
    story.append(Paragraph(f'バージョン {VERSION}　／　{PUB_DATE}', style_subtitle))
    story.append(PageBreak())

    # ========= 目次 =========
    story.append(Paragraph('目次', style_h1))
    toc = [
        ['1', '取り扱うデータ種別'],
        ['2', '初回セットアップ（設定画面）'],
        ['3', '日常の操作フロー（6ステップ）'],
        ['4', '同じ症例で複数の SD カードを使うとき'],
        ['5', 'コピー完了後のデバイス取り外し'],
        ['6', 'コピーの中断'],
        ['7', 'フォルダ構造の例'],
        ['8', 'マニュアル / アップデートの開き方'],
        ['9', 'トラブルシューティング'],
        ['10', 'データ保存場所 / DICOM 仕様'],
    ]
    t = Table(toc, colWidths=[15 * mm, 145 * mm])
    t.setStyle(TableStyle([
        ('FONT', (0, 0), (-1, -1), JP_FONT_MIN, 11),
        ('FONT', (1, 0), (1, -1), JP_FONT, 11),
        ('ALIGN', (0, 0), (0, -1), 'RIGHT'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('LINEBELOW', (0, 0), (-1, -1), 0.3, colors.HexColor('#e2e8f0')),
    ]))
    story.append(t)
    story.append(PageBreak())

    # ========= 1. データ種別 =========
    story.append(Paragraph('1. 取り扱うデータ種別', style_h1))
    story.append(Paragraph(
        '本アプリは手術中に発生する以下の 5 種別のデータを、SD カード等から院内 NAS と DICOM サーバーへ転送します。'
        '使わない種別は設定で OFF にできます。',
        style_body))
    types_data = [
        ['種別', '主なファイル', 'DICOM 送信'],
        ['手術写真', 'JPG / PNG / HEIC', '◯（自動候補）'],
        ['麻酔モニター記録', 'CSV / TSV', '×'],
        ['腹腔鏡', 'MP4 / MOV / JPG', '×'],
        ['気管支鏡', 'MP4 / MOV / JPG', '×'],
        ['内視鏡', 'MP4 / MOV / JPG', '×'],
    ]
    story.append(make_table(types_data, col_widths=[55 * mm, 60 * mm, 45 * mm]))
    story.append(Spacer(1, 8 * mm))

    # ========= 2. 初回セットアップ =========
    story.append(Paragraph('2. 初回セットアップ（設定画面）', style_h1))
    story.append(Paragraph(
        '右上の「⚙ 設定」を押すと設定画面が開きます。誤って変更してしまわないよう、'
        '設定画面は <b>既定でロック</b> されています。',
        style_body))
    add_image(story, os.path.join(SHOT_DIR, '01-settings-locked.png'),
              'ロック状態の設定画面（入力欄は灰色で編集不可）')

    story.append(Paragraph('2.1 編集モードに入る', style_step))
    story.append(Paragraph(
        '「🔒 編集する...」ボタンを押すと警告ダイアログが出ます。'
        '「はい、編集する」を選ぶと編集モードになり、各項目が変更可能になります。',
        style_body))
    add_image(story, os.path.join(SHOT_DIR, '02-settings-unlocked.png'),
              '編集モード中の設定画面（黄バナー＋各項目編集可）')

    story.append(Paragraph('2.2 NAS をマウント', style_step))
    story.append(Paragraph(
        'Finder のサイドバーから NAS（例: Stella_8TB）に接続。'
        '<font face="Courier" size=9>/Volumes/Stella_8TB</font> 等が見える状態にしてください。',
        style_body))

    story.append(Paragraph('2.3 出力ルートと種別ごとの保存先', style_step))
    story.append(Paragraph(
        '「出力ルート」に NAS 上の親フォルダを設定。5 種別それぞれの「選択...」ボタンで <b>既存フォルダを指定</b> します。',
        style_body))
    story.append(Paragraph(
        '<b>「使う」列</b>：チェックを外した種別は取り込み元画面の種別ドロップダウンから消えます。',
        style_body))
    story.append(Paragraph(
        '<b>「コピー後削除」列</b>：チェックを入れた種別は、コピー＋ハッシュ照合成功後に元データ（SD カード側）を削除します。'
        '削除前にも <b>もう一度ハッシュ照合（リチェック）</b> を行ってから削除します。',
        style_body))
    story.append(Paragraph(
        '⚠ 「コピー後削除」を ON にする場合は、保存先（NAS など）の信頼性とバックアップ体制を確認してから運用してください。',
        style_note))

    story.append(Paragraph('2.4 取り込み元から除外するボリューム', style_step))
    story.append(Paragraph(
        '常時マウントされている HDD（バックアップ用、Time Machine 用など）が取り込み元一覧に出てくると煩雑です。'
        '「取り込み元から除外するボリューム」セクションで該当のボリュームに ✓ を入れると、'
        '取り込み元画面の検出一覧から外れます。',
        style_body))

    story.append(Paragraph('2.5 DICOM 送信先（StellaDICOM）', style_step))
    story.append(Paragraph(
        '<b>Calling AE Title</b>（任意のラベル、例: SURGERY）／'
        '<b>Called AE Title</b>（StellaDICOM 側の値）／'
        '<b>Host</b>（IP アドレスまたは <font face="Courier" size=9>stelladicom.local</font>）／'
        '<b>Port</b>（既定 104）を入力。「C-ECHO で疎通確認」で接続テスト。',
        style_body))

    story.append(Paragraph('2.6 保存', style_step))
    story.append(Paragraph(
        '「保存して次へ」で次の画面に進みます。'
        '<b>2回目以降の起動で設定を変えない場合</b>は、左下の「変更せず次へ →」で1クリック通過できます。',
        style_body))
    story.append(PageBreak())

    # ========= 3. 日常の操作フロー =========
    story.append(Paragraph('3. 日常の操作フロー', style_h1))
    story.append(Paragraph(
        '6 ステップで完了します。画面上部のステップインジケータで進捗が分かります。',
        style_body))

    story.append(Paragraph('3.1 ステップ1: 患者情報', style_step))
    story.append(Paragraph(
        '患者 ID、患者名（カタカナ可）、処置名、日付を入力します。'
        'DICOM 送信用の患者名はカタカナから自動でローマ字化されます（手動修正可）。',
        style_body))
    story.append(Paragraph(
        '画面上部に <b>「過去の患者から呼び出す」</b> 一覧があります（後述）。'
        '右下の「🗑 クリア」ボタンで全フィールドをリセットできます。',
        style_body))
    add_image(story, os.path.join(SHOT_DIR, '03-patient.png'),
              '患者情報画面（上部に呼び出し履歴、下部に入力フォーム + クリアボタン）')

    story.append(Paragraph('3.2 ステップ2: 取り込み元を選ぶ', style_step))
    story.append(Paragraph(
        '画面上部の「取り込み元一覧」に追加したソース、下部の「検出されたボリューム」から選んで追加します。'
        '追加直後は青色ハイライト＋自動スクロールで強調表示。',
        style_body))
    story.append(Paragraph(
        '各ソースに <b>種別を 1 つ</b> 選択（既定で先頭の有効な種別が選ばれた状態）。'
        '「差分インポート（前回以降のみ）」は <b>ON 推奨</b>（同じカード再挿入でも重複しない）。',
        style_body))
    story.append(Paragraph(
        '「次へ」を押すと <b>データ種別の確認ポップアップ</b> が表示されます。'
        '各ソースがどの種別で取り込まれるか（およびコピー後に元を削除する設定かどうか）を一覧で確認し、'
        '「この種別で取り込む」で先へ進みます。種別が違う場合は「戻って修正」で選び直してください。',
        style_body))
    story.append(Paragraph(
        '⚠ 種別を間違えると保存先フォルダや DICOM 送信対象が変わります。'
        'このポップアップで必ず確認してください。',
        style_note))
    add_image(story, os.path.join(SHOT_DIR, '04-source.png'),
              '取り込み元選択画面（上部が追加済み一覧、下部が検出ボリューム）')

    story.append(Paragraph('3.3 ステップ3: プレビュー', style_step))
    story.append(Paragraph(
        'コピー前に「何がどこに行くか」を確認。各ソースの種別・保存先パス・ファイル一覧が表示されます。'
        '「次へ」を押した時点で <b>既取込のファイルは事前ハッシュチェック</b> され、'
        'プレビューで既定で除外（チェック OFF）されます。',
        style_body))
    story.append(Paragraph(
        '⚠ 「コピー後削除」設定の種別がある場合、画面上部に赤バナーで警告表示されます。',
        style_note))
    add_image(story, os.path.join(SHOT_DIR, '05-preview.png'),
              'プレビュー画面（サマリ・種別別保存先・ファイル一覧・削除予定警告）')

    story.append(Paragraph('3.4 ステップ4: コピー実行', style_step))
    story.append(Paragraph(
        '「コピー開始」を押すとファイルが順次コピーされます。'
        '<b>各ファイルでコピー後にハッシュリチェック</b>（src と dst の SHA-256 比較）を実施。'
        '不一致なら dst を削除して失敗扱いになります。',
        style_body))
    story.append(Paragraph(
        '<b>削除設定の種別</b>の場合、リチェック成功後に <b>もう一度ハッシュ照合</b> してから src を削除します。'
        '右下の <b>赤い「中断」ボタン</b>で進行中のコピーを止められます。',
        style_body))
    add_image(story, os.path.join(SHOT_DIR, '06-ingest.png'),
              'コピー進捗画面（プログレスバー・統計・ログ・中断ボタン）')

    story.append(Paragraph('3.5 ステップ5: DICOM 送信', style_step))
    story.append(Paragraph(
        '種別「手術写真」が取り込まれた場合のみ DICOM 送信画面が表示されます。'
        '送信対象を確認し「DICOM 送信を実行」で StellaDICOM へ C-STORE 送信します。',
        style_body))
    story.append(Paragraph(
        '<b>大量送信時</b>（1000 枚など）は内部で <b>20 枚ずつのバッチ処理</b> に分割され、'
        'メモリ枯渇によるフリーズを防ぎます。同一 StudyInstanceUID で送るので PACS 側では 1 つの Study として認識されます。'
        '失敗時は再送キューに自動登録。',
        style_body))
    add_image(story, os.path.join(SHOT_DIR, '07-dicom.png'),
              'DICOM 送信画面（一括選択チェックボックス、バッチ進捗、ログ）')

    story.append(Paragraph('3.6 ステップ6: 完了', style_step))
    story.append(Paragraph(
        '取り込み結果のサマリ、種別ごとの「📁 〜を開く」ボタンが表示されます。'
        '取り込み元が /Volumes/ 配下なら <b>取り外しセクション</b>が出ます（後述）。'
        '「新しいセッションを開始」で次の症例へ。',
        style_body))
    add_image(story, os.path.join(SHOT_DIR, '08-done.png'),
              '完了画面（サマリ・フォルダを開くボタン・取り外しセクション）')
    story.append(PageBreak())

    # ========= 4. 過去患者 =========
    story.append(Paragraph('4. 同じ症例で複数の SD カードを使うとき', style_h1))
    story.append(Paragraph(
        'SD スロットが 1 つしかない場合、カードを順番に差し替えながら同じ患者フォルダにデータを追加できます。',
        style_body))
    steps_recall = [
        ['1', '1 枚目の SD カードを通常通り取り込み完了'],
        ['2', 'SD カードを差し替え（2 枚目を挿入）'],
        ['3', '「新しいセッションを開始」で患者情報画面に戻る'],
        ['4', '画面上部の「過去の患者から呼び出す」一覧に先ほどの症例が表示される'],
        ['5', '「呼び出す」ボタン → フォームが自動入力、緑バッジ表示'],
        ['6', '次へ → ソース選択 → コピー（同じ患者フォルダに追記、衝突確認なし）'],
    ]
    story.append(make_table(steps_recall, col_widths=[12 * mm, 148 * mm]))
    story.append(Paragraph(
        '履歴は最新 30 件まで表示（最終取り込み時刻順）。フォルダ名・処置名・最終取り込み時刻・累計ファイル数が見えます。'
        '不要な履歴は「削除」で除去できます（実フォルダは残ります）。',
        style_body))
    story.append(PageBreak())

    # ========= 5. デバイス取り外し =========
    story.append(Paragraph('5. コピー完了後のデバイス取り外し', style_h1))
    story.append(Paragraph(
        '完了画面が表示されたタイミングで、取り込み元が /Volumes/ 配下なら自動的に確認ダイアログが出ます。',
        style_body))
    story.append(Paragraph(
        '<b>「はい、取り外す」</b> を選ぶと、各ボリュームを順次 <font face="Courier" size=9>diskutil eject</font> で取り外し。'
        '完了後「✓ 取り外せます。物理的にデバイスを抜いてください」と表示されます。',
        style_body))
    story.append(Paragraph(
        '<b>「後で」</b> を選んだ場合は、完了画面の下部に表示される「📤 取り外し」ボタンから個別／一括で取り外せます。',
        style_body))
    story.append(Paragraph(
        '安全制限: /Volumes/ 配下のパスのみ取り外し可能。ローカルディレクトリ（手動選択フォルダ）は対象外。',
        style_note))
    story.append(PageBreak())

    # ========= 6. 中断 =========
    story.append(Paragraph('6. コピーの中断', style_h1))
    story.append(Paragraph(
        'コピー実行画面の右下に <b>赤い「中断」ボタン</b> があります。'
        'クリックすると確認ダイアログが出て、OK で進行中のコピーを即停止します。',
        style_body))
    story.append(Paragraph(
        '中断後の状態:',
        style_body))
    story.append(Paragraph(
        '・進行中だったファイル → 中途半端な dst を削除（部分ファイル残らない）<br/>'
        '・既にコピー完了したファイル → そのまま保持<br/>'
        '・ハッシュ DB には正常コピー分のみ記録 → 次回再開時は重複扱いでスキップ',
        style_body))
    story.append(Paragraph(
        '中断後は「中断」ボタンが「← プレビューへ戻る」に変化。選択を見直して再開できます。',
        style_body))
    story.append(PageBreak())

    # ========= 7. フォルダ構造 =========
    story.append(Paragraph('7. フォルダ構造の例', style_h1))
    story.append(Paragraph(
        '各種別フォルダ配下に <font face="Courier" size=9>日付_ID_名_処置名</font> の患者フォルダが作られ、'
        'その中に元ファイル名のままコピーされます。',
        style_body))
    folder_tree = """/Volumes/Stella_8TB/
├── 手術写真/
│   ├── 2026-06-01_P0001_モモ_去勢術/
│   │   ├── IMG_0001.jpg
│   │   ├── IMG_0002.jpg
│   │   └── ...
│   └── 2026-06-01_P0002_タロウ_避妊術/
│       └── ...
├── 麻酔記録/
│   └── 2026-06-01_P0001_モモ_去勢術/
│       └── anesthesia_log.csv
├── 腹腔鏡/
│   └── 2026-06-01_P0001_モモ_去勢術/
│       └── lap_video.mp4
├── 気管支鏡/
└── 内視鏡/"""
    story.append(Paragraph(folder_tree.replace('\n', '<br/>'), style_code))
    story.append(PageBreak())

    # ========= 8. マニュアル / アップデート =========
    story.append(Paragraph('8. マニュアル / アップデートの開き方', style_h1))
    story.append(Paragraph('8.1 このマニュアルを開く', style_step))
    story.append(Paragraph('本マニュアル（PDF）はアプリ内に同梱されています。次の 3 通りの方法で開けます:', style_body))
    open_data = [
        ['方法', '操作'],
        ['ヘッダーボタン', '画面右上の「📖 マニュアル」ボタン'],
        ['メニューバー', '「ヘルプ」→「マニュアルを開く (PDF)」'],
        ['キーボード', 'F1 キー'],
    ]
    story.append(make_table(open_data, col_widths=[40 * mm, 120 * mm]))
    story.append(Paragraph('8.2 アップデート', style_step))
    story.append(Paragraph(
        '起動時に GitHub Releases を自動チェックします。新版があればダイアログで通知されます。'
        '手動チェックは設定画面の「今すぐアップデートを確認」または「ヘルプ」→「アップデートを確認…」から。',
        style_body))
    story.append(Paragraph(
        '配信先: <font face="Courier" size=9>https://github.com/roon1115/surgery-data-manager/releases</font>',
        style_body))
    story.append(PageBreak())

    # ========= 9. トラブルシューティング =========
    story.append(Paragraph('9. トラブルシューティング', style_h1))
    trouble = [
        ['症状', '原因 / 対処'],
        ['「出力ルートが見つかりません」', 'NAS が切断された。Finder で再マウント → 再試行'],
        ['「保存先フォルダの確認が必要です」', '種別フォルダのいずれかが存在しない。設定で確認＆フォルダ選択し直し'],
        ['同名フォルダが既存です', '過去患者の呼び出しを使えば衝突確認なしで追記できる。手動入力なら「追記」を選ぶ'],
        ['DICOM 送信が失敗する', 'C-ECHO で疎通確認 → AE Title / Host / Port 見直し。失敗分は再送キューに残る'],
        ['設定を変更したい', '設定画面の「🔒 編集する...」を押して警告を OK で編集モードに'],
        ['取り込み元に余計な HDD が出る', '設定の「取り込み元から除外するボリューム」で該当 HDD を ✓'],
        ['種別を間違えてコピーした', '次回「次へ」時の種別確認ポップアップで必ず確認を。誤コピー分は保存先から手動削除'],
        ['コピーしたファイルが見当たらない', '完了画面の「📁 〜を開く」ボタンで該当フォルダを開ける'],
        ['カタカナ名が ローマ字変換されない', 'DICOM 送信用 患者名欄を手動入力した後は自動変換が止まる。空欄に戻せば再開'],
        ['同じファイルを 2 回コピーしてしまった', '差分インポート（SHA-256）が ON なら 2 回目は自動スキップされる'],
        ['「コピー後削除」設定なのに残ってる', '削除前リチェックでハッシュ不一致 → 安全のため削除中止。ログ確認'],
    ]
    story.append(make_table(trouble, col_widths=[60 * mm, 100 * mm]))
    story.append(PageBreak())

    # ========= 10. データ保存場所 / DICOM 仕様 =========
    story.append(Paragraph('10. データ保存場所 / DICOM 仕様', style_h1))
    story.append(Paragraph('10.1 データ保存場所', style_step))
    data_loc = [
        ['種別', '場所'],
        ['患者データ実体', '設定で指定した種別フォルダ配下'],
        ['取り込み履歴（SHA-256 DB）', '~/Library/Application Support/surgery-data-manager/ingest.json'],
        ['過去患者の呼び出し履歴', '~/Library/Application Support/surgery-data-manager/history.json'],
        ['設定', '~/Library/Application Support/surgery-data-manager/config.json'],
    ]
    story.append(make_table(data_loc, col_widths=[55 * mm, 105 * mm]))
    story.append(Paragraph('10.2 DICOM 送信仕様（参考）', style_step))
    dicom_spec = [
        ['項目', '値'],
        ['SOP Class', 'Secondary Capture Image Storage (1.2.840.10008.5.1.4.1.1.7)'],
        ['Transfer Syntax', 'Implicit VR Little Endian (1.2.840.10008.1.2)'],
        ['Specific Character Set', 'ISO_IR 100（ASCII）固定'],
        ['PatientID / PatientName', 'ASCII フィルタ済み（非 ASCII は除去）'],
        ['Modality', 'OT（Other）'],
        ['StudyDate / StudyTime', '取り込み日時から自動'],
        ['バッチサイズ', '20 枚／バッチ（メモリ枯渇回避）'],
    ]
    story.append(make_table(dicom_spec, col_widths=[55 * mm, 105 * mm]))
    story.append(Paragraph('10.3 ハッシュリチェックの動作', style_step))
    story.append(Paragraph('医療データの完全性確保のため、各ファイルで以下のリチェックを実施:', style_body))
    recheck = [
        ['タイミング', '内容'],
        ['コピー直後', 'src と dst の SHA-256 を比較。不一致なら dst を削除して失敗扱い。'],
        ['削除直前（「コピー後削除」設定時のみ）',
         'src の現在のハッシュを再計算 → dst のハッシュと比較。一致したら src を削除、不一致なら削除中止。'],
    ]
    story.append(make_table(recheck, col_widths=[60 * mm, 100 * mm]))

    def footer(canvas, doc):
        canvas.saveState()
        canvas.setFont(JP_FONT_MIN, 8)
        canvas.setFillColor(colors.HexColor('#64748b'))
        canvas.drawString(20 * mm, 10 * mm, f'Surgery Data Manager {VERSION}　画像転送マニュアル')
        canvas.drawRightString(A4[0] - 20 * mm, 10 * mm, f'- {doc.page} -')
        canvas.restoreState()

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    print(f'PDF generated: {OUTPUT_PDF}')


if __name__ == '__main__':
    build_pdf()
