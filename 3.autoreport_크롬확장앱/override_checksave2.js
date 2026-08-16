// ============================================================================
// override_checksave2.js — 저장 후 리다이렉트 방지 (MAIN world 전용)
// ============================================================================
// world: "MAIN" + run_at: "document_idle"
//
// ERP 저장 흐름:
//   checkSave() → callAJAX(VC) → callBackCheckSave()
//   → save() → callAJAX(C1) → callBackSave() → goList() ← 리다이렉트!
//
// 이중 안전장치:
//   1차: callBackSave 오버라이드 → goList() 호출 제거
//   2차: goList 오버라이드 → 저장 컨텍스트에서 호출 시 차단
// ============================================================================

(function () {
    console.log('[AutoReport] override_checksave2.js 로드됨 (v3 - document_idle)');

    // 저장 컨텍스트 플래그 (2차 안전장치용)
    window._autoReportSaveInProgress = false;

    function applyOverrides() {
        // ---- 1차 안전장치: callBackSave 오버라이드 ----
        if (typeof window.callBackSave === 'function') {
            window.callBackSave = function (ret_data) {
                alert(ret_data.E_RMSG);
                if ('S' == ret_data.E_RCODE) {
                    console.log('[AutoReport] ✅ 저장 성공 — goList() 호출 안 함');
                    window._autoReportSaveInProgress = false;
                }
            };
            console.log('[AutoReport] ✅ callBackSave 오버라이드 완료');
        } else {
            console.warn('[AutoReport] ⚠️ callBackSave 미발견');
        }

        // ---- 2차 안전장치: goList 오버라이드 ----
        if (typeof window.goList === 'function') {
            var _originalGoList = window.goList;
            window.goList = function () {
                if (window._autoReportSaveInProgress) {
                    window._autoReportSaveInProgress = false;
                    console.log('[AutoReport] 🚫 goList 차단됨 (저장 후 리다이렉트 방지)');
                    return;
                }
                _originalGoList.call(this);
            };
            console.log('[AutoReport] ✅ goList 오버라이드 완료');
        } else {
            console.warn('[AutoReport] ⚠️ goList 미발견');
        }

        // ---- 3차 안전장치: save 함수에 플래그 설정 ----
        if (typeof window.save === 'function') {
            var _originalSave = window.save;
            window.save = function (CS_7523) {
                window._autoReportSaveInProgress = true;
                console.log('[AutoReport] 🔄 저장 시작 — 리다이렉트 차단 플래그 설정');
                _originalSave.call(this, CS_7523);
            };
            console.log('[AutoReport] ✅ save 오버라이드 완료');
        } else {
            console.warn('[AutoReport] ⚠️ save 미발견');
        }
    }

    applyOverrides();
})();
