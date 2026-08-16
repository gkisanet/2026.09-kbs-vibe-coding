# AutoReport 코드 분석 교육 문서

> 이 문서는 AutoReport 확장 프로그램의 코드에 사용된 **개발 패턴, 기법, 설계 원리**를 학습 목적으로 정리한 것이다.
> 
> **대상 독자**: 방송 시스템 운용에 정통하지만, 웹 프로그래밍 언어(JavaScript)에는 아직 익숙하지 않은 기술 전문가.
> 전문 용어(API, DOM, JSON 등)는 그대로 사용하되, 코드 내에서 **왜 이런 방식으로 구현했는지** 논리적 인과관계를 상세히 설명한다.

---

## 목차

1. [Chrome Extension 아키텍처](#1-chrome-extension-아키텍처)
2. [Content Script ↔ Page Context 브릿지](#2-content-script--page-context-브릿지)
3. [SAP ERP 비표준 JSON 교정](#3-sap-erp-비표준-json-교정)
4. [DOM 조작 패턴](#4-dom-조작-패턴)
5. [AJAX 기반 ERP API 호출](#5-ajax-기반-erp-api-호출)
6. [함수형 배열 처리](#6-함수형-배열-처리)
7. [Google Sheets JWT 인증](#7-google-sheets-jwt-인증)
8. [비동기 프로그래밍 패턴](#8-비동기-프로그래밍-패턴)
9. [이벤트 위임과 동적 UI](#9-이벤트-위임과-동적-ui)
10. [저장 리다이렉트 방지 (MAIN world 3중 안전장치)](#10-저장-리다이렉트-방지)

---

## 🏗️ 전체 구조 (Architecture)

### 설계 철학

AutoReport는 **기존 ERP 시스템을 수정하지 않고**, 그 위에 자동화 기능을 덧씌우는 구조다.
방송국에서 송출 장비에 외부 모듈을 연결할 때 **기존 신호 경로를 건드리지 않고** 분기(T-off)하는 것과 같은 원리다.

```
┌─ popup.html/js ────── 사용자 UI (확장 아이콘 클릭 시 현업일지 뷰어)
│
├─ background.js ────── Service Worker (외부 API 호출 중계소)
│                       → TVDSS, Google Sheets 등 외부 서버와의 통신 담당
│                       → ERP 페이지에서 직접 호출하면 CORS 에러 발생하므로 우회
│
├─ contentscript.js ─── ERP 페이지에 주입되는 핵심 자동화 코드
│                       → ERP 화면의 입력란, 버튼, 드롭다운을 직접 조작
│                       → 근무자 헬퍼, WBS 검색 등 편의 UI 추가
│
├─ override_checksave2.js ─ 저장 리다이렉트 방지 (MAIN world에서 실행)
│
└─ tvdss.js / sheet.js ─── 외부 API 모듈
```

### 핵심 제약과 해결

크롬 확장은 보안을 위해 3개의 격리된 영역에서 실행된다. 이 격리 때문에 **"할 수 있는 것"과 "할 수 없는 것"**이 영역마다 다르다:

| 구성요소 | 비유 | 할 수 있는 것 | 할 수 없는 것 |
|----------|------|---------------|---------------|
| **Popup** | 리모컨 화면 | 자기 UI 표시, 크롬 API | ERP 화면 조작 ❌ |
| **Background** | 주조정실 | 외부 서버 호출 (CORS 우회) | 모든 화면 DOM ❌ |
| **Content Script** | ERP에 파견된 직원 | ERP 화면(DOM) 조작 | ERP 내부 함수 호출 ❌ |

> 💡 **시니어의 팁**: Content Script가 ERP 내부 함수를 직접 호출할 수 없는 이유는 크롬의 **Isolated World** 정책 때문이다. 이것은 보안을 위한 설계이므로, 우회하려면 아래 2장의 "브릿지 패턴"이 필수적이다.

### 메시지 통신 — 격리된 영역 간의 소통

```javascript
// Popup → Content Script: "이 데이터로 ERP 폼을 채워줘"
chrome.tabs.sendMessage(tabId, { function: 'fill_erp_single', data: {...} });

// Content Script → Background: "TVDSS에서 편성 데이터 가져와줘"
// (Content Script는 외부 서버 직접 호출 불가 → Background에 위임)
chrome.runtime.sendMessage({ command: 'get_schedule', ... });
```

> ⚡ **성능 포인트**: 메시지 통신은 비동기적이므로, 응답이 올 때까지 기다려야 한다. `sendResponse`로 응답을 보내려면 반드시 `return true`를 해야 채널이 유지된다 (8장 참고).

---

## 1. Chrome Extension 아키텍처

*(위 "전체 구조" 참조)*

---

## 2. Content Script ↔ Page Context 브릿지

### 🔍 문제 상황

ERP 페이지에는 `setTeamData()`, `callBackAssignCopyData()` 같은 **내부 함수**가 이미 존재한다. 이 함수들을 호출하면 근무자 목록을 세팅하거나 폼 데이터를 한번에 채울 수 있다.

하지만 Content Script는 **Isolated World**(격리된 세계)에서 실행되므로, ERP 페이지의 JavaScript 함수에 접근할 수 없다. ERP 화면(DOM)은 보이지만, 그 **뒤에서 돌아가는 로직**에는 손을 댈 수 없는 것이다.

비유하면: 부조정실에서 스튜디오 안의 모니터 화면은 볼 수 있지만, 스튜디오 내부 장비의 설정 메뉴에는 직접 접근할 수 없는 상황과 같다.

### 🔍 해결: `execCodeOnPageContext()`

이 함수는 **"전달 메모를 DOM 요소에 붙여서 페이지에 실행시키는"** 트릭이다.

```javascript
const execCodeOnPageContext = (FUNC, ...DATA) => {
    // 1. 임시 DOM 요소 생성 (메모지 역할)
    document.body.insertAdjacentHTML('beforeend',
        `<div id="__code_on_page_context_executor"></div>`
    );
    const insert = document.querySelector('#__code_on_page_context_executor');

    // 2. 인라인 이벤트 핸들러에 실행할 함수를 적어 넣음
    //    핵심: 인라인 핸들러는 "페이지 컨텍스트"에서 실행됨!
    //    → 이것이 격리 벽을 넘는 유일한 방법
    insert.setAttribute(`onload`, `
        // 이 코드는 ERP 페이지의 세계에서 실행된다
        // → setTeamData() 등 페이지 함수 호출 가능!
        (${FUNC.toString()})(...arguments[0].detail)
    `);

    // 3. 이벤트를 발생시켜 코드 실행
    insert.dispatchEvent(new CustomEvent('load', { detail: DATA }));

    // 4. 정리 (메모지 제거)
    insert.remove();
};
```

### 동작 원리 (단계별)

```
Content Script (격리된 세계)              ERP 페이지 (원래 세계)
─────────────────────────               ─────────────────────────
1. <div onload="코드"> 생성
2. 이벤트 발생 ──────────────────────→  인라인 핸들러가 페이지 스코프에서 실행
                                         → setTeamData() 호출 성공!
3. 결과 수신 ←──────────────────────── CustomEvent로 결과 전달
4. div 제거 (흔적 제거)
```

### 🛠️ 사용 예시

```javascript
// ERP 페이지의 setTeamData() 호출 → 근무자 목록을 폼에 세팅
execCodeOnPageContext(IT_7505 => setTeamData(IT_7505), workerData);

// ERP 페이지의 전역 변수 읽기 → 현재 등록된 근무자 데이터 가져오기
const data = execCodeOnPageContext(() => data_IT_7505);

// 복합 작업: 폼 채움 + 화면에 이름 표시
execCodeOnPageContext(function (ERP) {
    callBackAssignCopyData(ERP);  // 폼 필드 일괄 채움
    $('#ZENAMET_TXT').html(ERP.IT_7505.map(_ => _.ZPENAME).join(', '));
}, erpData);
```

> 💡 **시니어의 팁**: 이 방식은 Chrome이 CSP(Content Security Policy)를 인라인 이벤트에 적용하지 않는 것을 이용한 트릭이다. 더 안정적인 방법은 `world: "MAIN"` 옵션을 사용하는 것으로, 10장의 저장 리다이렉트 방지에서 이 방식을 도입했다.

> 🛠️ **실전 응용**: 다른 웹 시스템에서도 페이지 내부 함수를 호출해야 할 때 이 패턴을 그대로 적용할 수 있다. `FUNC` 부분만 원하는 함수 호출로 바꾸면 된다.

---

## 3. SAP ERP 비표준 JSON 교정

### 🔍 문제

SAP ERP 서버가 보내는 응답이 **표준 JSON 형식을 따르지 않는다**:

```
❌ SAP 응답:  { E_RCODE: "S", E_RMSG: "저장 완료" }     ← 키에 따옴표 없음
✅ 표준 JSON: { "E_RCODE": "S", "E_RMSG": "저장 완료" } ← 키에 따옴표 있어야 함
```

JavaScript의 `JSON.parse()`는 표준 형식만 인식하므로, SAP 응답을 그대로 파싱하면 에러가 발생한다. **SAP 서버를 수정할 수 없으므로**, 받는 쪽에서 교정해야 한다.

### 🔍 해결: 정규식 교정

```javascript
// 모든 API 응답에 적용하는 "교정 필터"
const __hotfix_malform_json = _ =>
    _.replace(/\s*(['\"])?([a-z0-9A-Z_\.]+)(['\"])?\s*:([^,\}]+)(,)?/g,
              '"$2": $4$5');
// 하는 일: 따옴표 없는 키 → 쌍따옴표로 감싸기
// E_RCODE: "S"  →  "E_RCODE": "S"
```

### 적용 위치

모든 ERP API 호출의 응답 처리 체인에 포함:

```javascript
// 1. 서버 응답을 텍스트로 받음
// 2. 비표준 JSON을 표준으로 교정
// 3. 표준 JSON으로 파싱
.then(rsp => rsp.text())
.then(txt => __hotfix_malform_json(txt))  // ← 교정 단계
.then(str => JSON.parse(str));
```

> ⚡ **성능 포인트**: 정규식은 문자열 전체를 스캔하므로 대용량 응답에서는 느려질 수 있다. 하지만 ERP 응답은 대부분 수 KB 이하이므로 문제없다.

> 💡 **시니어의 팁**: 이 패턴은 "방어적 프로그래밍"의 대표적 사례다. 외부 시스템이 표준을 따르지 않을 때, **우리 쪽에서 정규화**하는 레이어를 두는 것. 나중에 SAP 버전 업그레이드로 JSON 형식이 바뀌더라도, 이 함수만 수정하면 된다.

---

## 4. DOM 조작 패턴

### 4.1 `insertAdjacentHTML` — 기존 화면을 깨뜨리지 않는 삽입

ERP 페이지에 헬퍼 UI(근무자 체크박스, WBS 검색 등)를 추가할 때, 기존 화면 요소를 건드리지 않고 옆에 삽입해야 한다.

```javascript
// ERP의 근무자 입력란 바로 아래에 체크박스 UI를 삽입
target.insertAdjacentHTML('afterend', `
    <tr id="member-helper-row">
        <td class="etb_head">부가기능</td>
        <td>체크박스들...</td>
    </tr>
`);
```

**삽입 위치 4가지:**
```
<!-- beforebegin: 요소 바로 앞 (형제) -->
<target>
    <!-- afterbegin: 첫 번째 자식으로 -->
    기존 내용
    <!-- beforeend: 마지막 자식으로 -->
</target>
<!-- afterend: 요소 바로 뒤 (형제) -->
```

> 🛠️ **실전 응용**: `innerHTML = "새 내용"` 은 기존 내용을 **전부 지우고** 새로 쓴다. ERP처럼 기존 이벤트가 걸려있는 페이지에서는 `insertAdjacentHTML`로 **추가만** 하는 것이 안전하다.

### 4.2 부모 요소 탐색 — ERP 테이블 구조에서 원하는 행 찾기

ERP 페이지의 HTML 구조는 복잡한 중첩 테이블로 되어 있다. 특정 입력란의 **부모 행(`<tr>`)을 찾아 올라가는** 패턴:

```javascript
// #ZENAMET_TXT 입력란에서 시작하여 위로 올라가며 <tr> 찾기
target = document.querySelector('#ZENAMET_TXT');
while (!(target.tagName == "TR" && target.querySelector(':scope > td.etb_bg')))
    target = target.parentNode;
// → 이제 target은 원하는 <tr> 행 = 여기에 UI를 삽입할 위치
```

> 💡 **시니어의 팁**: `:scope > td.etb_bg`에서 `>`는 **직계 자식만** 선택한다. 이 구분이 없으면 손자 레벨의 `td.etb_bg`까지 매칭되어 잘못된 행을 찾을 수 있다.

### 4.3 `focus`/`blur` — 드롭다운 UI의 열림/닫힘 제어

```javascript
// blur(포커스 해제) 시 헬퍼 UI 숨김
insert.addEventListener('blur', async e => {
    // 핵심: 내부 체크박스를 클릭해도 blur가 발생한다
    // → relatedTarget으로 "어디로 포커스가 이동하는지" 확인
    if (e.target.contains(e.relatedTarget)) {
        e.target.focus();  // 내부 요소 클릭이면 열린 상태 유지
        return;
    }
    e.target.style.display = "none";  // 외부 클릭이면 닫기
});
```

> ⚡ **성능 포인트**: `e.relatedTarget`은 포커스가 **이동할 대상**을 알려준다. 이걸 안 쓰면 체크박스를 클릭할 때마다 UI가 닫혀버리는 문제가 생긴다. 방송 장비의 인터록(interlock)과 비슷한 안전장치다.

---

## 5. AJAX 기반 ERP API 호출

### 🔍 ERP API 구조

KBS ERP는 **단일 엔드포인트**에 모든 API를 몰아넣은 구조다. 어떤 기능을 호출할지는 `FUNCTION_NAME` 파라미터로 결정한다:

```javascript
async function load_login_info() {
    return await fetch(`/kbs(${btoa('l=ko&c=300')})/zweb_common/ajax_common.htm`, {
        //              └── base64: "l=ko&c=300" (한국어, SAP 클라이언트 300)
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `ajax_params=${encodeURIComponent(JSON.stringify({
            "FUNCTION_NAME": "ZWEB_COMMON_GET_LOGIN_INFO"  // ← 이것으로 기능 분기
        }))}`
    })
    .then(rsp => rsp.text())
    .then(txt => __hotfix_malform_json(txt))  // 비표준 JSON 교정 (3장)
    .then(str => JSON.parse(str));
}
```

### URL 구조 분석

```
/kbs(bD1rbyZjPTMwMA==)/zweb_common/ajax_common.htm
      │                              │
      │                              └── 모든 API가 이 하나의 주소로 들어감
      └── base64("l=ko&c=300") = 언어(한국어) + SAP 클라이언트 코드
```

### 이중 JSON 직렬화 — SAP의 특이한 요구사항

SAP ERP는 중첩된 데이터를 보낼 때, 내부 객체를 **다시 JSON 문자열로 변환**해서 전송해야 한다:

```javascript
body: `ajax_params=${encodeURIComponent(JSON.stringify({
    FUNCTION_NAME: "ZWEB_PS820_0200",
    I_MODE: "VC",                              // VC = 검증, C1 = 저장
    CS_7523: JSON.stringify(formData),          // ← 객체를 문자열로 한 번 더!
    IT_7505: JSON.stringify(workerList)          // ← 이것도 마찬가지
}))}`
```

> 💡 **시니어의 팁**: 이런 "이중 직렬화"는 레거시 시스템에서 흔하다. API를 직접 테스트할 때 데이터가 전달되지 않으면, 내부 객체를 `JSON.stringify()`로 한 번 더 감싸야 하는지 확인해보라.

> 🛠️ **실전 응용**: 다른 KBS SAP API를 연동할 때도 이 패턴을 그대로 쓰면 된다. `FUNCTION_NAME`만 바꾸고, 필요한 파라미터를 추가하면 된다.

---

## 6. 함수형 배열 처리

### 🔍 체이닝 — 데이터를 파이프라인으로 변환

방송에서 영상 신호를 디코더 → 스위처 → 인코더로 순차 처리하듯, 데이터도 `.map()` → `.flat()` → `.filter()`로 순차 변환한다:

```javascript
// 사번 배열 → API 호출 → 첫 결과 추출 → ERP 형식으로 변환
const IT_7505 = (await load_member([10001, 20001, 30001]))
    .map(_ => _.ITAB[0])                                      // 각 응답에서 첫 결과 꺼냄
    .map(_ => ({ "ZPPERNR": _.PERNR, "ZPENAME": _.ENAME }));  // ERP가 원하는 형식으로 변환
// 결과: [{ ZPPERNR: "10001", ZPENAME: "홍길동" }, ...]

```

### 행/열 전환 — `reduce`로 조별 근무자를 직종별로 재배열

```javascript
// 원본: groups[조][직종] = [사번, 이름]
groups = [
    [감독1, 영상1, 음향1, 파일1],  // 1조
    [감독2, 영상2, 음향2, 파일2],  // 2조
    [감독3, 영상3, 음향3, 파일3],  // 3조
];

// 목표: 직종 우선 정렬 (감독들 먼저, 그 다음 영상들, ...)
const order_arr = groups.reduce(
    (ret, row) => row.map((_, i) => [...(ret[i] || []), row[i][0]]),
    []
).flat();
// 결과: [감독1, 감독2, 감독3, 영상1, 영상2, 영상3, 음향1, ...]
```

> 💡 **시니어의 팁**: `reduce`는 배열을 **"어떤 형태로든"** 변환할 수 있는 만능 도구다. 익숙하지 않으면 `for` 루프로 먼저 작성한 뒤, 나중에 `reduce`로 리팩토링하는 것을 추천한다.

---

## 7. Google Sheets JWT 인증

### 🔍 왜 Google Sheets를 쓰는가?

별도 서버를 운영하지 않고도 **프로그램 약칭, 근무표** 같은 데이터를 여러 사용자가 공유·편집할 수 있기 때문이다. Google Sheets를 데이터베이스 대용으로 활용한다.

### 인증 흐름

Google Sheets API에 접근하려면 **서비스 계정 인증**이 필요하다. 서버 없이 브라우저에서 직접 JWT(JSON Web Token)를 생성·서명한다:

```
1. JWT 헤더 + 페이로드 생성 (누가, 무엇에 접근할지)
2. RSA-SHA256 서명 (Web Crypto API — 브라우저 내장 암호화)
3. Google OAuth2 서버에서 접근 토큰 교환
4. 토큰으로 Sheets API 호출
```

```javascript
// 브라우저의 내장 암호화 API로 서명 (외부 라이브러리 불필요)
const key = await crypto.subtle.importKey(
    'pkcs8', keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
);
const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, data);
```

> ⚡ **성능 포인트**: JWT 토큰은 1시간 동안 유효하다. 매번 새 토큰을 발급하면 불필요한 지연이 생기므로, 캐싱하여 재사용하면 좋다.

> 🛠️ **실전 응용**: 서비스 계정 키가 코드에 포함되어 있으므로 보안에 주의. 키 로테이션이 필요하면 Google Cloud Console에서 새 키를 발급받아 `sheet.js`의 PEM 키를 교체하면 된다.

---

## 8. 비동기 프로그래밍 패턴

### 8.1 순차 처리 — 건별 저장에서 순서 보장

ERP에 여러 건을 저장할 때, **동시에** 보내면 서버 부하와 데이터 충돌이 발생한다. **하나씩 순차적으로** 처리해야 한다:

```javascript
// ✅ 올바른 순차 처리: for 루프 + await
for (let i = 0; i < programs.length; i++) {
    const result = await save_erp_record(programs[i], loginInfo);
    // 건 사이에 500ms 대기 (서버 부하 방지)
    await new Promise(r => setTimeout(r, 500));
}

// ❌ 잘못된 방법: forEach는 await를 무시한다!
programs.forEach(async (pgm) => {
    await save_erp_record(pgm, loginInfo);  // 순차 처리 안 됨 — 전부 동시 실행!
});
```

> ⚡ **성능 포인트**: `forEach`와 `await`를 함께 쓰면, 모든 건이 **동시에** 실행된다. 이것은 ERP 서버에 과부하를 주고 데이터 무결성 문제를 일으킬 수 있다. 비유하면 송출 파일을 **순서대로** 준비해야 하는데 동시에 전부 가져오려는 것과 같다.

### 8.2 `chrome.runtime.onMessage` — 비동기 응답의 함정

```javascript
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    (async () => {
        const result = await someAsyncWork();
        sendResponse(result);
    })();

    return true;  // ← 이 한 줄이 없으면 응답이 사라진다!
});
```

> **왜 `return true`가 필요한가?** 기본적으로 `addListener`가 끝나면 응답 채널이 즉시 닫힌다. `return true`는 "나중에 응답을 보낼 거니까 채널을 열어두라"는 의미다. 이것을 빠뜨리면 비동기 작업이 완료되어도 응답이 허공으로 사라진다.

### 8.3 TVDSS의 RETRY 패턴 — 세션 만료 자동 복구

```javascript
let retry = 0;
while (retry < 10) {
    const response = await fetch(url, { redirect: 'manual' });
    if (response.type === 'opaqueredirect') {
        // 세션 만료 → 자동 재로그인 후 재시도
        await do_login();
        retry++;
        continue;
    }
    return await response.json();  // 성공
}
```

> 🛠️ **실전 응용**: `redirect: 'manual'`은 서버가 리다이렉트 응답을 보내도 따라가지 않게 한다. TVDSS는 세션 만료 시 로그인 페이지로 리다이렉트하므로, 이것을 감지하여 재로그인한다.

---

## 9. 이벤트 위임과 동적 UI

### 조별 체크박스 — 전체 선택/개별 선택 동기화

3개 조 × 4개 직종 = 12개 체크박스의 상태를 동기화하는 로직:

```javascript
// "1조 전체" 체크박스 클릭 시 → 1조의 4명 모두 체크/해제
elem.addEventListener('change', e => {
    // 열(column) 인덱스로 해당 조의 체크박스들을 찾음
    const hidx = Array.from(e.target.parentNode.parentNode.children)
                      .indexOf(elem.parentNode);
    const cells = table.querySelectorAll(
        `:scope tr:nth-child(n+2) td:nth-child(${hidx + 1}) > input`
    );
    for (let _ of cells) _.checked = head.checked;
    refresh();  // 선택된 이름 미리보기 갱신
});
```

### 셀렉트박스 focus/blur 패턴 — 항상 최신 데이터 보장

WBS 검색 드롭다운은 **클릭할 때마다** 서버에서 최신 데이터를 가져온다:

```javascript
// focus(클릭) 시 → 서버에서 최신 프로그램 목록 가져와서 옵션 채움
select.addEventListener('focus', async e => {
    const data = await fetchLatestData();
    for (const item of data) {
        const option = document.createElement('option');
        option.value = item.id;
        option.innerText = item.label;
        e.target.appendChild(option);
    }
});

// blur(포커스 해제) 시 → 옵션 초기화 (다음 클릭 때 다시 로드)
select.addEventListener('blur', async e => {
    while (e.target.firstChild)
        e.target.removeChild(e.target.firstChild);
    e.target.insertAdjacentHTML('afterbegin',
        '<option disabled selected>선택하세요</option>'
    );
});
```

> 💡 **시니어의 팁**: 이 패턴은 "캐시 없는 항상 최신" 전략이다. 편성이 수시로 변경되는 방송 환경에서는, 캐시가 오래된 데이터를 보여줄 위험보다 **매번 최신 데이터를 가져오는** 것이 더 안전하다.

---

## 10. 저장 리다이렉트 방지

### 🔍 문제

ERP 저장 버튼을 클릭하면 저장 완료 후 **목록 페이지로 자동 이동**(리다이렉트)된다.
엑셀에서 여러 건을 연속으로 입력해야 하는 상황에서, 매번 목록으로 돌아가면 처음부터 다시 폼을 열어야 한다.

### ERP 내부 저장 흐름 (소스 분석 결과)

```
checkSave() → callAJAX(VC 검증) → callBackCheckSave()
    → save() → callAJAX(C1 저장) → callBackSave() → goList() ← 여기서 리다이렉트!
```

### ❌ 실패한 접근법들 (이 과정 자체가 중요한 학습)

| 시도 | 방법 | 실패 원인 |
|------|------|-----------|
| 1차 | `execCodeOnPageContext()`로 `checkSave2` 오버라이드 | ERP에 `checkSave2`라는 함수가 없었음 (잘못된 함수명) |
| 2차 | Content Script에서 폴링으로 `callBackSave` 오버라이드 | Isolated World라 페이지 함수에 접근 불가 |
| 3차 | `<script>` 태그 주입 | ERP의 CSP가 인라인 스크립트 차단 |

> 💡 **시니어의 팁**: 3번의 실패를 거친 끝에 **정확한 함수명 확인의 중요성**과 **Isolated World의 한계**를 깨달았다. 디버깅에서 "내가 아는 것이 맞는가?"를 먼저 검증하는 습관이 중요하다.

### ✅ 최종 해결: MAIN world + 3중 안전장치

**핵심 발견**: Manifest V3의 `world: "MAIN"` 옵션을 쓰면 **브라우저가 직접** 페이지 컨텍스트에 스크립트를 주입한다. CSP 제한을 받지 않으며, 페이지의 모든 함수에 접근할 수 있다.

```jsonc
// manifest.json — 페이지 컨텍스트에 직접 주입
{
    "content_scripts": [{
        "matches": ["*://erp.kbs.co.kr/*/ins_res_reg_*.htm*"],
        "js": ["override_checksave2.js"],
        "world": "MAIN",           // ← 페이지 컨텍스트에서 실행 (핵심!)
        "run_at": "document_idle"   // ← 페이지 로드 완료 후 실행
    }]
}
```

```javascript
// override_checksave2.js — 3중 안전장치
(function () {
    window._autoReportSaveInProgress = false;  // 저장 중 플래그

    function applyOverrides() {
        // ── 1차: callBackSave 오버라이드 ──
        // 저장 성공 콜백에서 goList() 호출을 제거
        window.callBackSave = function (ret_data) {
            alert(ret_data.E_RMSG);  // 결과 메시지만 표시
            if ('S' == ret_data.E_RCODE) {
                window._autoReportSaveInProgress = false;
                // goList() 호출 안 함! → 리다이렉트 방지
            }
        };

        // ── 2차: goList 오버라이드 ──
        // 혹시 다른 경로로 goList가 호출되어도 차단
        var _originalGoList = window.goList;
        window.goList = function () {
            if (window._autoReportSaveInProgress) {
                window._autoReportSaveInProgress = false;
                return;  // 차단! — 저장 직후에는 이동하지 않음
            }
            _originalGoList.call(this);  // 목록 버튼 수동 클릭은 허용
        };

        // ── 3차: save에 플래그 설정 ──
        var _originalSave = window.save;
        window.save = function (CS_7523) {
            window._autoReportSaveInProgress = true;  // "지금 저장 중" 표시
            _originalSave.call(this, CS_7523);
        };
    }

    applyOverrides();
})();
```

### 흐름도

```
사용자: 저장 버튼 클릭
    │
    ▼
[MAIN world] save() (오버라이드)
    │
    ├── 플래그 ON: "저장 시작됨"
    ├── 원래 save() 실행
    │       │
    │       ├── 서버에 VC 검증 요청
    │       ├── 서버에 C1 저장 요청
    │       └── callBackSave() (오버라이드됨)
    │               │
    │               ├── 결과 alert 표시
    │               └── goList() 호출 안 함! ← 1차 차단
    │
    └── 만약 goList()가 다른 경로로 호출되더라도
            │
            └── goList() (오버라이드됨)
                    ├── 플래그 ON? → 차단! ← 2차 차단
                    └── 플래그 OFF? → 정상 이동 허용
```

### 🔍 왜 3중 안전장치인가?

| 안전장치 | 대상 | 비유 | 필요한 이유 |
|----------|------|------|-------------|
| 1차 | `callBackSave` | 주 차단기 | 가장 직접적. 저장 콜백에서 `goList()` 제거 |
| 2차 | `goList` | 보조 차단기 | SAP 내부에서 콜백을 캐싱하여 1차를 우회할 수 있음 |
| 3차 | `save` | 플래그 스위치 | 2차가 "자동 저장 vs 수동 클릭"을 구분하기 위한 조건 |

> 방송 장비의 **이중/삼중 안전장치**와 같은 원리다. 하나가 뚫려도 다음 단계에서 차단된다.

> 🛠️ **실전 응용**: 다른 ERP 페이지에도 리다이렉트 방지가 필요하면, `manifest.json`의 `matches` 패턴만 추가하면 된다. 오버라이드할 함수명은 해당 페이지의 소스를 분석하여 확인해야 한다.

---

## 부록: 코딩 스타일 특징

### 변수 네이밍

| 패턴 | 예시 | 의미 |
|------|------|------|
| `UPPER_CASE` | `PATH`, `PARM`, `RSRC` | 변하지 않는 상수/설정값 |
| `_` (언더스코어) | `_.ENAME`, `_.PERNR` | 콜백의 매개변수 (처리 대상 항목) |
| `__` (더블 언더스코어) | `__hotfix_malform_json` | 내부 유틸리티 함수 |
| 한국어 | `템플릿_세부내용`, `그룹-1조` | 업무 특화 상수 (가독성 우선) |

### 패턴 요약

| 패턴 | 사용처 | 선택 이유 |
|------|--------|-----------|
| `insertAdjacentHTML` | 모든 DOM 삽입 | 기존 ERP 이벤트 유지 |
| `while(parent)` 탐색 | 부모 `<tr>` 찾기 | ERP 구조 변경에 유연 |
| `focus`/`blur` 쌍 | 셀렉트 UI | 항상 최신 데이터 보장 |
| `execCodeOnPageContext` | ERP 함수 호출 | Isolated World 우회 |
| `world: "MAIN"` | 함수 오버라이드 | CSP 우회 + 안정적 주입 |
| `__hotfix_malform_json` | 모든 API 응답 | SAP 비표준 JSON 대응 |
