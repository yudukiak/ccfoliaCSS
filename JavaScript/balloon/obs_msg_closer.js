(() => {
  const VERSION = '1.0.0';

  // 監視対象のボックスと「閉じる」ボタン
  const SELECTOR_BOX   = '#root > div > div > div.MuiPaper-root.MuiPaper-elevation6';
  const SELECTOR_CLOSE = 'button[aria-label="閉じる"]';
  // 1文字ずつ描画される本文の要素
  const SELECTOR_TEXT  = '.MuiTypography-root.MuiTypography-body1';
  // 動作パラメータ
  const DEFAULT_SECONDS = 20;   // 既定のカウント秒
  const POLL_MS         = 200;  // tick() の周期
  const TEXT_SETTLE_MS  = 400;  // テキストがこの時間変化しなければ「安定」とみなす
  // パネルID（CSSのスコープにも使用）
  const PANEL_ID = 'obs-msg-closer-panel';

  // 多重起動防止
  if (window.__obsMsgCloser) {
    console.log('[obs-msg-closer] 既に起動しています');
    const p = document.querySelector(`#${PANEL_ID}`);
    if (p) p.style.display = 'block';
    return;
  }
  window.__obsMsgCloser = true;

  // 状態
  const State = Object.freeze({
    UNDETECTED: 'UNDETECTED', // ボックス未検出（またはDOMに存在しない）
    PAUSED:     'PAUSED',     // ボックス検出済みだが非表示（visibility:hidden や transform で退避）
    TYPING:     'TYPING',     // ボックス可視・テキストがまだ描画中（連続変化中）
    COUNTING:   'COUNTING',   // テキストが安定 → カウント開始/継続
    JUST_CLOSED:'JUST_CLOSED', // 規定秒経過で閉じた直後（hidden状態へ移行想定）
  });

  // パネルのCSS
  const css = `
#${PANEL_ID} {
  position: fixed;
  inset-block-start: 12px;
  inset-inline-end: 12px;
  z-index: 1000;
  inline-size: 260px;
  background: oklch(22% 0 0 / 0.9);
  backdrop-filter: blur(6px);
  color: oklch(97% 0 0);
  padding: 12px 14px;
  border-radius: 12px;

  & .header {
    display: flex;
    justify-content: space-between;
    align-items: center;

    & button {
      inline-size: 30px;
      block-size: 30px;
      border: none;
      border-radius: 9999px;
      font: inherit;
      cursor: pointer;
      background: oklch(35% 0 0 / .9);
      color: oklch(96% 0 0);
    }
    & h1 {
      font-size: 1rem;
      font-weight: 700;
      margin: 0;
    }
  }

  & .body {
    font-size: 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 6px;

    & .row {
      display: flex;
      gap: 12px;
      align-items: center;
    }

    & input[type="number"] {
      appearance: auto;
      -webkit-appearance: auto;
      inline-size: 94px;
      padding-block: 4px;
      padding-inline: 8px;
      border-radius: 10px;
      border: 1px solid color-mix(in oklch, currentColor 22%, transparent);
      background: oklch(28% 0 0 / .6);
      color: inherit;
      outline: none;
    }

    & .debug { font-size: 0.7rem; }
  }

  & .muted { color: oklch(82% 0 0); }
  & .ok    { color: oklch(78% 0.12 150); }
  & .warn  { color: oklch(80% 0.12 80); }
  & .err   { color: oklch(70% 0.15 25); }
}
  `;
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.documentElement.appendChild(styleEl);

  // パネルDOM生成
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="header">
      <h1>OBS Message Closer</h1>
      <button id="obs-close-panel" aria-label="パネルを閉じる">×</button>
    </div>
    <div class="body">
      <div class="row">
        <label for="obs-seconds">秒数</label>
        <input id="obs-seconds" type="number" min="1" step="1" value="${DEFAULT_SECONDS}">
      </div>
      <details class="debug">
        <summary>デバッグ</summary>
        <table>
          <tr><td>Box</td><td id="obs-box-state" class="muted">未検出</td></tr>
          <tr><td>状態</td><td id="obs-status" class="warn">監視中</td></tr>
          <tr><td>経過</td><td><span id="obs-elapsed">0.0</span>s</td></tr>
          <tr><td>目標</td><td><span id="obs-target">${DEFAULT_SECONDS}</span>s</td></tr>
          <tr><td>Text</td><td id="obs-text-state" class="muted">—</td></tr>
          <tr><td>ver</td><td>${VERSION}</td></tr>
        </table>
      </details>
    </div>
  `;
  document.body.appendChild(panel);

  // パネル参照
  const $ = (sel) => panel.querySelector(sel);
  const elSeconds   = $('#obs-seconds');
  const elBoxState  = $('#obs-box-state');
  const elStatus    = $('#obs-status');
  const elElapsed   = $('#obs-elapsed');
  const elTarget    = $('#obs-target');
  const elTextState = $('#obs-text-state');

  // パネルを非表示（再実行で復帰）
  $('#obs-close-panel').onclick = () => (panel.style.display = 'none');

  // ランタイム状態（変数）
  let targetSeconds = DEFAULT_SECONDS;  // 現在の締め秒数
  let state         = State.UNDETECTED; // 現在の状態
  let currentBox    = null;             // 監視対象のボックス（参照変化検知）
  let startTs       = null;             // カウント開始時刻

  // テキスト安定判定用
  let textElm            = null;
  let textObserver       = null;
  let lastTextSnapshot   = '';
  let lastTextChangeTs   = null;

  // 現在エラー表示中か（エラー中はtickでstatusを上書きしない）
  const isError = () => elStatus.classList.contains('err');

  // 「ボックス本体 + 閉じるボタン」が揃っている時のみ検出とする
  const getDetectedBox = () => {
    const box = document.querySelector(SELECTOR_BOX);
    if (!box) return null;
    const btn = box.querySelector(SELECTOR_CLOSE);
    return btn ? box : null;
  };

  // 可視（visible & transform:none）かを判定
  const isBoxVisible = (box) => {
    if (!box) return false;
    const cs = getComputedStyle(box);
    const visOK = cs.visibility !== 'hidden';
    const tfmOK = cs.transform === 'none' || cs.transform === 'matrix(1, 0, 0, 1, 0, 0)';
    return visOK && tfmOK;
  };

  // テキスト監視のデタッチ
  const detachTextObserver = () => {
    if (textObserver) { try { textObserver.disconnect(); } catch {} }
    textObserver = null;
    textElm = null;
    lastTextSnapshot = '';
    lastTextChangeTs = null;
  };

  // テキスト監視のアタッチ（1文字ずつ描画に追随）
  const attachTextObserver = (box) => {
    const el = box.querySelector(SELECTOR_TEXT);
    if (!el) { detachTextObserver(); elTextState.textContent = '—'; elTextState.className = 'muted'; return; }
    if (el === textElm) return; // 既に監視中なら何もしない

    detachTextObserver();
    textElm = el;
    lastTextSnapshot = el.textContent || '';
    lastTextChangeTs = Date.now(); // 初期は「今時刻」を変更時刻としてセット
    elTextState.textContent = '描画監視中';
    elTextState.className = 'warn';

    textObserver = new MutationObserver(() => {
      const now = (el.textContent || '');
      if (now !== lastTextSnapshot) {
        lastTextSnapshot = now;
        lastTextChangeTs = Date.now(); // 変化があるたびに更新
      }
    });
    textObserver.observe(el, { characterData: true, childList: true, subtree: true });
  };

  // テキストが一定時間変化していなければ「安定」
  const isTextStable = () => {
    return lastTextChangeTs != null && (Date.now() - lastTextChangeTs) >= TEXT_SETTLE_MS;
  };

  // ボックスのラベルを更新
  const setBoxLabel = (text, cls) => {
    elBoxState.textContent = text;
    elBoxState.className = cls;
  };

  // テキストのラベルを更新
  const setTextLabel = (text, cls) => {
    elTextState.textContent = text;
    elTextState.className = cls;
  };

  // ステータスのラベルを更新
  const setStatus = (text, cls) => {
    if (isError()) return; // エラー表示中は上書きしない
    elStatus.textContent = text;
    elStatus.className = cls;
  };

  // 各状態ごとのUI反映
  const renderUNDETECTED = () => {
    setBoxLabel('未検出', 'muted');
    setTextLabel('—', 'muted');
    elElapsed.textContent = '0.0';
    setStatus('監視中', 'warn');
  };

  const renderPAUSED = () => {
    setBoxLabel('検出', 'ok');
    setTextLabel('—', 'muted');
    elElapsed.textContent = '0.0';
    setStatus('待機中', 'warn');
  };

  const renderTYPING = () => {
    setBoxLabel('検出', 'ok');
    setTextLabel('文字描画中', 'warn');
    elElapsed.textContent = '0.0';
    setStatus('文字描画待ち', 'warn');
  };

  const renderCOUNTING = () => {
    setBoxLabel('検出', 'ok');
    setTextLabel('安定', 'ok');
    setStatus('カウント中', 'ok');
  };

  const renderJUST_CLOSED = () => {
    setStatus('閉じました（次の再表示を待機）', 'ok');
    elElapsed.textContent = '0.0';
  };

  // 入力（秒数）のバリデーション＆反映
  const applySeconds = () => {
    const v = Number(elSeconds.value);
    if (Number.isInteger(v) && v >= 1) {
      targetSeconds = v;
      elTarget.textContent = String(targetSeconds);

      // エラー表示からの復帰時のみ、適切な状態表記に戻す
      if (isError()) {
        switch (state) {
          case State.UNDETECTED: setStatus('監視中', 'warn'); break;
          case State.PAUSED:     setStatus('待機中', 'warn'); break;
          case State.TYPING:     setStatus('文字描画待ち', 'warn'); break;
          case State.COUNTING:   setStatus('カウント中', 'ok'); break;
          case State.JUST_CLOSED:setStatus('閉じました（次の再表示を待機）', 'ok'); break;
        }
      }
    } else {
      elStatus.textContent = '1以上の整数を入力してください';
      elStatus.className = 'err';
    }
  };
  elSeconds.addEventListener('input', applySeconds);
  elSeconds.addEventListener('change', applySeconds);

  // アクション
  const tryClickClose = (box) => {
    const btn = box?.querySelector(SELECTOR_CLOSE);
    if (btn) { try { btn.click(); } catch {} }
  };

  // メインループ（状態遷移）
  const tick = () => {
    const box = getDetectedBox();

    // ① 未検出：初期状態へ
    if (!box || !document.contains(box)) {
      if (state !== State.UNDETECTED) {
        // 状態遷移：任意 → UNDETECTED
        state      = State.UNDETECTED;
        currentBox = null;
        startTs    = null;
        detachTextObserver();
        renderUNDETECTED();
      } else {
        // 維持
        renderUNDETECTED();
      }
      return;
    }

    // ② 検出済みだが非表示：待機
    if (!isBoxVisible(box)) {
      if (state !== State.PAUSED || box !== currentBox) {
        // 状態遷移：任意 → PAUSED
        state      = State.PAUSED;
        currentBox = box;
        startTs    = null;
        detachTextObserver(); // 非表示中は監視不要
        renderPAUSED();
      } else {
        // 維持
        renderPAUSED();
      }
      return;
    }

    // ③ 見えている：テキスト監視セット
    attachTextObserver(box);

    // ④ テキストがまだ安定していない：描画待ち
    if (!isTextStable()) {
      if (state !== State.TYPING || box !== currentBox) {
        // 状態遷移：任意 → TYPING
        state      = State.TYPING;
        currentBox = box;
        startTs    = null;
        renderTYPING();
      } else {
        // 維持
        renderTYPING();
      }
      return;
    }

    // ⑤ テキストが安定：カウント開始/継続
    if (state !== State.COUNTING || box !== currentBox) {
      // 状態遷移：任意 → COUNTING
      state      = State.COUNTING;
      currentBox = box;
      startTs    = Date.now();
      renderCOUNTING();
    } else if (startTs == null) {
      // 参照は同じだがstartTsが消えていた場合（例えば手動で非表示→再可視になった後など）
      startTs = Date.now();
      renderCOUNTING();
    } else {
      // 継続中：UIだけ更新
      renderCOUNTING();
    }

    // ⑥ 経過の更新としきい値判定
    const diffSec = (Date.now() - startTs) / 1000;
    elElapsed.textContent = diffSec.toFixed(1);

    if (diffSec >= targetSeconds) {
      tryClickClose(box);          // 実際に閉じる
      state   = State.JUST_CLOSED; // 状態遷移：COUNTING → JUST_CLOSED
      startTs = null;              // hidden期間はカウント停止
      renderJUST_CLOSED();
      return;
    }
  };

  // 初期化＆起動
  applySeconds();                  // 秒数の初期反映
  setInterval(tick, POLL_MS);      // メインループ開始
})();
