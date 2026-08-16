# 🚀 AutoReport — KBS 바이브 코딩 실무 실습 교재 (Chrome 확장 프로그램)

> **KBS 사내 업무 자동화 실전 프로젝트**  
> 본 저장소는 KBS CJ TV 업무일지 자동화 크롬 확장 프로그램의 **전체 소스코드**와 **단계별 자습/수업용 교육 교재(`docs/`)**를 제공하는 독립 실습 패키지입니다.

---

## 🎯 프로젝트 학습 목표

- **Manifest V3** 기반 최신 크롬 확장 프로그램의 구조(Service Worker, Content Script, Popup)를 체득합니다.
- 복잡한 사내 레거시 시스템(SAP ERP, TVDSS 편성확인)을 F12 개발자 도구로 리버스 엔지니어링하여 분석하는 방법을 배웁니다.
- DOM 주입, 비동기 API 통신, Google Sheets 연동, 한셀(Hancel) 엑셀 파싱 등 **실무 웹 프론트엔드 핵심 기법 10선**을 실습합니다.

---

## 🔒 1. 환경 설정 및 보안 가이드 (필수)

본 공개 저장소는 보안 및 개인정보 보호를 위해 **실제 인증 키(`config.js`)와 임직원 사번/실명이 제외**되어 있습니다.

### 🔑 Step 1: 환경 설정 파일 (`config.js`) 생성

수업 실습 또는 실제 운영을 위해 아래 2가지 방법 중 하나로 `config.js`를 생성하세요:

#### 방법 A: 강사/관리자가 전달한 별도 파일 사용 (권장)
- 강사 또는 시스템 관리자가 사내망을 통해 안전하게 전달한 `config.js` 파일을 본 폴더(`3.autoreport_크롬확장앱/`)의 루트에 복사해 넣습니다.

#### 방법 B: 템플릿(`config.example.js`) 복사 후 직접 입력
1. `config.example.js`를 복사하여 `config.js` 파일을 생성합니다.
   ```bash
   cp config.example.js config.js
   ```
2. `config.js` 파일을 열고 안내받은 키 정보를 입력합니다:
   ```javascript
   export const CONFIG = {
       GOOGLE_SHEETS: {
           SHEET_ID: "강사 안내 구글 시트 ID",
           SERVICE_ACC: "서비스 계정 이메일",
           PRIVATE_PEM: `-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----`
       },
       TVDSS: {
           USERNAME: "TVDSS 조회 계정",
           PASSWORD: "TVDSS 비밀번호"
       },
       ERP: {
           ZORGEH: "50021098" // 소속 부서 조직코드
       }
   };
   ```

> ⚠️ **보안 주의사항**: 실제 키가 포함된 `config.js` 파일은 `.gitignore`에 등록되어 원격 저장소에 커밋되지 않도록 안전하게 보호됩니다.

---

### 👥 Step 2: 근무자 및 부서 정보 커스터마이징 실습

소스코드 내의 근무자 명단은 **가명 샘플 데이터(홍길동, 김철수 등)**로 설정되어 있습니다.  
실습 시 본인 부서나 조의 명단으로 변경해 보세요:

1. **[`erp_fields.js`](erp_fields.js)**: `WORKER_IDS` 객체에 소속 부서원의 사번(ZPPERNR), 벤더코드(ZLIFNR), 조직코드(ZPORGEH)를 등록합니다.
2. **[`contentscript.js`](contentscript.js)**: `groups` 배열의 `[사번, "이름"]` 데이터를 수정하여 화면의 체크박스 헬퍼에 반영합니다.

---

## 📚 2. 단계별 학습 커리큘럼 (`docs/`)

비전공자 및 초보자도 쉽게 따라올 수 있도록 **추천 학습 순서(`01` ~ `07`)**대로 구성되어 있습니다:

```text
3.autoreport_크롬확장앱/docs/
├── 01_TUTORIAL.md             # [1단계] AI와 함께하는 개발 — 사고 구조와 IDE 세팅
├── 02_ERP_REVERSE_ENG.md      # [2단계] F12 개발자 도구로 레거시 ERP 시스템 분석하기
├── 03_CLONE_CODING.md         # [3단계] 빈 폴더부터 완성까지 8단계 실습 클론 코딩
├── 04_DEVLOG.md               # [4단계] 개발자의 실제 사고 흐름과 기능별 의사결정 기록
├── 05_CODE_STUDY.md           # [5단계] 소스코드에 적용된 핵심 기법 10가지 상세 분석
├── 06_REDIRECT_FIX.md         # [6단계] MAIN world 주입 및 저장 리다이렉트 방지 기법
└── 07_TROUBLESHOOTING.md      # [7단계] 실전 버그 5건 해결 과정 및 오답 노트
```

| 순서 | 교재 | 핵심 학습 내용 |
|:---:|------|----------------|
| **1단계** | [01_TUTORIAL.md](docs/01_TUTORIAL.md) | AI 페어 프로그래밍 원리, 프롬프트 엔지니어링, 개발 환경 세팅 |
| **2단계** | [02_ERP_REVERSE_ENG.md](docs/02_ERP_REVERSE_ENG.md) | 네트워크 탭 패킷 분석, SAP AJAX 엔드포인트 분석, 비표준 JSON 교정 |
| **3단계** | [03_CLONE_CODING.md](docs/03_CLONE_CODING.md) | `manifest.json` 작성부터 DOM 제어 UI 주입까지 8단계 클론 코딩 |
| **4단계** | [04_DEVLOG.md](docs/04_DEVLOG.md) | "왜 이 기능을 만들었는가" — 6단계 개발 사고 흐름 및 아키텍처 결정 |
| **5단계** | [05_CODE_STUDY.md](docs/05_CODE_STUDY.md) | JWT RS256 클라이언트 서명, 한셀 ZIP 디코딩, Event Loop 큐 제어 등 10대 기법 |
| **6단계** | [06_REDIRECT_FIX.md](docs/06_REDIRECT_FIX.md) | 크롬 확장의 World 분리(ISOLATED vs MAIN)와 페이지 컨텍스트 제어 |
| **7단계** | [07_TROUBLESHOOTING.md](docs/07_TROUBLESHOOTING.md) | 통신 단절(Receiving end), 드롭다운 매칭 오탐, 한셀 XML 네임스페이스 해결 |

---

## ⚙️ 3. 확장 프로그램 설치 및 실행

1. Chrome 브라우저를 열고 주소창에 `chrome://extensions` 입력
2. 우측 상단의 **"개발자 모드"** 토글 스위치를 켭니다.
3. 좌측 상단의 **"압축해제된 확장 프로그램을 로드합니다"** 버튼 클릭
4. 현재 폴더(`3.autoreport_크롬확장앱`)를 선택합니다.
5. KBS 사내 ERP(`erp.kbs.co.kr`)의 리소스 실적 등록 화면에 접속하여 자동 주입 UI 및 기능을 확인합니다.

---

## 🏗️ 4. 시스템 아키텍처

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   Chrome Extension (AutoReport MV3)                    │
│  ┌─────────────────┐   ┌───────────────────┐   ┌─────────────────────┐ │
│  │   popup.html    │   │   background.js   │   │  contentscript.js   │ │
│  │   popup.js      │   │ (Service Worker)  │   │  (ERP DOM 제어)     │ │
│  │  (현업일지 뷰어) │   │  [TVDSS 중계]     │   │                     │ │
│  └────────┬────────┘   └─────────┬─────────┘   └──────────┬──────────┘ │
│           │                      │                        │            │
│           │                      ▼                        │            │
│           │              ┌───────────────┐                ▼            │
│           │              │   tvdss.js    │       ┌─────────────────┐   │
│           │              │  (편성 API)   │       │ override_check..│   │
│           │              └───────┬───────┘       │ (MAIN World)    │   │
│           │                      │               └────────┬────────┘   │
│           ▼                      │                        │            │
│    ┌────────────┐                │                        │            │
│    │  sheet.js  │                │                        │            │
│    │ (Sheets API│                │                        │            │
│    └──────┬─────┘                │                        │            │
└───────────┼──────────────────────┼────────────────────────┼────────────┘
            │ (JWT RS256)          │ (CORS 허용)            │ (AJAX)
            ▼                      ▼                        ▼
    ┌───────────────┐      ┌───────────────┐       ┌─────────────────┐
    │ Google Sheets │      │ tvdss.kbs..   │       │ erp.kbs.co.kr   │
    │ (약칭/근무표) │      │ (TV 편성확인) │       │ (SAP ERP 시스템)│
    └───────────────┘      └───────────────┘       └─────────────────┘
```

---

## 📂 5. 디렉토리 상세 구조

```text
3.autoreport_크롬확장앱/
├── docs/                      # 📚 단계별 교육 교재 (01~07)
├── data/                      # 🗂️ 프로그램 약칭, 분류, 근무조 JSON
├── _locales/                  # 🌐 Chrome 다국어 설정
├── config.example.js          # 📄 환경 설정 예시 템플릿 (GitHub 배포용)
├── config.js                  # 🔒 실제 보안 인증 키 파일 (.gitignore 보호)
├── .gitignore                 # 🚫 보안 파일 커밋 방지 설정
├── manifest.json              # ⚙️ Manifest V3 확장 프로그램 설정
├── background.js              # ⚡ Service Worker (TVDSS 중계)
├── contentscript.js           # 🧠 ERP DOM 제어 메인 로직
├── override_checksave2.js     # 🛡️ MAIN world 저장 리다이렉트 차단
├── popup.html / popup.js      # 🖥️ 현업일지 뷰어 팝업 UI 및 로직
├── erp_fields.js              # 📋 사번 및 드롭다운 코드 매핑
├── excel_parser.js            # 📊 엑셀 파서 (SheetJS + 한셀 우회 엔진)
├── sheet.js                   # 📡 Google Sheets API v4 연동 (JWT RS256)
├── tvdss.js                   # 📡 TVDSS 편성 API 클라이언트
└── README.md                  # 📖 본 안내서
```
