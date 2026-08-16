# 콘솔 로그로 ERP 시스템 파악하기 — 리버스 엔지니어링 과정

> **목적**: 개발자가 KBS ERP(SAP) 시스템의 내부 구조를 **소스 코드나 API 문서 없이**, 오직 **브라우저 DevTools(F12)의 콘솔**만으로 파악한 전체 과정을 재현한다.  
> **대상**: 프로그래밍 비전공자도 따라 할 수 있는 수준으로 설명  
> **핵심 교훈**: "시스템을 수정하지 않고도, 관찰만으로 구조를 파악할 수 있다"

---

## 배경: 왜 리버스 엔지니어링이 필요했는가?

KBS ERP 시스템은 SAP 기반의 레거시 웹 시스템이다. 다음과 같은 제약이 있었다:

| 제약 | 상세 |
|------|------|
| **API 문서 없음** | SAP 내부 함수(FUNCTION_NAME)의 공식 문서가 외부에 제공되지 않음 |
| **소스 코드 접근 불가** | 서버 코드를 열어볼 권한이 없음 |
| **시스템 수정 불가** | ERP는 전사 시스템이므로 한 줄도 수정할 수 없음 |

**유일한 도구**: 브라우저의 F12 (개발자 도구) 콘솔

---

## 1단계: 페이지 구조 파악 — "뭐가 있는지 보자"

### 1.1 모든 입력 필드 스캔

ERP 페이지에 접속한 후, 콘솔(F12)에 아래 코드를 붙여넣고 실행한다:

```javascript
// 페이지의 모든 입력 필드(input, select, textarea) 목록 출력
console.table(
  Array.from(document.querySelectorAll('input, select, textarea')).map(el => ({
    태그: el.tagName,
    ID: el.id,
    Name: el.name,
    Type: el.type,
    현재값: el.value?.substring(0, 30)
  }))
);
```

**콘솔 출력 결과 (예시):**

| 태그 | ID | Name | Type | 현재값 |
|------|-----|------|------|--------|
| INPUT | TEMP_ZSUPER | | text | |
| INPUT | TEMP_ZBDATE | | text | |
| INPUT | TEMP_ZUSDT | | text | 2026/03/09 |
| SELECT | TEMP_ZPRODGU | | select-one | A2000001 |
| TEXTAREA | TEMP_ZWORKTX | | textarea | |
| INPUT | ZENAMET_TXT | | text | |

> 💡 **발견**: ERP 입력란의 ID 패턴이 `TEMP_` 접두사를 사용한다. 이것이 나중에 **자동 입력 대상** 필드가 된다.

### 1.2 버튼과 이벤트 핸들러 스캔

```javascript
// 모든 클릭 가능한 요소의 onclick 속성 확인
console.table(
  Array.from(document.querySelectorAll('[onclick], button, .btn_blue a')).map(el => ({
    ID: el.id || el.parentElement?.id,
    텍스트: el.textContent?.trim().substring(0, 20),
    onclick: el.getAttribute('onclick')?.substring(0, 50)
  }))
);
```

**콘솔 출력 결과 (예시):**

| ID | 텍스트 | onclick |
|----|--------|---------|
| btn_save | 저장 | `checkSave();` |
| btn_list | 목록 | `goList();` |
| btn_copy | 복사 | `copyData();` |

> 💡 **핵심 발견**: 저장 버튼의 onclick이 `checkSave()`이다. 이 함수가 저장 프로세스의 **진입점**이다. (초기에 `checkSave2`로 잘못 추정하여 시간을 낭비했다 — **추측하지 말고 직접 확인하는 것이 중요!**)

### 1.3 페이지에 정의된 JavaScript 함수 스캔

```javascript
// window 객체에서 사용자 정의 함수 목록 추출
const builtins = new Set(Object.getOwnPropertyNames(Window.prototype));
console.table(
  Object.getOwnPropertyNames(window)
    .filter(k => typeof window[k] === 'function' && !builtins.has(k))
    .map(name => ({ 함수명: name }))
);
```

**콘솔 출력 결과 (핵심 함수들):**

| 함수명 | (추정 역할) |
|--------|------------|
| `checkSave` | 저장 버튼 핸들러 |
| `callBackCheckSave` | 검증 결과 콜백 |
| `save` | 실제 저장 실행 |
| `callBackSave` | 저장 결과 콜백 |
| `goList` | 목록 페이지 이동 |
| `callAJAX` | SAP API 호출 공통 함수 |
| `makeStructure` | 폼 데이터 수집 |
| `setTeamData` | 근무자 목록 설정 |
| `callBackAssignCopyData` | 복사 데이터로 폼 채움 |

> 💡 **핵심 발견**: `setTeamData`, `callBackAssignCopyData` — 이 함수들이 나중에 자동화의 **핵심 도구**가 된다. 우리가 직접 데이터를 조합해서 이 함수를 호출하면, ERP가 원래 하는 것처럼 폼을 채울 수 있다.

---

## 2단계: 네트워크 호출 감시 — "어디에 뭘 보내는지 보자"

### 2.1 Network 탭으로 API 구조 파악

```
F12 → Network 탭 → "저장" 버튼 클릭 → POST 요청 관찰
```

**발견한 것:**

```
URL: /kbs(bD1rbyZjPTMwMA==)/zweb_common/ajax_common.htm
Method: POST
Content-Type: application/x-www-form-urlencoded
Body: ajax_params=...
```

### 2.2 URL 분석 — base64 디코딩

콘솔에서 확인:

```javascript
atob('bD1rbyZjPTMwMA==')
// 출력: "l=ko&c=300"
// → l=ko: 언어(한국어), c=300: SAP 클라이언트 코드
```

> 💡 **발견**: ERP URL 경로에 base64로 인코딩된 세션 정보가 포함되어 있다.

### 2.3 요청 body 분석 — FUNCTION_NAME 패턴

```javascript
// Network 탭에서 복사한 body를 디코딩
decodeURIComponent('ajax_params=%7B%22FUNCTION_NAME%22...%7D')
// 출력: {"FUNCTION_NAME":"ZWEB_PS820_0200","I_MODE":"VC","CS_7523":"{...}"}
```

**핵심 발견:**

```
┌──────────────────────────────────────────────────────┐
│ 모든 ERP API는 하나의 엔드포인트로 들어간다             │
│                                                      │
│ URL: /kbs(.../zweb_common/ajax_common.htm            │
│                                                      │
│ 어떤 기능을 호출할지는 FUNCTION_NAME으로 결정:          │
│   ZWEB_PS820_0200       ← 실적 등록/수정/조회          │
│   ZWEB_PS820_LIST       ← 실적 목록                   │
│   ZWEB_COMMON_GET_LOGIN_INFO ← 로그인 정보            │
│   ZWEB_PS_COMM_SHELP_MEM     ← 사원 정보 조회         │
│   ZWEB_PS002_0200       ← WBS 매핑 정보               │
│                                                      │
│ I_MODE로 동작 분기:                                    │
│   VC = Validation Check (검증)                        │
│   C1 = Create 1 (저장)                                │
│   C0 = Copy (복사)                                    │
│   R1 = Read 1 (조회)                                  │
└──────────────────────────────────────────────────────┘
```

---

## 3단계: 저장 흐름 추적 — "코드 한 줄 한 줄 따라가기"

### 3.1 함수 소스 코드 확인

콘솔에서 함수 이름만 입력하면 소스 코드가 출력된다:

```javascript
checkSave
// → function checkSave() { if(confirm('저장 하시겠습니까?')) { ... } }

callBackSave
// → function callBackSave(ret_data) { alert(ret_data.E_RMSG); if('S'==ret_data.E_RCODE) { goList(); } }

goList
// → function goList() { $(location).attr('href', 'ins_res_list.htm?...'); }
```

### 3.2 저장 흐름도 도출

위 관찰 결과를 종합하여 **리다이렉트의 원인**을 파악했다:

```
checkSave()
    ├── confirm("저장 하시겠습니까?")
    ├── makeStructure('reg_form') → 폼 데이터 수집
    └── callAJAX(data, callBackCheckSave)  ← VC 검증 요청
              │
              ▼
        callBackCheckSave(ret_data)
              ├── 'E': alert(에러)
              ├── 'S': save(CS_7523)
              └── 'C': confirm(중복) → save()
                            │
                            ▼
                      save(CS_7523)
                            └── callAJAX(data, callBackSave)  ← C1 저장 요청
                                        │
                                        ▼
                                  callBackSave(ret_data)
                                        ├── alert(결과)
                                        └── goList()  ←── 🚨 여기가 리다이렉트!
```

> 💡 **결론**: `callBackSave` 안에서 `goList()`를 호출하기 때문에 리다이렉트가 발생한다. 이 함수를 오버라이드하면 해결된다.

---

## 4단계: API 응답 형식 파악 — "받아보고 놀랐다"

### 4.1 SAP의 비표준 JSON 발견

콘솔에서 API 응답을 직접 확인:

```javascript
fetch('/kbs(bD1rbyZjPTMwMA==)/zweb_common/ajax_common.htm', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: `ajax_params=${encodeURIComponent(JSON.stringify({
    "FUNCTION_NAME": "ZWEB_COMMON_GET_LOGIN_INFO"
  }))}`
})
.then(r => r.text())
.then(txt => {
  console.log('원본 응답:');
  console.log(txt);
  // → { E_RCODE: "S", E_ID: "31298", E_DEPT_CODE: "50021098" }
  //   ↑ 키에 따옴표가 없다! 표준 JSON이 아니다!
});
```

**충격적 발견:**

```
❌ SAP 응답: { E_RCODE: "S", E_RMSG: "완료" }      ← 키에 따옴표 없음
✅ 표준 JSON: { "E_RCODE": "S", "E_RMSG": "완료" }  ← 키에 따옴표 필수
```

→ `JSON.parse()` 호출 시 에러 발생 → **정규식 교정 함수** 필요:

```javascript
const __hotfix_malform_json = _ =>
    _.replace(/\s*(['"])?([a-z0-9A-Z_\.]+)(['"])?\s*:([^,\}]+)(,)?/g,
              '"$2": $4$5');
```

### 4.2 이중 직렬화 발견

저장 API를 호출할 때 Network 탭에서 body를 분석하니, **JSON 안에 또 JSON 문자열**이 들어있었다:

```javascript
// body를 디코딩하면:
{
  "FUNCTION_NAME": "ZWEB_PS820_0200",
  "I_MODE": "C1",
  "CS_7523": "{\"ZWBS\":\"T2003-0143.0001\",...}",  // ← 문자열! 객체가 아님!
  "IT_7505": "[{\"ZPPERNR\":\"31298\",...}]"          // ← 이것도 문자열!
}
```

→ 내부 객체를 `JSON.stringify()`로 **한 번 더 감싸야** SAP이 인식한다.

---

## 5단계: Content Script에서의 콘솔 로그 전략

### 5.1 AutoReport가 사용한 콘솔 로그 패턴

개발 과정에서 콘솔 로그는 **4가지 목적**으로 사용되었다:

#### ① 로드 확인 — "내 코드가 정말 실행되고 있는가?"

```javascript
console.log('[AutoReport] override_checksave2.js 로드됨 (v3 - document_idle)');
console.log('[AutoReport] ✅ callBackSave 오버라이드 완료');
console.log('[AutoReport] ✅ goList 오버라이드 완료');
console.log('[AutoReport] ✅ save 오버라이드 완료');
```

> 💡 **이유**: 코드를 수정해도 **확장 리로드 + 페이지 새로고침**을 하지 않으면 이전 버전이 실행된다. 버전 정보를 로그에 포함하여 "지금 실행되는 것이 최신인가?"를 확인한다.

#### ② 동작 추적 — "실시간으로 뭐가 되고 있는가?"

```javascript
console.log('[AutoReport] 🔄 저장 시작 — 리다이렉트 차단 플래그 설정');
console.log('[AutoReport] ✅ 저장 성공 — goList() 호출 안 함');
console.log('[AutoReport] 🚫 goList 차단됨 (저장 후 리다이렉트 방지)');
```

> 💡 **이유**: 3중 안전장치 중 **어느 것이 동작했는지** 실시간으로 확인. 이모지(🔄, ✅, 🚫)를 사용하면 콘솔에서 시각적으로 구분이 쉽다.

#### ③ 데이터 검증 — "보내는 데이터가 맞는가?"

```javascript
console.log(`[AutoReport] 검증 요청 (VC): ${data.category} | ${data.pgmName} | ${data.start}~${data.end}`);
console.log(`[AutoReport] 저장 요청 (C1): ${data.category} | ${data.pgmName}`);
console.log(`[AutoReport] 근무자 ${data.workers.length}명 요청 → ${IT_7505.length}명 조회 성공`);
```

> 💡 **이유**: API에 보내기 직전의 데이터를 로그로 출력하면, 저장 실패 시 **"보낸 데이터가 잘못되었는지, 서버가 거부한 것인지"**를 구분할 수 있다.

#### ④ 매핑 결과 — "자동 판단이 맞는가?"

```javascript
console.log('[AutoReport] category.json 로드 완료:', Object.keys(_categoryMap).length, '건');
console.log(`[AutoReport] WBS ${pgmCode} → 카테고리: "${category}"`);
console.log(`[AutoReport] ✅ 제작구분 자동 입력: ${opt.value} (${opt.text.trim()})`);
console.log(`[AutoReport] ⚠️ 제작구분 "${prodguKeyword}" 옵션을 찾지 못함`);
```

> 💡 **이유**: 자동화에서 **"AI가 올바른 옵션을 선택했는지"** 확인. 잘못 선택된 경우 `⚠️` 경고로 즉시 알림.

### 5.2 Background Service Worker의 로그 패턴

```javascript
// background.js — API 중계 시 구분선으로 감싼 로그
console.log("----------");
console.log(new Date().toLocaleDateString());  // 시간
console.log(req);   // 요청 내용 전체
console.log(ctx);   // 발신자 정보 (어느 탭에서 보냈는가)
console.log(ret);   // API 응답 전체
console.log("----------");
```

> 💡 **이유**: Service Worker의 콘솔은 별도 위치(chrome://extensions → 서비스 워커 링크)에서 확인해야 한다. 구분선(`------`)으로 각 요청을 시각적으로 분리한다.

### 5.3 Popup의 로그 패턴

```javascript
// popup.js — 데이터 누락 경고
console.log(`${NAME}(${ID})에 대한 약칭이 없습니다`);
console.log(`${NAME}(${ID})에 대한 분류가 없습니다`);
```

> 💡 **이유**: 편성표에 새 프로그램이 추가되면 약칭 매핑이 없을 수 있다. 이 로그를 보고 `alias.json`이나 Google Sheets에 매핑을 추가한다.

---

## 6단계: DevTools 활용 — 콘솔 너머의 도구들

### 6.1 Elements 탭 — DOM 구조 탐색

```
F12 → Elements → 마우스로 요소 선택 (🔍 아이콘)
→ ERP의 중첩 테이블 구조를 시각적으로 파악
→ 특정 요소의 ID, class, 부모-자식 관계 확인
```

**이 과정에서 발견한 것:**
- ERP의 입력란이 `<table>` 안에 `<table>` 안에 중첩되어 있다
- 근무자 입력란의 부모 `<tr>`을 찾으려면 **while 루프로 탐색**해야 한다
- `etb_head`, `etb_bg` 클래스로 헤더/데이터 셀을 구분한다

### 6.2 Sources 탭 — 원본 코드 확인

```
F12 → Sources → erp.kbs.co.kr → 페이지 JavaScript 파일
→ checkSave, callBackSave, goList 함수의 실제 코드 확인
```

**이 과정에서의 교훈:**
- `checkSave2`라는 함수가 없다는 것을 Sources 탭에서 직접 확인했다
- **추측 기반 개발의 위험성**: 존재하지 않는 함수를 오버라이드하려다 3시간 낭비

### 6.3 Network 탭 — API 호출 감시

```
F12 → Network → XHR 필터 → 저장 버튼 클릭
→ ajax_common.htm 요청의 Headers/Payload/Response 확인
```

**이 과정에서 발견한 것:**
- 모든 API가 `ajax_common.htm` 단일 엔드포인트 사용
- `FUNCTION_NAME`으로 호출 대상 분기
- 비표준 JSON 응답 형식

---

## 발견 내용 요약 — "콘솔로 파악한 ERP 시스템 지도"

```
┌─────────────────────────────────────────────────────────┐
│                    ERP 시스템 구조                        │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  단일 엔드포인트                                   │    │
│  │  /kbs(base64)/zweb_common/ajax_common.htm        │    │
│  │                                                   │    │
│  │  FUNCTION_NAME으로 분기:                           │    │
│  │    ZWEB_PS820_0200   → 실적 CRUD                  │    │
│  │    ZWEB_PS820_LIST   → 실적 목록                   │    │
│  │    ZWEB_PS820_2000   → 이전 실적 조회              │    │
│  │    ZWEB_PS002_0200   → WBS 매핑                   │    │
│  │    ZWEB_PS_CJ20N     → WBS 회차 검색              │    │
│  │    ZWEB_PS_COMM_WBS  → WBS 자동완성               │    │
│  │    ZWEB_PS_COMM_SHELP_MEM → 사원 정보 조회         │    │
│  │    ZWEB_COMMON_GET_LOGIN_INFO → 로그인 정보        │    │
│  │    ZWEB_PS820_ZPROGU → 제작구분 목록               │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  I_MODE:  VC=검증  C1=저장  C0=복사  R1=조회  R2=검색   │
│                                                         │
│  응답: 비표준 JSON (키에 따옴표 없음) → 교정 필요         │
│  데이터: 내부 객체는 이중 JSON.stringify 필요             │
│                                                         │
│  저장 흐름:                                              │
│  checkSave → callAJAX(VC) → callBackCheckSave           │
│  → save → callAJAX(C1) → callBackSave → goList 🚨      │
│                                                         │
│  핵심 페이지 함수:                                       │
│    setTeamData()            → 근무자 목록 세팅            │
│    callBackAssignCopyData() → 폼 일괄 채움               │
│    makeStructure()          → 폼 데이터 수집              │
│    goList()                 → 목록 페이지 이동            │
└─────────────────────────────────────────────────────────┘
```

---

## 리버스 엔지니어링 마인드셋 요약

| 원칙 | 설명 |
|------|------|
| **관찰 먼저** | 시스템을 수정하기 전에, 있는 그대로를 충분히 관찰한다 |
| **추측 금지** | 함수 이름, API 형식 등을 추측하지 말고 직접 확인한다 |
| **단계적 접근** | 한 번에 전부 파악하려 하지 말고, 필드 → 함수 → API → 흐름 순서로 |
| **기록 필수** | 콘솔에서 발견한 것을 즉시 적어둔다 (이 문서가 바로 그 결과물) |
| **로그는 대화** | console.log는 시스템과의 대화다 — 질문(코드 실행)하고 답변(출력)을 읽는다 |

> 🎯 **결론**: 코드를 쓰기 전에 **시스템을 충분히 관찰하고 이해하는 시간**이, 결국 전체 개발 시간을 단축시킨다. 콘솔은 그 관찰을 위한 가장 강력한 도구다.
