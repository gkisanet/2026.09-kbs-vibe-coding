# AutoReport 트러블슈팅 교육 문서

> 이 문서는 AutoReport 크롬 확장 프로그램을 개발하면서 실제로 만난 **버그와 해결 과정**을 교육 목적으로 정리한 것이다.
> "왜 이런 버그가 발생하는지"와 "어떻게 원인을 찾고 수정했는지"를 초보자도 이해할 수 있도록 상세히 설명한다.

---

## 목차

1. [플로팅 창에서 ERP 탭을 찾지 못하는 문제](#1-플로팅-창에서-erp-탭을-찾지-못하는-문제)
2. [저장 버튼 클릭 시 리다이렉트 되는 문제](#2-저장-버튼-클릭-시-리다이렉트-되는-문제)
3. [SAP ERP의 비표준 JSON 응답](#3-sap-erp의-비표준-json-응답)
4. [SheetJS 엑셀 파싱 실패](#4-sheetjs-엑셀-파싱-실패)
5. [getElementById + forEach 오류](#5-getelementbyid--foreach-오류)

---

## 1. 플로팅 창에서 ERP 탭을 찾지 못하는 문제

### 😵 증상

팝업에서 "입력" 버튼을 누르면 아래 에러가 뜨고 아무 일도 일어나지 않았다:

```
⚠️ "ERP 페이지(erp.kbs.co.kr)가 활성 탭에 열려 있어야 합니다."
```

분명히 브라우저에 ERP 탭이 열려 있는데도 이 에러가 발생했다.

### 🔍 원인 분석

**배경 지식:** 이 확장 프로그램은 팝업을 **두 가지 방식**으로 열 수 있다.

| 방식 | 코드 | 동작 |
|------|------|------|
| ① 기본 팝업 | `manifest.json`의 `default_popup` | 확장 아이콘 아래에 작은 창으로 열림 |
| ② 플로팅 창 | `chrome.windows.create({ type: 'popup' })` | **별도 윈도우**로 열림 |

현재는 ②번 플로팅 창 모드를 사용한다. 문제의 코드를 보자:

```javascript
// popup.js — 입력 버튼 클릭 시
const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true  // ← 🐛 여기가 문제!
});
```

`currentWindow: true`는 **"현재 이 코드가 실행되고 있는 윈도우"**에서 활성 탭을 찾으라는 의미다.

- **①번 방식**에서는 `currentWindow`가 **브라우저 본체 윈도우**를 가리키므로 ERP 탭을 찾을 수 있다.
- **②번 방식**에서는 `currentWindow`가 **popup 플로팅 윈도우 자체**를 가리킨다. 이 윈도우에는 `popup.html` 탭 하나만 있으므로 ERP 탭이 없다!

```
┌─────────────────────────────┐  ┌──────────────┐
│ 브라우저 본체 윈도우         │  │ 플로팅 윈도우 │
│  ┌─────┐ ┌─────┐ ┌───────┐ │  │  ┌──────────┐│
│  │구글  │ │유튜브│ │ERP 탭 │ │  │  │popup.html││ ← currentWindow는
│  └─────┘ └─────┘ └───────┘ │  │  └──────────┘│   여기를 가리킴!
└─────────────────────────────┘  └──────────────┘
```

### ✅ 해결

`currentWindow`를 쓰지 않고, **URL 패턴으로 모든 윈도우에서** ERP 탭을 찾도록 변경했다:

```diff
- const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
- if (!tab || !tab.url || !tab.url.includes('erp.kbs.co.kr')) {

+ const erpTabs = await chrome.tabs.query({ url: '*://erp.kbs.co.kr/*' });
+ const tab = erpTabs[0];
+ if (!tab) {
```

**핵심 교훈:**
> 크롬 확장에서 `currentWindow`는 "코드가 실행되는 윈도우"를 의미한다.
> 팝업이 별도 윈도우로 열리면 `currentWindow`가 달라진다.
> 특정 사이트를 찾아야 할 때는 **URL 패턴 매칭**이 더 안전하다.

---

## 2. 저장 버튼 클릭 시 리다이렉트 되는 문제

### 😵 증상

ERP 폼에 데이터를 자동으로 채운 후, "저장" 버튼을 누르면 **목록 페이지로 리다이렉트**되어 버렸다. 다음 건을 입력하려면 다시 등록 페이지로 돌아가야 해서 매우 불편했다.

### 🔍 원인 분석 — 1단계: ERP 원래 저장 흐름 이해

먼저 ERP 페이지의 원래 저장 흐름을 이해해야 한다:

```
저장 버튼 클릭
    → onclick="checkSave2()"
        → SAP 함수 호출: I_MODE="VC" (검증)
            → 검증 통과
                → SAP 함수 호출: I_MODE="C1" (저장)
                    → 저장 완료
                        → location.href = "목록페이지.htm"  ← 리다이렉트!
```

즉, `checkSave2()` 함수가 저장 후 **페이지를 이동시키는 원래 동작**이다.

### 🔍 원인 분석 — 2단계: checkSave2 오버라이드 실패

우리는 `checkSave2()`를 오버라이드하여 리다이렉트를 막으려 했다:

```javascript
execCodeOnPageContext(() => {
    if (typeof checkSave2 === 'function') {   // ← 🐛 이 조건이 false!
        window._original_checkSave2 = checkSave2;
        window.checkSave2 = function() {
            // 리다이렉트 대신 CustomEvent 발생
            document.dispatchEvent(new CustomEvent('autoreport-save-intercept'));
        };
    }
});
```

문제는 **타이밍**이다:

```
시간 →→→→→→→→→→→→→→→→→→→→→→→→→→→→→→→→→→→→→→→

① content script 등록 (document_start로 가장 먼저 실행)
② DOMContentLoaded 이벤트 발생
③ content script의 DOMContentLoaded 핸들러 실행   ← 여기서 오버라이드 시도!
④ ERP 페이지의 $(document).ready() 실행           ← checkSave2가 여기서 정의됨!
```

**핵심:** 크롬 확장의 content script는 `run_at: "document_start"`로 설정되어 있어서, DOMContentLoaded 핸들러가 **ERP 페이지의 jQuery ready 핸들러보다 먼저** 등록된다.

DOMContentLoaded가 발생하면 등록된 순서대로 핸들러가 실행되므로:
- ③에서 `typeof checkSave2`를 체크하면 아직 정의되지 않아 **`'undefined'`**
- ④에서 비로소 `checkSave2`가 정의됨
- 결과: **오버라이드가 적용되지 않음** → 원래 `checkSave2` 실행 → 리다이렉트 발생

### ✅ 해결: 폴링으로 안전하게 오버라이드

```javascript
execCodeOnPageContext(() => {
    function tryOverride() {
        if (typeof checkSave2 === 'function' && !window._checkSave2_overridden) {
            window._original_checkSave2 = checkSave2;
            window.checkSave2 = function() {
                document.dispatchEvent(new CustomEvent('autoreport-save-intercept'));
            };
            window._checkSave2_overridden = true;
            return true;
        }
        return false;
    }

    // 즉시 시도
    if (!tryOverride()) {
        // 실패하면 200ms 간격으로 재시도 (최대 10초)
        let attempts = 0;
        const interval = setInterval(() => {
            if (tryOverride() || ++attempts > 50) {
                clearInterval(interval);
            }
        }, 200);
    }
});
```

**핵심 교훈:**
> Content Script와 페이지 원본 스크립트는 **실행 순서가 보장되지 않는다.**
> 페이지 함수를 오버라이드할 때는 "아직 정의되지 않았을 수 있다"를 항상 고려해야 한다.
> **폴링(일정 간격으로 반복 확인)** 패턴으로 안전하게 대기할 수 있다.

### 추가 개선: 수동 입력 시에도 리다이렉트 방지

원래 코드에서는 popup으로 자동 채운 데이터(`__autoreport_pending`)가 없으면 **원래 `checkSave2()`를 실행**했다. 이러면 수동으로 폼을 채워도 리다이렉트가 발생한다.

개선된 코드에서는:
- `__autoreport_pending`이 있으면 → 해당 데이터로 API 저장
- 없으면 → **현재 폼의 DOM에서 데이터를 직접 읽어서** API 저장

두 경우 모두 리다이렉트 없이 저장된다.

---

## 3. SAP ERP의 비표준 JSON 응답

### 😵 증상

ERP API 응답을 `JSON.parse()`하면 에러가 발생했다:

```
SyntaxError: Unexpected token E in JSON at position 2
```

### 🔍 원인

SAP ERP 백엔드가 **표준 JSON이 아닌 응답**을 보내고 있었다:

```
// SAP가 보내는 응답 (비표준 — 키에 따옴표 없음)
{ E_RCODE: "S", E_RMSG: "저장 완료" }

// 올바른 JSON (키에 쌍따옴표 필수)
{ "E_RCODE": "S", "E_RMSG": "저장 완료" }
```

### ✅ 해결

정규식으로 키에 따옴표를 추가하는 전처리 함수를 만들었다:

```javascript
const __hotfix_malform_json = _ =>
    _.replace(/\s*(['"])?([a-z0-9A-Z_\.]+)(['"])?\s*:([^,\}]+)(,)?/g,
              '"$2": $4$5');
```

모든 API 호출에서 `.then(txt => __hotfix_malform_json(txt))` 단계를 거친다.

**핵심 교훈:**
> 외부 시스템이 표준을 따른다고 가정하지 마라.
> 특히 레거시 시스템(SAP 등)은 독자적인 형식을 사용할 수 있다.
> 정규식으로 데이터를 정규화하는 **방어적 프로그래밍**이 필요하다.

---

## 4. SheetJS 엑셀 파싱 실패

### 😵 증상

엑셀 파일을 `XLSX.read(buffer, {type: 'array'})`로 파싱하면 빈 배열이 반환되었다.

### 🔍 원인

두 가지 문제가 복합적으로 발생했다:

**문제 1:** `type: 'array'`가 ArrayBuffer 입력에서 실패
```javascript
// ❌ 실패
XLSX.read(buffer, { type: 'array' });

// ✅ 성공
XLSX.read(buffer, { type: 'binary' });
```

**문제 2:** `sheet_to_json()`이 병합 셀이 많은 시트에서 빈 배열 반환
```javascript
// ❌ 실패 — 병합 셀이 있으면 데이터 누락
XLSX.utils.sheet_to_json(sheet);

// ✅ 성공 — 셀을 직접 참조하여 데이터 추출
function sheetToArray(sheet) {
    const result = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
        const row = [];
        for (let c = range.s.c; c <= range.e.c; c++) {
            const cell = sheet[XLSX.utils.encode_cell({ r, c })];
            row.push(cell ? cell.v : '');
        }
        result.push(row);
    }
    return result;
}
```

### ✅ 해결

`type: 'binary'` 전략과 직접 셀 참조 방식(`sheetToArray()`)을 조합하여 해결.

**핵심 교훈:**
> 라이브러리의 고수준 API(`sheet_to_json`)가 실패하면, 저수준 API(직접 셀 참조)로 우회한다.
> 문제를 한 번에 해결하려 하지 말고 **단계별로 디버깅**하라 (파일 읽기 → 파싱 → 변환 각 단계를 분리).

---

## 5. getElementById + forEach 오류

### 😵 증상

`save_no_redirect.js`에 작성된 저장 인터셉트 코드가 아무 동작도 하지 않았다.

### 🔍 원인

```javascript
// ❌ 잘못된 코드
document.getElementById("btn_save").forEach(...)
```

`getElementById()`는 **단일 요소**를 반환한다. 배열이 아니므로 `forEach`를 쓸 수 없다.

- `getElementById()` → 단일 Element 또는 null
- `getElementsByClassName()` → HTMLCollection (유사 배열)
- `querySelectorAll()` → NodeList (forEach 가능)

### ✅ 해결

이 접근 자체를 폐기하고, `checkSave2()` 오버라이드 + CustomEvent 방식으로 전면 재설계했다.

**핵심 교훈:**
> DOM API의 반환 타입을 정확히 알아야 한다.
> `getElementById` → 단일 요소, `querySelectorAll` → 목록.
> 코드가 "아무 동작도 안 할 때"는 에러가 조용히 무시되고 있을 가능성이 높다.

---

## 트러블슈팅 사고 프로세스 요약

어떤 버그든 아래 순서로 접근하면 대부분 해결할 수 있다:

```
1. 증상 확인 — 정확히 뭐가 안 되는가?
2. 예상 동작 — 원래 어떻게 동작해야 하는가?
3. 실제 동작 추적 — 코드가 실제로 어떤 경로로 실행되는가?
4. 차이점 발견 — 예상과 실제의 차이는 무엇인가?
5. 가설 수립 — 왜 차이가 발생하는가?
6. 검증 — console.log 또는 디버거로 가설을 확인
7. 수정 — 근본 원인을 해결하는 코드 작성
```
