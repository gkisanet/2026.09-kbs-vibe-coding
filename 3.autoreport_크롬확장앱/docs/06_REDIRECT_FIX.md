# 🎓 저장 후 리다이렉트 방지 — 초보자를 위한 완전 가이드

> **대상**: JavaScript 기초 지식이 있는 초보 웹 개발자  
> **목적**: Chrome 확장 프로그램에서 웹 페이지의 기존 함수를 오버라이드(덮어쓰기)하여 동작을 변경하는 기법을 이해한다  
> **최종 수정**: 2026-03-01

---

## 📖 목차

1. [문제 상황](#1-문제-상황)
2. [ERP 페이지의 저장 흐름 이해하기](#2-erp-페이지의-저장-흐름-이해하기)
3. [왜 리다이렉트가 발생하는가?](#3-왜-리다이렉트가-발생하는가)
4. [실패한 시도들과 그 이유](#4-실패한-시도들과-그-이유)
5. [최종 해결: 3중 안전장치](#5-최종-해결-3중-안전장치)
6. [핵심 개념 정리](#6-핵심-개념-정리)

---

## 1. 문제 상황

### 무엇이 문제인가?

KBS ERP 시스템에서 **실적을 저장**하면, 저장 완료 후 자동으로 **목록 페이지로 이동(리다이렉트)**됩니다.

```
[실적 등록 페이지] → 저장 버튼 클릭 → 저장 완료 → [목록 페이지로 이동] 😢
```

우리가 원하는 동작:

```
[실적 등록 페이지] → 저장 버튼 클릭 → 저장 완료 → [같은 페이지에 머무름] 😊
```

### 왜 이것이 문제인가?

여러 건의 실적을 연속으로 입력할 때, 매번 목록 페이지로 돌아가서 다시 등록 페이지를 열어야 합니다. AutoReport 확장은 엑셀에서 여러 건의 데이터를 자동 입력하는 기능이 있으므로, 저장 후에도 같은 페이지에 머물러야 다음 건을 바로 입력할 수 있습니다.

---

## 2. ERP 페이지의 저장 흐름 이해하기

### 저장 버튼의 HTML 코드

ERP 페이지의 소스 코드를 보면, 저장 버튼은 이렇게 생겼습니다:

```html
<li class="btn_blue" id="btn_save">
  <a href="javascript:" onclick="checkSave();">
    <span>저장</span>
  </a>
</li>
```

> 💡 **포인트**: `onclick="checkSave();"` — 버튼을 클릭하면 `checkSave()` 함수가 호출됩니다.

### 저장 과정의 전체 흐름 (6단계)

저장 버튼을 클릭하면 다음 순서로 함수가 호출됩니다:

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  1️⃣ checkSave()          ← 사용자가 저장 버튼 클릭       │
│     │                                                   │
│     │  confirm("저장 하시겠습니까?")                       │
│     │  폼 데이터 수집 (makeStructure)                     │
│     ▼                                                   │
│  2️⃣ callAJAX(VC모드)     ← 서버에 "검증해줘" 요청         │
│     │                                                   │
│     │  (서버가 데이터를 검증)                               │
│     ▼                                                   │
│  3️⃣ callBackCheckSave()  ← 검증 결과 수신                │
│     │                                                   │
│     │  E_RCODE === 'S' 이면 저장 진행                     │
│     ▼                                                   │
│  4️⃣ save()               ← 실제 저장 요청                │
│     │                                                   │
│     │  callAJAX(C1모드) — 서버에 "저장해줘" 요청           │
│     ▼                                                   │
│  5️⃣ callBackSave()       ← 저장 결과 수신                │
│     │                                                   │
│     │  alert(결과 메시지)                                  │
│     │  E_RCODE === 'S' 이면...                           │
│     ▼                                                   │
│  6️⃣ goList()             ← 🚨 목록 페이지로 리다이렉트!   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 각 함수의 실제 코드

#### 1️⃣ checkSave() — "저장할까요?" 확인 + 데이터 수집

```javascript
function checkSave() {
    // 사용자에게 확인 대화상자 표시
    if (confirm('저장 하시겠습니까?')) {

        // 폼의 모든 입력값을 구조체(CS_7523)로 수집
        var CS_7523 = makeStructure('reg_form');

        // 제작리소스 목록 수집
        IT_ZJRES = [];
        $('#zjres_list select').each(function(idx, item) {
            if ($(item).val()) {
                IT_ZJRES.push({
                    ZWSEQ: $('#ZWSEQ').val(),
                    ZASEQ: $('#ZASEQ').val(),
                    ZJRES: $(item).val()
                });
            }
        });

        // 서버에 검증(VC) 요청
        submit_data = {
            FUNCTION_NAME: 'ZWEB_PS820_0200',
            I_MODE: 'VC',              // ← "Validation Check"
            CS_7523: CS_7523,
            IT_7505: data_IT_7505,     // 근무자 목록
            IT_ZJRES: IT_ZJRES,        // 제작리소스 목록
            I_LOGIN_ID: '31298'
        };

        // callAJAX: ERP의 공통 AJAX 호출 함수
        // 두 번째 인자가 "콜백 함수" — 서버 응답이 오면 이 함수를 호출
        callAJAX(submit_data, callBackCheckSave, '', CS_7523);
    }
}
```

> 💡 **콜백(callback) 이란?**  
> "나중에 다시 호출해줘"라는 뜻입니다. `callAJAX`에 `callBackCheckSave`를 넘기면, 서버 응답이 도착한 후에 `callBackCheckSave`가 자동으로 호출됩니다.

#### 3️⃣ callBackCheckSave() — 검증 결과에 따라 분기

```javascript
function callBackCheckSave(ret_data, CS_7523) {
    if ('E' == ret_data.E_RCODE) {
        // 에러: 검증 실패 (예: 필수값 누락)
        alert(ret_data.E_RMSG);

    } else if ('S' == ret_data.E_RCODE) {
        // 성공: 저장 진행
        save(CS_7523);

    } else if ('C' == ret_data.E_RCODE) {
        // 확인 필요: "중복된 데이터가 있습니다. 계속할까요?"
        if (confirm(ret_data.E_RMSG)) {
            save(CS_7523);
        }
    }
}
```

#### 4️⃣ save() — 실제 저장 요청

```javascript
function save(CS_7523) {
    submit_data = {
        FUNCTION_NAME: 'ZWEB_PS820_0200',
        I_MODE: 'C1',              // ← "Create 1" = 저장
        CS_7523: CS_7523,
        IT_7505: data_IT_7505,
        IT_ZJRES: IT_ZJRES,
        I_LOGIN_ID: '31298'
    };

    // 저장 결과가 오면 callBackSave를 호출
    callAJAX(submit_data, callBackSave);
}
```

#### 5️⃣ callBackSave() — 저장 결과 처리 + 🚨 리다이렉트

```javascript
function callBackSave(ret_data) {
    // 결과 메시지를 alert으로 표시
    alert(ret_data.E_RMSG);

    // 저장 성공이면 목록으로 이동
    if ('S' == ret_data.E_RCODE) {
        goList();    // ← 🚨 이것이 리다이렉트의 원인!
    }
}
```

#### 6️⃣ goList() — 리다이렉트 실행

```javascript
function goList() {
    var param = '?ZORGEH=50021098&ZRESOGU=K001&ZUSDT_F=2026/02/02&...';

    // jQuery로 현재 페이지의 URL을 변경 → 다른 페이지로 이동
    $(location).attr('href', 'ins_res_list.htm' + param);
}
```

> 💡 **$(location).attr('href', '...')**  
> 이것은 브라우저에게 "이 URL로 이동해"라고 지시하는 것입니다. `window.location.href = '...'`와 같은 효과입니다.

---

## 3. 왜 리다이렉트가 발생하는가?

이제 원인이 명확합니다:

```
callBackSave() —[성공]→ goList() —→ $(location).attr('href', '목록URL')
```

**`callBackSave` 함수 안에서 `goList()`를 호출하기 때문에** 저장 후 자동으로 목록 페이지로 이동합니다.

### 해결 전략

`callBackSave()` 함수를 우리가 만든 새 함수로 **교체(오버라이드)**하면 됩니다.
새 함수는 alert은 그대로 보여주되, `goList()`는 호출하지 않습니다:

```javascript
// 기존 (리다이렉트 발생)
function callBackSave(ret_data) {
    alert(ret_data.E_RMSG);
    if ('S' == ret_data.E_RCODE) {
        goList();           // ← 이동!
    }
}

// 교체 후 (리다이렉트 방지)
function callBackSave(ret_data) {
    alert(ret_data.E_RMSG);
    if ('S' == ret_data.E_RCODE) {
        // goList() 호출 안 함  ← 이동하지 않음!
        console.log('저장 성공 — 현재 페이지 유지');
    }
}
```

간단해 보이지만, **Chrome 확장에서 웹 페이지의 함수를 교체하는 것**은 생각보다 복잡합니다.

---

## 4. 실패한 시도들과 그 이유

### 시도 1: Content Script에서 직접 오버라이드 ❌

```javascript
// contentscript.js (ISOLATED world)
window.callBackSave = function(ret_data) { ... };
```

**왜 실패?**

Chrome 확장의 Content Script는 **격리된 세계(ISOLATED world)**에서 실행됩니다.

```
┌────────────────────────────────┐
│         ERP 웹 페이지           │
│                                │
│  ┌──────────────────────────┐  │
│  │   MAIN world (페이지)      │  │
│  │   checkSave()             │  │
│  │   callBackSave()          │  │ ← 여기에 있는 함수를
│  │   goList()                │  │    교체해야 합니다
│  └──────────────────────────┘  │
│                                │
│  ┌──────────────────────────┐  │
│  │   ISOLATED world (확장)    │  │
│  │   contentscript.js        │  │ ← 여기서는 MAIN world의
│  │                           │  │    함수에 접근 불가!
│  └──────────────────────────┘  │
│                                │
└────────────────────────────────┘
```

> 💡 **MAIN vs ISOLATED world**  
> - **MAIN world**: 웹 페이지의 원래 JavaScript가 실행되는 공간  
> - **ISOLATED world**: 확장 프로그램의 Content Script가 실행되는 공간  
> - 두 세계는 **같은 DOM(HTML)은 공유**하지만, **JavaScript 변수/함수는 공유하지 않습니다**  
> - ISOLATED에서 `window.callBackSave = ...`를 해도 MAIN의 `callBackSave`에는 영향 없음

### 시도 2: `<script>` 태그 주입 ❌

```javascript
// contentscript.js에서
const script = document.createElement('script');
script.textContent = `window.callBackSave = function(ret_data) { ... }`;
document.head.appendChild(script);
```

**왜 실패?**

ERP 페이지의 **CSP(Content Security Policy)**가 인라인 스크립트를 차단합니다.

> 💡 **CSP란?**  
> 웹 페이지가 "이 페이지에서는 외부에서 주입된 스크립트를 실행하지 마세요"라고 브라우저에게 지시하는 보안 정책입니다. 해킹(XSS 공격) 방지를 위해 사용됩니다.

### 시도 3: CustomEvent로 세계 간 통신 ❌

```javascript
// MAIN world에서 이벤트 발생
document.dispatchEvent(new CustomEvent('save-intercept'));

// ISOLATED world에서 이벤트 수신
document.addEventListener('save-intercept', () => { /*저장*/ });
```

**왜 실패?**

MAIN↔ISOLATED 세계 간 `CustomEvent` 전달이 불안정합니다. 브라우저 버전에 따라 이벤트가 전달되지 않을 수 있습니다.

### 시도 4: `checkSave2()` 오버라이드 (잘못된 함수 이름) ❌

```javascript
// 존재하지 않는 함수를 오버라이드하려고 시도
if (typeof checkSave2 === 'function') { ... }
// → 항상 false! checkSave2는 ERP에 존재하지 않음
```

**왜 실패?**

ERP 소스 코드를 직접 확인하기 전까지, 저장 버튼이 `checkSave2()`를 호출한다고 잘못 추정했습니다. 실제로는 `checkSave()`였습니다.

> ⚠️ **교훈**: 추측하지 말고, **소스 코드를 직접 확인**하세요!

### 시도 5: Object.defineProperty 트랩 ❌

```javascript
// document_start에서 트랩 설치
Object.defineProperty(window, 'callBackSave', {
    get() { return newFunction; },
    set(fn) { originalFn = fn; }
});
```

**왜 실패?**

JavaScript의 **함수 선언 호이스팅(hoisting)** 때문입니다.

```javascript
// ERP 소스 코드에서 함수 선언:
function callBackSave(ret_data) { ... }
```

`function` 키워드로 선언된 함수는 스크립트가 실행되기 전에 **호이스팅(끌어올림)**됩니다. 이 과정에서 브라우저 엔진이 `Object.defineProperty`로 설정한 속성 설명자(property descriptor)를 **덮어씌울 수 있습니다**.

> 💡 **호이스팅(Hoisting)이란?**  
> JavaScript가 코드를 실행하기 전에, `function` 선언과 `var` 선언을 코드의 맨 위로 끌어올리는 동작입니다.
> ```javascript
> // 실제 코드
> console.log(foo());   // "hello" 출력됨!
> function foo() { return "hello"; }
> 
> // JavaScript 엔진이 내부적으로 이렇게 처리:
> function foo() { return "hello"; }  // ← 호이스팅됨
> console.log(foo());
> ```

---

## 5. 최종 해결: 3중 안전장치

### 왜 3중인가?

`callAJAX(submit_data, callBackSave)` 처럼 콜백을 인자로 넘기면, 함수 **참조(reference)**가 전달됩니다.
만약 `callAJAX`가 내부적으로 이 참조를 저장해뒀다가 나중에 호출한다면, 우리가 `window.callBackSave`를 교체해도 원래 함수가 호출될 수 있습니다.

```javascript
// 이런 상황이 발생할 수 있음:
var savedCallback = callBackSave;  // 원본 참조 저장

window.callBackSave = newFunction;  // 교체!

savedCallback(data);  // 하지만 원본이 호출됨 😢
```

그래서 여러 지점에서 차단하는 **3중 안전장치**가 필요합니다.

### Manifest V3의 `world: "MAIN"` 설정

먼저, MAIN world에서 스크립트를 실행하려면 `manifest.json`에 이렇게 설정합니다:

```json
{
    "content_scripts": [
        {
            "all_frames": true,
            "run_at": "document_idle",
            "world": "MAIN",
            "matches": ["*://erp.kbs.co.kr/.../ins_res_reg_0200.htm*"],
            "js": ["override_checksave2.js"]
        }
    ]
}
```

**각 설정의 의미:**

| 설정 | 값 | 의미 |
|------|-----|------|
| `world` | `"MAIN"` | 페이지의 원래 JavaScript 공간에서 실행 |
| `run_at` | `"document_idle"` | 모든 스크립트가 로드된 후 실행 |
| `all_frames` | `true` | iframe 내부에서도 실행 |
| `matches` | URL 패턴 | 이 URL에 해당하는 페이지에서만 실행 |

> 💡 **run_at 옵션 3가지**
> - `document_start`: HTML 파싱 시작 전 (스크립트가 아직 로드 안 됨)
> - `document_end`: DOM 구성 완료 후 (DOMContentLoaded와 비슷)
> - `document_idle`: 모든 것이 완료된 후 (가장 안전)

### override_checksave2.js — 전체 코드와 상세 해설

```javascript
// ============================================================
// IIFE(즉시 실행 함수)로 감싸서 전역 변수 오염 방지
// ============================================================
(function () {
```

> 💡 **IIFE란?** `(function(){ ... })();`  
> 함수를 정의하자마자 즉시 실행하는 패턴입니다. 내부 변수가 전역에 노출되지 않도록 보호합니다.

```javascript
    // 로그를 남겨서 "이 버전이 실행되고 있다"는 것을 확인
    console.log('[AutoReport] override_checksave2.js 로드됨 (v3 - document_idle)');
```

#### 안전장치 플래그

```javascript
    // 저장이 진행 중인지 추적하는 플래그 (2차 안전장치에서 사용)
    window._autoReportSaveInProgress = false;
```

이 플래그는 **"지금 저장 중이니까 goList를 차단해라"**라는 신호입니다.

#### 오버라이드 함수

```javascript
    function applyOverrides() {
```

##### 1차 안전장치: callBackSave 오버라이드

```javascript
        // ---- 1차 안전장치 ----
        // callBackSave 함수를 우리 것으로 교체
        if (typeof window.callBackSave === 'function') {

            window.callBackSave = function (ret_data) {
                // 원본과 동일: 결과 메시지를 alert으로 표시
                alert(ret_data.E_RMSG);

                if ('S' == ret_data.E_RCODE) {
                    // 원본은 여기서 goList()를 호출하지만,
                    // 우리는 호출하지 않는다!
                    console.log('[AutoReport] ✅ 저장 성공 — goList() 호출 안 함');
                    window._autoReportSaveInProgress = false;
                }
            };

            console.log('[AutoReport] ✅ callBackSave 오버라이드 완료');
        }
```

**이것만으로 충분할 수 있지만**, `callAJAX`가 콜백 참조를 미리 저장해둔 경우를 대비해 2차 안전장치가 필요합니다.

##### 2차 안전장치: goList 오버라이드

```javascript
        // ---- 2차 안전장치 ----
        // goList 자체를 감싸서, 저장 컨텍스트에서는 차단
        if (typeof window.goList === 'function') {

            // 원본 함수를 보관해둠
            var _originalGoList = window.goList;

            window.goList = function () {
                // 저장 진행 중이면 → 리다이렉트 차단
                if (window._autoReportSaveInProgress) {
                    window._autoReportSaveInProgress = false;
                    console.log('[AutoReport] 🚫 goList 차단됨');
                    return;  // 아무것도 하지 않고 종료
                }

                // 저장이 아닌 경우 (목록 버튼 클릭 등) → 정상 동작
                _originalGoList.call(this);
            };

            console.log('[AutoReport] ✅ goList 오버라이드 완료');
        }
```

> 💡 **_originalGoList.call(this)란?**  
> 원본 함수를 호출하되, `this` 컨텍스트를 유지하는 방법입니다. Java로 치면 `super.goList()`와 비슷합니다.

> 💡 **왜 goList를 완전히 없애지 않나?**  
> "목록" 버튼도 `goList()`를 호출합니다. 저장 후에만 차단하고, 사용자가 직접 "목록" 버튼을 누른 경우에는 정상 동작해야 하기 때문입니다.

##### 3차 안전장치: save 함수에 플래그 설정

```javascript
        // ---- 3차 안전장치 ----
        // save() 호출 시 플래그를 설정하여 2차 안전장치 활성화
        if (typeof window.save === 'function') {

            var _originalSave = window.save;

            window.save = function (CS_7523) {
                // "지금부터 저장 중!" 플래그 설정
                window._autoReportSaveInProgress = true;
                console.log('[AutoReport] 🔄 저장 시작 — 리다이렉트 차단 플래그 설정');

                // 원본 save 함수 실행 (실제 AJAX 저장 요청)
                _originalSave.call(this, CS_7523);
            };

            console.log('[AutoReport] ✅ save 오버라이드 완료');
        }
```

#### 마무리

```javascript
    // 오버라이드 적용 실행
    applyOverrides();
})();
```

### 3중 안전장치의 작동 흐름

```
사용자가 저장 버튼 클릭
    │
    ▼
checkSave() — 원본 그대로 동작 (변경 없음)
    │
    ▼
callAJAX(VC) → callBackCheckSave() → save() 호출
    │                                    │
    │                     ┌──────────────┘
    │                     ▼
    │              [3차] save() 오버라이드
    │              _autoReportSaveInProgress = true  ← 플래그 ON
    │              원본 save() 실행
    │                     │
    │                     ▼
    │              callAJAX(C1) → 서버 저장
    │                     │
    │                     ▼
    │              [1차] callBackSave() 오버라이드
    │              alert(결과 메시지)
    │              goList() 호출 안 함!          ← 1차 차단 성공 ✅
    │
    │   만약 1차가 실패하면 (원본 callBackSave가 호출되면):
    │              원본 callBackSave()
    │              alert(결과 메시지)
    │              goList() 호출 시도
    │                     │
    │                     ▼
    │              [2차] goList() 오버라이드
    │              _autoReportSaveInProgress == true
    │              → return (차단!)              ← 2차 차단 성공 ✅
    │
    ▼
결과: 리다이렉트 없이 같은 페이지에 머무름 😊
```

---

## 6. 핵심 개념 정리

### 🔑 이 프로젝트에서 배운 것들

#### 1. Chrome 확장의 두 세계 (MAIN vs ISOLATED)

| | MAIN world | ISOLATED world |
|---|---|---|
| **누가 사용** | 웹 페이지의 원래 JS | 확장 프로그램의 Content Script |
| **접근 가능** | 페이지의 모든 변수/함수 | 확장의 변수 + DOM |
| **설정 방법** | `"world": "MAIN"` | 기본값 (별도 설정 불필요) |

#### 2. 함수 오버라이드 패턴: 래핑(Wrapping)

기존 함수를 완전히 교체하지 않고, **감싸서** 원하는 동작을 추가하는 패턴:

```javascript
// 1. 원본 함수를 변수에 보관
var original = window.someFunction;

// 2. 새 함수로 교체하되, 필요하면 원본도 호출
window.someFunction = function(...args) {
    console.log('전처리: 함수 호출 전에 실행');
    
    // 조건에 따라 원본 호출 또는 차단
    if (shouldCallOriginal) {
        original.apply(this, args);  // 원본 실행
    }
    
    console.log('후처리: 함수 호출 후에 실행');
};
```

#### 3. run_at 타이밍의 중요성

| 타이밍 | 페이지 함수 접근 가능? | 사용 시나리오 |
|--------|----------------------|-------------|
| `document_start` | ❌ 아직 정의 안 됨 | 트랩 설치 (Object.defineProperty) |
| `document_end` | ⚠️ 일부만 가능 | DOM 조작 |
| `document_idle` | ✅ 모두 정의됨 | **함수 오버라이드에 가장 적합** |

#### 4. 디버깅에서 가장 중요한 것: 소스 코드 확인

이 프로젝트에서 가장 큰 시간 낭비는 **`checkSave2`라는 존재하지 않는 함수를 오버라이드하려 한 것**이었습니다.

> ⚠️ **교훈**: 추측하지 말고, DevTools에서 소스 코드를 직접 확인하세요!
> - `F12` → Sources 탭 → 페이지 소스 확인
> - 또는 Elements 탭에서 버튼의 `onclick` 속성 확인

#### 5. 버전 관리 & 확장 리로드

코드를 수정한 후 반드시:
1. `chrome://extensions` 에서 확장 프로그램 🔄 리로드
2. ERP 페이지 새로고침 (F5)
3. DevTools 콘솔에서 올바른 버전의 로그가 출력되는지 확인

> 콘솔에 이전 버전의 로그가 보이면 **새 코드가 적용되지 않은 것**입니다!

---

## 📚 참고 자료

- [Chrome Extensions - Content Scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Chrome Extensions - World in Manifest V3](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts#isolated_world)
- [MDN - Object.defineProperty](https://developer.mozilla.org/ko/docs/Web/JavaScript/Reference/Global_Objects/Object/defineProperty)
- [MDN - Hoisting](https://developer.mozilla.org/ko/docs/Glossary/Hoisting)
