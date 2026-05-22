(function() {
  console.log('[app] booting...');
  window.addEventListener('error', (e) => {
    console.error('[uncaught]', e.message, e.filename + ':' + e.lineno);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[unhandledRejection]', e.reason && (e.reason.stack || e.reason.message || e.reason));
  });
  const mount = document.getElementById('app');
  console.log('[app] mount=', !!mount, 'App=', !!window.App, 'U=', !!window.U, 'Views=', Object.keys(window.Views || {}).join(','));

  const state = {
    step: 'patient',
    settings: null,
    patient: null,
    sources: [],
    targetFolder: null,
    ingestResult: null,
    dicomResult: null,
    goto(step) {
      state.step = step;
      render();
    },
    reset() {
      state.patient = null;
      state.sources = [];
      state.targetFolder = null;
      state.targets = null;
      state.folderName = null;
      state.isExistingPatient = false;
      state.ingestResult = null;
      state.dicomResult = null;
    },
  };

  const stepOrder = ['settings', 'patient', 'source', 'preview', 'ingest', 'dicom', 'done'];

  async function render() {
    console.log('[app] render step=', state.step);
    const visibleStep = state.step === 'settings' ? 'patient' : state.step;
    const doneSteps = stepOrder.slice(0, stepOrder.indexOf(state.step));
    U.setSteps(visibleStep, doneSteps);

    const view = window.Views[state.step];
    if (!view) {
      mount.innerHTML = '<div class="card"><h2>未実装ステップ: ' + state.step + '</h2></div>';
      return;
    }
    try {
      await view.render(state, mount);
      console.log('[app] render done step=', state.step);
    } catch (e) {
      console.error('[app] render error step=', state.step, ':', e?.stack || e?.message || e);
      mount.innerHTML = '<div class="card"><h2>エラー</h2><pre>' + (e?.message || e) + '</pre></div>';
    }
  }

  document.getElementById('btn-settings').addEventListener('click', () => {
    state.goto('settings');
  });
  document.getElementById('btn-manual').addEventListener('click', () => {
    window.App.openManual();
  });

  // 初期化: 設定が空なら settings → 揃っていれば patient
  (async function init() {
    const cfg = await window.App.settings.get();
    state.settings = cfg;
    if (!cfg.outputRoot || !cfg.dicom.host) {
      state.step = 'settings';
    } else {
      state.step = 'patient';
    }
    render();
  })();
})();
