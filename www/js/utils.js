window.U = (function() {

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (k === 'class') node.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'html') node.innerHTML = v;
        else if (v === false || v == null) continue;
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, v);
      }
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function formatBytes(b) {
    if (b == null) return '';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
    return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function todayIso() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function sanitize(s) {
    return String(s || '')
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, '')
      .trim();
  }

  function toRomaji(kana) {
    if (!kana) return '';
    if (window.App && typeof window.App.toRomaji === 'function') {
      const r = window.App.toRomaji(kana);
      if (r) return r.toUpperCase().replace(/[^A-Z0-9 ]/g, '');
    }
    // フォールバック: 主要なカタカナのみ簡易変換
    const map = {
      'ア':'A','イ':'I','ウ':'U','エ':'E','オ':'O',
      'カ':'KA','キ':'KI','ク':'KU','ケ':'KE','コ':'KO',
      'サ':'SA','シ':'SHI','ス':'SU','セ':'SE','ソ':'SO',
      'タ':'TA','チ':'CHI','ツ':'TSU','テ':'TE','ト':'TO',
      'ナ':'NA','ニ':'NI','ヌ':'NU','ネ':'NE','ノ':'NO',
      'ハ':'HA','ヒ':'HI','フ':'FU','ヘ':'HE','ホ':'HO',
      'マ':'MA','ミ':'MI','ム':'MU','メ':'ME','モ':'MO',
      'ヤ':'YA','ユ':'YU','ヨ':'YO',
      'ラ':'RA','リ':'RI','ル':'RU','レ':'RE','ロ':'RO',
      'ワ':'WA','ヲ':'WO','ン':'N',
      'ガ':'GA','ギ':'GI','グ':'GU','ゲ':'GE','ゴ':'GO',
      'ザ':'ZA','ジ':'JI','ズ':'ZU','ゼ':'ZE','ゾ':'ZO',
      'ダ':'DA','ヂ':'JI','ヅ':'ZU','デ':'DE','ド':'DO',
      'バ':'BA','ビ':'BI','ブ':'BU','ベ':'BE','ボ':'BO',
      'パ':'PA','ピ':'PI','プ':'PU','ペ':'PE','ポ':'PO',
      'ー':'',
    };
    let out = '';
    for (const ch of kana) {
      out += map[ch] != null ? map[ch] : (/[A-Za-z0-9]/.test(ch) ? ch.toUpperCase() : '');
    }
    return out;
  }

  function modal({ title, body, okText = 'OK', cancelText = 'キャンセル', onOk }) {
    const m = document.getElementById('modal');
    const content = document.getElementById('modal-content');
    const okBtn = document.getElementById('modal-ok');
    const cancelBtn = document.getElementById('modal-cancel');
    content.innerHTML = '';
    if (title) content.appendChild(el('h3', null, title));
    if (typeof body === 'string') content.appendChild(el('div', null, body));
    else if (body instanceof Node) content.appendChild(body);
    okBtn.textContent = okText;
    cancelBtn.textContent = cancelText;
    m.classList.remove('hidden');
    const cleanup = () => {
      m.classList.add('hidden');
      okBtn.replaceWith(okBtn.cloneNode(true));
      cancelBtn.replaceWith(cancelBtn.cloneNode(true));
    };
    document.getElementById('modal-ok').onclick = () => { cleanup(); if (onOk) onOk(); };
    document.getElementById('modal-cancel').onclick = cleanup;
  }

  function setSteps(activeStep, doneSteps = []) {
    const order = ['patient', 'source', 'ingest', 'dicom', 'done'];
    for (const s of document.querySelectorAll('.step')) {
      const key = s.dataset.step;
      s.classList.toggle('active', key === activeStep);
      s.classList.toggle('done', doneSteps.includes(key));
    }
  }

  return { el, formatBytes, todayIso, sanitize, toRomaji, modal, setSteps };
})();
