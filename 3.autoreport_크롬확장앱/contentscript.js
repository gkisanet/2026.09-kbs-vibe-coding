
// ============================================================================
// contentscript.js
// ============================================================================
// KBS ERP 리소스 실적 입력 페이지에 주입되는 Content Script.
// 결재자 자동 입력, 근무자 선택 헬퍼, WBS 검색 헬퍼, 이전 실적 복사 기능을 제공한다.
//
// 주입 대상 페이지 (manifest.json에 정의):
//   - ins_res_list.htm      : 리소스 실적 목록 (메인)
//   - ins_res_reg_0200.htm  : TS(TV 서비스) 실적 등록
//   - ins_res_reg_0320.htm  : NS(뉴스 서비스) 실적 등록
// ============================================================================

// ---------------------------------------------------------------------------
// [유틸리티] 비표준 JSON 교정
// ERP SAP 백엔드가 키에 따옴표 없이 JSON을 응답하는 경우가 있어,
// 정규식으로 키를 쌍따옴표로 감싸 표준 JSON으로 변환한다.
// 참조: stackoverflow.com/questions/9637517
// ---------------------------------------------------------------------------
const __hotfix_malform_json = _ => _.replace(/\s*(['"])?([a-z0-9A-Z_\.]+)(['"])?\s*:([^,\}]+)(,)?/g, '"$2": $4$5');

// ---------------------------------------------------------------------------
// [유틸리티] Content Script → Page Context 코드 실행 브릿지
// Chrome 확장의 Content Script는 페이지와 격리된 JS 컨텍스트에서 실행되므로,
// 페이지 원본 함수(예: setTeamData, callBackAssignCopyData)를 호출하려면
// DOM을 통해 인라인 이벤트 핸들러로 코드를 삽입하는 우회 기법이 필요하다.
//
// 동작 원리:
//   1. 임시 DOM 요소 생성 (#__code_on_page_context_executor)
//   2. onload 인라인 핸들러에 실행할 함수 문자열 삽입
//   3. CustomEvent로 DATA 전달 → 페이지 컨텍스트에서 함수 실행
//   4. blur 이벤트로 결과를 다시 Content Script 쪽으로 반환
//   5. 임시 DOM 요소 제거
//
// 참조: stackoverflow.com/questions/9515704
//       stackoverflow.com/questions/15277800
// ---------------------------------------------------------------------------
const execCodeOnPageContext = (FUNC, ...DATA) => {
	const TX_EVENT = 'load';		// Content Script → Page Context 전송 이벤트
	const RX_EVENT = 'blur';		// Page Context → Content Script 반환 이벤트

	let retr = undefined;			// 반환값 저장 변수

	// 임시 DOM 요소를 body 끝에 삽입
	document.body.insertAdjacentHTML('beforeend', `
		<div id="__code_on_page_context_executor"></div>
	`);

	const insert = document.querySelector('#__code_on_page_context_executor');
	// 인라인 이벤트 핸들러에 실행 함수를 문자열로 삽입 (페이지 컨텍스트에서 실행됨)
	insert.setAttribute(`on${TX_EVENT}`, `
		document
			.querySelector('#__code_on_page_context_executor')
			.dispatchEvent(
				new CustomEvent('${RX_EVENT}', {detail: (${FUNC.toString()})(...arguments[0].detail)})
			);
	`.replace(/^\s+/gm, '').replace(/(\r\n|\n|\r)/gm, ''));
	// 반환 이벤트 수신 → 결과를 retr에 저장
	insert.addEventListener(RX_EVENT, _ => retr = _.detail);
	// 실행 이벤트 발생 (DATA를 detail로 전달)
	insert.dispatchEvent(new CustomEvent(TX_EVENT, { detail: DATA }));
	// 임시 요소 정리
	insert.remove();

	return retr;
};

// ---------------------------------------------------------------------------
// [유틸리티] 날짜/주간 계산 함수들
// KBS 편성은 월요일 시작 주간 단위로 관리되므로, 주간 관련 계산이 필수적이다.
// ---------------------------------------------------------------------------

// 주어진 날짜의 직전 월요일(포함) 날짜를 구한다.
// 월요일이 주간 편성의 시작이므로, 주간 비교의 기준점으로 사용된다.
const __calc_week_head = _ => new Date(
	new Date(_.getFullYear(), _.getMonth(), _.getDate()).getTime() - (((_.getDay() - 1 + 7) % 7) * (24 * 60 * 60 * 1000))
);

// 두 날짜 사이의 주(week) 차이를 계산한다.
// 각 날짜를 해당 주의 월요일로 맞춘 뒤 차이를 7일 단위로 나눈다.
const __calc_week_difference = (_1, _2) => parseInt(
	(__calc_week_head(_2) - __calc_week_head(_1)) / (7 * 24 * 60 * 60 * 1000)
);

// 두 날짜 사이의 월(month) 차이를 계산한다.
const __calc_month_difference = (_1, _2) =>
	(_2.getFullYear() - _1.getFullYear()) * 12 + (_2.getMonth() - _1.getMonth());


// 두 날짜 사이의 일(day) 차이를 계산한다.
// 시분초를 제거하고 순수 날짜 차이만 구한다.
const __calc_day_difference = (_1, _2) =>
	(new Date(_2.getFullYear(), _2.getMonth(), _2.getDate()) - new Date(_1.getFullYear(), _1.getMonth(), _1.getDate())) / (24 * 60 * 60 * 1000);

// ============================================================================
// ERP SAP 백엔드 API 래퍼 함수들
// ============================================================================
// 모든 함수가 동일한 AJAX 엔드포인트(/zweb_common/ajax_common.htm)를 사용하며,
// FUNCTION_NAME 파라미터로 호출할 SAP 함수를 지정한다.
// URL의 btoa('l=ko&c=300') 부분은 언어(한국어)와 클라이언트 코드를 인코딩한 것이다.
// ============================================================================

// ---------------------------------------------------------------------------
// [API] 로그인 정보 조회
// 현재 ERP 세션의 사용자 정보(사번, 부서코드 등)를 가져온다.
// 반환: { E_ID: 로그인ID, E_DEPT_CODE: 부서코드, ... }
// ---------------------------------------------------------------------------
async function load_login_info() {
	return await fetch(`/kbs(${btoa('l=ko\u0026c=300')})/zweb_common/ajax_common.htm`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: `ajax_params=${encodeURIComponent(JSON.stringify(
			{
				"FUNCTION_NAME": "ZWEB_COMMON_GET_LOGIN_INFO"
			}
		))}`
	})
		.then(rsp => rsp.text())
		.then(txt => __hotfix_malform_json(txt))
		.then(str => JSON.parse(str));
}

// ---------------------------------------------------------------------------
// [API] 리소스 실적 목록 조회
// 지정 기간(DATE1~DATE2)의 리소스 실적 목록을 가져온다.
// I_ZCOD1: 리소스 구분 (K001=TS, K003=NS)
// ---------------------------------------------------------------------------
async function list_erp(DATE1, DATE2) {
	const login_info = await load_login_info();

	return await fetch(`/kbs(${btoa('l=ko\u0026c=300')})/zweb_common/ajax_common.htm`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: `ajax_params=${encodeURIComponent(JSON.stringify(
			{
				"FUNCTION_NAME": "ZWEB_PS820_LIST",
				"I_MODE": "R1",
				"I_ZORGEH": login_info.E_DEPT_CODE,
				"I_ZCOD1": "K001",		// K001=TS, K003=NS
				"I_ZCOD2": "",
				"I_ZUSDT_F": `${DATE1.toLocaleDateString('ko-kr', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/[\s\.]/g, '')}`,
				"I_ZUSDT_T": `${DATE2.toLocaleDateString('ko-kr', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/[\s\.]/g, '')}`,
				"I_PERNR": "",
				"I_LOGIN_ID": login_info.E_ID
			}
		))}`
	})
		.then(rsp => rsp.text())
		.then(txt => __hotfix_malform_json(txt))
		.then(str => JSON.parse(str));
}

// ---------------------------------------------------------------------------
// [API] 제작구분 목록 조회
// 리소스 구분(RSRC)에 따른 제작구분 옵션 목록을 가져온다.
// (예: 생방, 녹화, 송출, 더빙 등)
// ---------------------------------------------------------------------------
async function list_produce_type(RSRC) {
	return await fetch(`/kbs(${btoa('l=ko\u0026c=300')})/zweb_common/ajax_common.htm`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: `ajax_params=${encodeURIComponent(JSON.stringify(
			{
				"FUNCTION_NAME": "ZWEB_PS820_ZPROGU",
				"I_ZRESOGU": RSRC
			}
		))}`
	})
		.then(rsp => rsp.text())
		.then(txt => __hotfix_malform_json(txt))
		.then(str => JSON.parse(str));
}

// ---------------------------------------------------------------------------
// [API] 이전 실적 목록 조회 (복사 원본 선택용)
// 지정 기간 내 해당 리소스 구분의 기존 실적을 조회한다.
// 사용자가 과거 실적을 선택하여 현재 입력 폼에 복사할 수 있도록 한다.
// ---------------------------------------------------------------------------
async function history_erp(DATE1, DATE2, RSRC) {
	const login_info = await load_login_info();

	return await fetch(`/kbs(${btoa('l=ko\u0026c=300')})/zweb_common/ajax_common.htm`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: `ajax_params=${encodeURIComponent(JSON.stringify(
			{
				"FUNCTION_NAME": "ZWEB_PS820_2000",
				"I_MODE": "R2",
				"I_ORGEH": login_info.E_DEPT_CODE,
				"I_ZRESOGU": RSRC || 'K001',		// K001=TS, K003=NS
				"I_SDATE": `${DATE1.toLocaleDateString('ko-kr', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/[\s\.]/g, '')}`,
				"I_EDATE": `${DATE2.toLocaleDateString('ko-kr', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/[\s\.]/g, '')}`,
				"I_PERNR": ""
			}
		))}`
	})
		.then(rsp => rsp.text())
		.then(txt => __hotfix_malform_json(txt))
		.then(str => JSON.parse(str));
}

// ---------------------------------------------------------------------------
// [API] 특정 실적 상세 로드 (복사 실행용)
// ZWSEQ(실적 일련번호)로 과거 실적의 전체 데이터를 가져온다.
// 이 데이터를 현재 입력 폼에 callBackAssignCopyData()로 채워 넣는다.
// ---------------------------------------------------------------------------
async function load_erp(ZWSEQ) {
	const login_info = await load_login_info();

	return await fetch(`/kbs(${btoa('l=ko\u0026c=300')})/zweb_common/ajax_common.htm`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: `ajax_params=${encodeURIComponent(JSON.stringify(
			{
				"FUNCTION_NAME": "ZWEB_PS820_0200",
				"I_MODE": "C0",						// C0 = Copy 모드
				"IS14": JSON.stringify({
					"ZGUBU": 'ACT',
					"ZORGEH": login_info.E_DEPT_CODE,
					"ZWSEQ": ZWSEQ
				})
			}
		))}`
	})
		.then(rsp => rsp.text())
		.then(txt => __hotfix_malform_json(txt))
		.then(str => JSON.parse(str));
}

// ---------------------------------------------------------------------------
// [API] WBS 코드 자동완성 정보
// WBS 코드 입력 시 해당 프로그램의 기본 정보를 가져온다.
// ---------------------------------------------------------------------------
async function load_erp_wbs(WBS) {
	return await fetch(`/kbs(${btoa('l=ko\u0026c=300')})/zweb_common/ajax_common.htm`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: `ajax_params=${encodeURIComponent(JSON.stringify(
			{
				"FUNCTION_NAME": "ZWEB_PS_COMM_WBS",
				"I_POSID": WBS
			}
		))}`
	})
		.then(rsp => rsp.text())
		.then(txt => __hotfix_malform_json(txt))
		.then(str => JSON.parse(str));
}

// ---------------------------------------------------------------------------
// [API] 근무자 정보 일괄 조회
// 사번 배열(EMPNO_LIST)을 받아 각 사번의 사원 정보(이름 등)를 조회한다.
// 여러 사번을 하나의 요청으로 일괄 조회하기 위해 배열을 JSON으로 전달한다.
// ---------------------------------------------------------------------------
async function load_member(EMPNO_LIST) {
	// 배열이 아닌 경우 빈 배열로 초기화
	if (EMPNO_LIST.constructor !== Array)
		EMPNO_LIST = [];

	return await fetch(`/kbs(${btoa('l=ko\u0026c=300')})/zweb_common/ajax_common.htm`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: `ajax_params=${encodeURIComponent(JSON.stringify(
			EMPNO_LIST.map(_ => ({
				"FUNCTION_NAME": "ZWEB_PS_COMM_SHELP_MEM",
				"I_MODE": "R2",
				"I_PERNR": _
			}))
		))}`
	})
		.then(rsp => rsp.text())
		.then(txt => __hotfix_malform_json(txt))
		.then(str => JSON.parse(str));
}

// ---------------------------------------------------------------------------
// [API] WBS 매핑 정보 조회 (기간 중 편성 프로그램)
// 지정 기간(DATE1~DATE2) 내의 편성 프로그램에 대한 WBS 매핑 정보를 가져온다.
// 본방(RERUN=01)과 재방(RERUN=02)을 각각 조회하여 합친 후,
// 편성취소된 항목은 제거하고 방송예정일시 순으로 정렬하여 반환한다.
// ---------------------------------------------------------------------------
async function list_wbs(DATE1, DATE2) {
	const login_info = await load_login_info();

	let program = [];

	// --- 1차: 본방(RERUN=01) 조회 ---
	await fetch(`/kbs(${btoa('l=ko\u0026c=300')})/zweb_common/ajax_common.htm`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: `ajax_params=${encodeURIComponent(JSON.stringify(
			{
				"FUNCTION_NAME": "ZWEB_PS002_0200",
				"I_MODE": "R1",
				"IS_ZSPS002_0200": JSON.stringify(
					{
						"LOGIN_ID": login_info.E_ID,
						"CHANNEL_CODE": "11",								// 11 = KBS 1TV
						"PROGRAMMING_LOCAL_STATION_CODE": "70",				// 70 = 청주(CJ)
						"PRODUCTION_DEPARTMENT_CODE": "",
						"MAPPING_STATUS": "",
						"RERUN_CLASSIFICATION": "01",						// 01 = 본방
						"START_DATE": `${DATE1.toLocaleDateString('ko-kr', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/[\s\.]/g, '')}`,
						"END_DATE": `${DATE2.toLocaleDateString('ko-kr', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/[\s\.]/g, '')}`
					}
				)
			}
		))}`
	})
		.then(rsp => rsp.text())
		.then(txt => __hotfix_malform_json(txt))
		.then(str => JSON.parse(str))
		.then(obj => program.push(...obj.IT0200));

	// --- 2차: 재방(RERUN=02) 조회 ---
	await fetch(`/kbs(${btoa('l=ko\u0026c=300')})/zweb_common/ajax_common.htm`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: `ajax_params=${encodeURIComponent(JSON.stringify(
			{
				"FUNCTION_NAME": "ZWEB_PS002_0200",
				"I_MODE": "R1",
				"IS_ZSPS002_0200": JSON.stringify(
					{
						"LOGIN_ID": login_info.E_ID,
						"CHANNEL_CODE": "11",
						"PROGRAMMING_LOCAL_STATION_CODE": "70",
						"PRODUCTION_DEPARTMENT_CODE": "",
						"MAPPING_STATUS": "",
						"RERUN_CLASSIFICATION": "02",						// 02 = 재방
						"START_DATE": `${DATE1.toLocaleDateString('ko-kr', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/[\s\.]/g, '')}`,
						"END_DATE": `${DATE2.toLocaleDateString('ko-kr', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/[\s\.]/g, '')}`
					}
				)
			}
		))}`
	})
		.then(rsp => rsp.text())
		.then(txt => __hotfix_malform_json(txt))
		.then(str => JSON.parse(str))
		.then(obj => program.push(...obj.IT0200));

	// 편성취소 항목 제거 후, 방송예정일→방송예정시간 순 정렬
	program = program
		.filter(e => e.PROGRAM_ID_STATUS_CODE != '편성취소')
		.sort((a, b) => {
			if (a.BROADCAST_PLANNED_DATE == b.BROADCAST_PLANNED_DATE)
				return a.BROADCAST_PLANNED_TIME.replace(':', '') - b.BROADCAST_PLANNED_TIME.replace(':', '');
			else
				return a.BROADCAST_PLANNED_DATE.replace('/', '') - b.BROADCAST_PLANNED_DATE.replace('/', '');
		});

	return program;
}

// ---------------------------------------------------------------------------
// [API] WBS 프로그램 전체 회차 검색
// 특정 WBS 코드(프로그램 ID)의 모든 회차 정보를 가져온다.
// 회차 드롭다운에서 현재 주에 해당하는 회차를 하이라이트하는 데 사용된다.
// ---------------------------------------------------------------------------
async function search_wbs(WBS) {
	return await fetch(`/kbs(${btoa('l=ko\u0026c=300')})/zweb_common/ajax_common.htm`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: `ajax_params=${encodeURIComponent(JSON.stringify(
			{
				"FUNCTION_NAME": "ZWEB_PS_CJ20N",
				"I_MODE": "R1",
				"I_POSID": WBS
			}
		))}`
	})
		.then(rsp => rsp.text())
		.then(txt => __hotfix_malform_json(txt))
		.then(str => JSON.parse(str));
}

// ---------------------------------------------------------------------------
// [API] WBS 회차 상세 정보 (마스터데이터 및 주차 전송정보)
// ---------------------------------------------------------------------------
async function load_wbs(WBS) {
	const login_info = await load_login_info();

	return await fetch(`/kbs(${btoa('l=ko\u0026c=300')})/zweb_common/ajax_common.htm`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: `ajax_params=${encodeURIComponent(JSON.stringify(
			{
				"FUNCTION_NAME": "ZWEB_PS000_0100",
				"I_MODE": "R1",
				"I_ZPOSID": WBS,
				"I_LOGIN_ID": login_info.E_ID
			}
		))}`
	})
		.then(rsp => rsp.text())
		.then(txt => __hotfix_malform_json(txt))
		.then(str => JSON.parse(str));
}

// ============================================================================
// 세부내용 템플릿
// ============================================================================
// 업무 유형별 제작 세부내역의 기본 서식.
// ERP 실적 입력 시 "세부내용" 필드에 자동으로 채워 넣을 수 있다.
// ============================================================================
const 템플릿_세부내용 = {
	뉴스생방: `
ㅇ 매체 : 1TV
ㅇ 제작 세부 내역
	- 스튜디오 카메라 동작상태 확인 및 U-5 (리모트 PAN/TILT) 작동 확인
	- 비디오 스위처 및 CG 장비 동작 상태 점검(CG 밴드 및 슈퍼 인 테스트)
	- 오디오 콘솔 및 인터컴, 마이크 스튜디오 확성 확인
	- N.TAKER 동작상태 확인 및 뉴스 영상자료 사전 확인
	- 조명등기구 및 바턴 상태 점검
	- 조명 및 앵커 모니터,프롬프터 점검
	- DLP, 클립 드라이브 및 주조 WALL모니터 상태 점검
`.trim(),

	송출: `
ㅇ 매체 : 1TV
ㅇ 제작 세부 내역
  - 편성 파일주,예 준비 및  비디오,오디오 상태 확인
  - 비디오 스위처 및 CG 장비 동작 상태 점검
  - 오디오 콘솔 및 모니터 확인
  - 편성 Taker 동작상태 확인
`.trim(),

	더빙: `
ㅇ 매체 : 1TV
ㅇ 제작 세부 내역
  - 더빙스튜디오 마이크 및 인터컴 페이징 동작 상태 확인
  - 더빙스튜디오 비디오 모니터 점검
  - 더빙 파일 비디오, 오디오 상태 사전 점검
  - 비디오 스위처 및 CG 장비 동작 상태 점검
  - 오디오 콘솔 및 모니터 확인
`.trim(),

	교양: `
ㅇ 매체 : 1TV
ㅇ 제작 세부 내역
  - 교양홀 스튜디오 마이크 및 인터컴 페이징 동작 상태 확인
  - 교양홀 스튜디오 비디오 모니터 점검
  - eVCR 동작상태 확인 및 프로그램 영상자료 사전 확인
  - 녹화 파일 비디오, 오디오 상태 사전 점검
  - 비디오 스위처 및 CG 장비 동작 상태 점검
  - 오디오 콘솔 및 모니터 확인
  - 편성 Taker 동작상태 확인
`.trim(),

	공개: `
ㅇ 매체 : 1TV
ㅇ 제작 세부 내역
  - 공개홀 스튜디오 마이크 및 인터컴 페이징 동작 상태 확인
  - 공개홀 스튜디오 비디오 모니터 점검
  - 녹화 파일 비디오, 오디오 상태 사전 점검
  - 비디오 스위처 동작 상태 점검
  - 오디오 콘솔 및 모니터 확인
  - 편성 Taker 동작상태 확인
`.trim(),

	뉴스: `
ㅇ 매체 : 1TV
ㅇ 제작 세부 내역
  - 뉴스홀 스튜디오 마이크 및 인터컴 페이징 동작 상태 확인
  - 뉴스홀 스튜디오 비디오 모니터 점검
  - 녹화 파일 비디오, 오디오 상태 사전 점검
  - 비디오 스위처 및 CG 장비 동작 상태 점검
  - 오디오 콘솔 및 모니터 확인
  - 뉴스 Taker 동작상태 확인
`.trim(),

	날씨녹화: `
ㅇ 매체 : 1TV
ㅇ 제작 세부 내역
  - 뉴스홀 스튜디오 마이크 및 인터컴 페이징 동작 상태 확인
  - 뉴스홀 스튜디오 비디오 모니터 점검
  - 녹화 파일 비디오, 오디오 상태 사전 점검
  - 비디오 스위처 및 CG 장비 동작 상태 점검
  - 오디오 콘솔 및 모니터 확인
`.trim(),

	참여: `
ㅇ 매체 : 1TV
ㅇ 제작 세부 내역
	- 스튜디오 카메라 동작상태 확인 및 U-5 (리모트 PAN/TILT) 작동 확인
	- 비디오 스위처 및 CG 장비 동작 상태 점검(CG 밴드 및 슈퍼 인 테스트)
	- 오디오 콘솔 및 인터컴 마이크 확인
	- eVCR 송출상태 확인 및 프로그램 영상자료 사전 확인
	- 조명등기구 및 바턴 상태 점검
	- 조명 및 리포터 모니터,프롬프터 점검
`.trim()
};

// ---------------------------------------------------------------------------
// [유틸리티] 제작구분(category) → 세부내용 템플릿 자동 결정
// 엑셀 파싱 결과의 category(생방송, 송출, 더빙, 녹화 등)와
// pgmName(프로그램명), zresogu(K001/K003)를 받아
// 템플릿_세부내용에서 매칭되는 템플릿 텍스트를 반환한다.
// ---------------------------------------------------------------------------
function resolve_detail_template(category, pgmName, zresogu) {
	const cat = (category || '').replace(/\s/g, '');
	const pgm = (pgmName || '').toUpperCase();

	// 제작구분 → 템플릿 키 매핑
	const mapping = {
		'생방송': zresogu === 'K003' ? '뉴스생방' : '뉴스생방',
		'생방':   zresogu === 'K003' ? '뉴스생방' : '뉴스생방',
		'송출':   '송출',
		'더빙':   '더빙',
		'참여':   '참여',
	};

	let key = mapping[cat];

	// 녹화의 경우 프로그램명으로 홀 종류 추정
	if (cat === '녹화') {
		if (pgm.includes('날씨')) key = '날씨녹화';
		else if (pgm.includes('뉴스') || pgm.includes('NEWS')) key = '뉴스';
		else if (pgm.includes('공개') || pgm.includes('열린')) key = '공개';
		else key = '교양';  // 기본값
	}

	// 생방의 경우 프로그램명으로 홀 종류 추정
	// 지금충북은 등 교양 프로그램은 교양홀 템플릿 사용
	if (cat === '생방송' || cat === '생방') {
		if (pgm.includes('충북') || pgm.includes('지금충북')) key = '교양';
	}

	return (key && 템플릿_세부내용[key]) ? 템플릿_세부내용[key] : '';
}

// ---------------------------------------------------------------------------
// [유틸리티] WBS 코드 기반 → 제작구분(ZPRODGU) + 제작포맷(ZPRDFMT) 자동 입력
// ---------------------------------------------------------------------------
// category.json의 WBS→카테고리 매핑을 참조하여
// ERP 폼의 제작구분, 제작포맷 드롭다운을 자동으로 선택한다.
// ---------------------------------------------------------------------------
let _categoryMap = null;  // category.json 캐시

async function loadCategoryMap() {
	if (_categoryMap) return _categoryMap;
	try {
		const url = chrome.runtime.getURL('data/category.json');
		const resp = await fetch(url);
		_categoryMap = await resp.json();
		console.log('[AutoReport] category.json 로드 완료:', Object.keys(_categoryMap).length, '건');
	} catch (e) {
		console.warn('[AutoReport] category.json 로드 실패:', e.message);
		_categoryMap = {};
	}
	return _categoryMap;
}

// 카테고리명 → 제작구분 드롭다운에서 찾을 키워드
// 0200 페이지: "A2000001 : 생방"  /  0320 페이지: "A2000060 : 생방"
// 코드는 다르지만 텍스트("생방")는 동일 → 텍스트로 매칭
const CATEGORY_TO_PRODGU_TEXT = {
	'생방':   '생방',
	'생방송': '생방',
	'송출':   '송출',
	'녹화':   '녹화',
	'편집':   '편집',
	'더빙':   '더빙',
	'중계':   '중계',
	'참여':   '녹화',     // 참여 → 녹화로 매핑
	'기타':   '기타',
};

// 카테고리별 제작포맷 드롭다운에서 찾을 키워드
// 0200 페이지: "A4000002 : HD(FILE)"  /  0320 페이지: "A4000062 : 뉴스"
const CATEGORY_TO_PRDFMT_TEXT = {
	'생방':   '뉴스',     // 0320: "뉴스", 0200: 매칭 실패 → "HD" 폴백
	'생방송': '뉴스',
	'송출':   'HD',
	'녹화':   'HD',
	'더빙':   'HD',
	'편집':   'HD',
	'중계':   'HD',
	'참여':   'HD',
	'기타':   'HD',
};

// 드롭다운에서 키워드로 옵션 찾기 (대소문자 무시)
function findOptionByText(selectEl, keyword) {
	if (!selectEl || !keyword) return null;
	const kw = keyword.toUpperCase();
	
	const options = Array.from(selectEl.options).filter(o => o.value);
	
	// 1. ':' 뒤의 텍스트가 정확히 일치하는 옵션을 우선 검색 (예: "A2000145 : 송출" -> "송출" === "송출")
	const exactMatch = options.find(o => {
		const parts = o.text.split(':');
		const name = parts.length > 1 ? parts[parts.length - 1].trim().toUpperCase() : o.text.trim().toUpperCase();
		return name === kw;
	});
	if (exactMatch) return exactMatch;

	// 2. 정확히 일치하는 것이 없으면 포함하는 텍스트 검색
	return options.find(o => o.text.toUpperCase().includes(kw));
}

async function auto_fill_production_fields(wbsCode) {
	if (!wbsCode) return;

	// WBS에서 프로그램 코드 부분 추출 (예: "T2003-0143.0001" → "T2003-0143")
	const pgmCode = wbsCode.split('.')[0];
	if (!pgmCode) return;

	const map = await loadCategoryMap();
	const entry = map[pgmCode];

	if (!entry) {
		console.log(`[AutoReport] WBS ${pgmCode} → category.json에 매핑 없음 (수동 선택 필요)`);
		return;
	}

	// category.json은 두 가지 형식 지원:
	//   문자열: "생방"                          → prodgu=생방, prdfmt=기본 매핑
	//   객체:   { "prodgu": "녹화", "prdfmt": "날씨" } → prodgu=녹화, prdfmt=날씨
	let category, formatOverride;
	if (typeof entry === 'string') {
		category = entry;
	} else if (typeof entry === 'object') {
		category = entry.prodgu;
		formatOverride = entry.prdfmt;  // 이 프로그램 전용 포맷 키워드
	}

	if (!category) return;
	console.log(`[AutoReport] WBS ${pgmCode} → 카테고리: "${category}"` + (formatOverride ? `, 포맷: "${formatOverride}"` : ''));

	// 제작구분 드롭다운 설정 (텍스트 매칭)
	const prodguSelect = document.querySelector('#TEMP_ZPRODGU');
	const prodguKeyword = CATEGORY_TO_PRODGU_TEXT[category];
	if (prodguSelect && prodguKeyword) {
		const opt = findOptionByText(prodguSelect, prodguKeyword);
		if (opt) {
			prodguSelect.value = opt.value;
			console.log(`[AutoReport] ✅ 제작구분 자동 입력: ${opt.value} (${opt.text.trim()})`);
		} else {
			console.log(`[AutoReport] ⚠️ 제작구분 "${prodguKeyword}" 옵션을 찾지 못함`);
		}
	}

	// 제작포맷 드롭다운 설정 (텍스트 매칭)
	// formatOverride가 있으면 그것을 우선 사용, 없으면 카테고리 기본 매핑
	const prdfmtSelect = document.querySelector('#TEMP_ZPRDFMT');
	const prdfmtKeyword = formatOverride || CATEGORY_TO_PRDFMT_TEXT[category];
	if (prdfmtSelect && prdfmtKeyword) {
		let opt = findOptionByText(prdfmtSelect, prdfmtKeyword);
		// 폴백: "뉴스"를 못 찾으면 "HD" 시도 (0200 페이지)
		if (!opt && prdfmtKeyword === '뉴스') {
			opt = findOptionByText(prdfmtSelect, 'HD');
		}
		if (opt) {
			prdfmtSelect.value = opt.value;
			console.log(`[AutoReport] ✅ 제작포맷 자동 입력: ${opt.value} (${opt.text.trim()})`);
		}
	}

	// 제작리소스(ZJRES) 드롭다운 설정
	// N스튜디오 관련 프로그램(생방/녹화+뉴스포맷)은 "뉴스" 키워드 리소스 선택
	const zjresSelect = document.querySelector('#zjres_list select');
	if (zjresSelect) {
		const options = Array.from(zjresSelect.options).filter(o => o.value);
		let targetOption = null;

		// 뉴스 관련: 생방 또는 뉴스 포맷 관련 녹화
		const isNewsRelated = (category === '생방' || category === '생방송' || formatOverride);
		if (isNewsRelated) {
			targetOption = options.find(o => o.text.includes('뉴스'));
		}

		if (!targetOption && options.length > 0) {
			targetOption = options[0];
		}

		if (targetOption) {
			zjresSelect.value = targetOption.value;
			console.log(`[AutoReport] ✅ 제작리소스 자동 입력: ${targetOption.value} (${targetOption.text})`);
		}
	}
}



// ============================================================================
// 메인 로직 — DOMContentLoaded 이벤트
// ============================================================================
// ERP 페이지가 로드되면 URL 경로에 따라 적절한 헬퍼 기능을 추가한다.
// ============================================================================




document.addEventListener('DOMContentLoaded', async function () {



	// -----------------------------------------------------------------------
	// TODO 목록 (미구현 기능)
	// -----------------------------------------------------------------------
	// TODO: 검색기 구현
	//   - 날짜 선택기 : 특정일 1주전/2주전/3주전, 기간 N-1월/N-2월/N-3월, 직전 1개월/2개월/3개원
	//   - 항목 필터링 : 제목, WBS, PID, PCODE 등
	// TODO: 결재자 자동입력
	// TODO: 근무자 선택기 
	// DONE: 세부내용 템플릿 (add_detail_template_helper)
	// TODO: 송출운행 연동 (디지털편성은 이미 연동)

	// -----------------------------------------------------------------------
	// [기능 1] 기본 정보 자동 입력
	// 결재자 사번과 방송일을 자동으로 채워 넣는다.
	// PARM.ZUSDT: URL 쿼리에서 가져온 작업 날짜 (YYYYMMDD 형식)
	// -----------------------------------------------------------------------
	const fill_default_info = (PATH, PARM, RSRC, COST) => {
		// 결재자(상급자) 사번 자동 입력
		document.querySelector('#TEMP_ZSUPER').value = '30883';
		// 방송일 자동 입력 (YYYYMMDD → YYYY/MM/DD 변환)
		document.querySelector('#TEMP_ZBDATE').value = `${PARM.ZUSDT.slice(0, 4)}/${PARM.ZUSDT.slice(4, 6)}/${PARM.ZUSDT.slice(6, 8)}`;
	};

	// -----------------------------------------------------------------------
	// [기능 2] 근무자 선택 헬퍼
	// ERP의 근무자 입력란(#ZENAMET_TXT) 아래에 조별 체크박스 UI를 삽입한다.
	// 구성: 3개 조(1조·2조·3조) × 4개 직종(감독·영상·음향·파일)
	// 체크 후 포커스 아웃 시 선택된 사번으로 load_member() API 호출,
	// 결과를 페이지 원본 함수 setTeamData()로 전달한다.
	// -----------------------------------------------------------------------
	const add_worker_helper = (PATH, PARM, RSRC, COST) => {
		let target = undefined;
		let insert = undefined;

		// 근무자 입력란(#ZENAMET_TXT)이 있는 행(<tr>)을 찾아 올라감
		target = document.querySelector('#ZENAMET_TXT');
		while (!(target.tagName == "TR" && target.querySelector(':scope > td.etb_bg')))
			target = target.parentNode;

		// 근무자 행 바로 아래에 체크박스 UI 행 삽입 (초기에는 숨김 상태)
		target.insertAdjacentHTML('afterend', `
			<tr id="member-helper-row" tabindex="-1" style="display: none;">
				<td class="etb_head">부가기능</td>
				<td class="etb_bg" colspan="3">
					<table>
						<tr><th>담당</th></tr>
						<tr><td>감독</td></tr>
						<tr><td>영상</td></tr>
						<tr><td>음향</td></tr>
						<tr><td>파일</td></tr>
					</table>
					<div>
						<span></span>
					</div>
				</td>
			</tr>
		`);

		// ----- 조별 근무자 목록 (수업 실습용 가명 샘플 데이터) -----
		// 각 배열: [사번, 이름] 쌍
		// groups[조 인덱스][직종 인덱스] = [사번, 이름]
		const groups = [
			[[10001, "홍길동"], [10002, "김철수"], [10003, "이영희"], [10004, "박지성"]],
			[[20001, "손흥민"], [20002, "황희찬"], [20003, "이강인"], [20004, "김민재"]],
			[[30001, "정우영"], [30002, "백승호"], [30003, "조규성"], [30004, "설영우"]]
		];

		// 선택된 체크박스들을 직종 순서로 정렬하여 반환
		// (감독 → 영상 → 음향 → 파일 순서, 조 내 순서도 유지)
		const get_sorted_node = NodeList => {
			// 직종 우선 정렬을 위한 순서 맵 생성
			const order_arr = groups.reduce(
				(ret, row) => row.map((_, i) => [...(ret[i] || []), row[i][0]]), []
			).flat();
			const order_map = Object.assign(...[...order_arr.entries()].map(
				([v, k]) => ({ [k]: v })
			));

			return Array
				.from(document.querySelectorAll('#member-helper-row table tr:nth-child(n+2) td input:checked'))
				.sort((_1, _2) => (order_map[_1.value] - order_map[_2.value]));
		};

		// 선택 상태를 하단 미리보기 영역에 이름 목록으로 표시
		const refresh = () => {
			document.querySelector('#member-helper-row div span').innerHTML =
				get_sorted_node().map(_ => _.labels[0].innerHTML).join(', ');
		};

		// ----- 포커스 아웃 시 ERP에 근무자 반영 -----
		insert = target.nextElementSibling;
		insert.addEventListener('blur', async e => {
			// 내부 요소로 포커스 이동 시에는 닫지 않음
			if (e.target.contains(e.relatedTarget)) {
				e.target.focus();
				return false;
			}

			// TODO: 변경 없을 시 스킵
			const member = get_sorted_node().map(_ => _.value);
			if (member.length) {
				// 선택된 사번들로 ERP API에서 사원 정보를 조회
				const IT_7505 = (await load_member(member))
					.map(_ => _.ITAB[0])
					.map(_ => ({ "ZPPERNR": _.PERNR, "ZPENAME": _.ENAME }));

				// 페이지 원본 함수 setTeamData()를 호출하여 근무자 목록 반영
				execCodeOnPageContext(IT_7505 => setTeamData(IT_7505), IT_7505);
			} else
				// 선택 없으면 빈 배열로 초기화
				execCodeOnPageContext(() => setTeamData([]));

			// 헬퍼 UI 숨김
			e.target.style.display = "none";
		});

		// ----- 조별 체크박스 동적 생성 -----
		insert = target.nextElementSibling;
		for (let [grp_idx, grp_val] of groups.entries()) {
			// 헤더 행에 조 전체 선택 체크박스 추가
			insert.querySelector(`table tr:nth-child(1)`).insertAdjacentHTML('beforeend', `
				<th>
					<input type="checkbox" id="그룹-${grp_idx + 1}"/>
					<label for="그룹-${grp_idx + 1}" style="vertical-align: text-bottom;">${grp_idx + 1}조</label>
				</th>
			`);
			// 각 직종 행에 개별 근무자 체크박스 추가
			for (let [mem_idx, mem_val] of grp_val.entries()) {
				insert.querySelector(`table tr:nth-child(${mem_idx + 2})`).insertAdjacentHTML('beforeend', `
					<td>
						<input type="checkbox" id="${["감독", "영상", "음향", "파일"][mem_idx]}-${grp_idx + 1}" value="${mem_val[0]}"/>
						<label for="${["감독", "영상", "음향", "파일"][mem_idx]}-${grp_idx + 1}" style="vertical-align: text-bottom;">${mem_val[1]}</label>
					</td>
				`);
			}
		}

		// ----- 조 전체 선택 체크박스 이벤트: 해당 조의 모든 개별 체크박스를 토글 -----
		for (let elem of insert.querySelectorAll(':scope table tr th input')) {
			elem.addEventListener('change', e => {
				const hidx = Array.from(e.target.parentNode.parentNode.children).indexOf(elem.parentNode);
				const head = e.target.parentNode.parentNode.parentNode.querySelector(`:scope tr:nth-child(1)   th:nth-child(${hidx + 1}) > input`);
				const cell = e.target.parentNode.parentNode.parentNode.querySelectorAll(`:scope tr:nth-child(n+2) td:nth-child(${hidx + 1}) > input`);
				for (let _ of cell) {
					_.checked = head.checked;
				}
				refresh();
			});
		}
		// ----- 개별 체크박스 이벤트: 해당 조의 전체 선택 상태를 갱신 -----
		for (let elem of insert.querySelectorAll(':scope table tr td input')) {
			elem.addEventListener('change', e => {
				const hidx = Array.from(e.target.parentNode.parentNode.children).indexOf(elem.parentNode);
				const head = e.target.parentNode.parentNode.parentNode.querySelector(`:scope tr:nth-child(1)   th:nth-child(${hidx + 1}) > input`);
				const cell = e.target.parentNode.parentNode.parentNode.querySelectorAll(`:scope tr:nth-child(n+2) td:nth-child(${hidx + 1}) > input`);
				{
					// 모든 개별 체크박스가 체크되어야 전체 선택도 체크
					head.checked = Array.from(cell).every(_ => _.checked);
				}
				refresh();
			});
		}

		// ----- "근무자목록" 버튼 삽입 -----
		// 기존 "#BTN_ENAMET" 버튼 옆에 "근무자목록" 버튼을 추가
		target = document.querySelector('#BTN_ENAMET');
		target = target.parentElement;
		target.insertAdjacentHTML('afterend', `
			<td>
				<a href="javascript:" id="member-helper-switch" class="btn btn_white_ms">
					<span>근무자목록</span>
				</a>
			</td>
		`);

		// ----- "근무자목록" 버튼 클릭 시 헬퍼 UI 표시 -----
		insert = target.nextElementSibling;
		insert.querySelector('a').addEventListener('click', e => {
			// 헬퍼 UI 표시 및 포커스
			document.querySelector('#member-helper-row').style.display = "table-row";
			document.querySelector('#member-helper-row').focus();

			// 모든 체크박스 초기화
			document.querySelectorAll(`#member-helper-row table tr td input`)
				.forEach(_ => _.checked = false);

			// 현재 ERP에 등록된 근무자 목록을 가져와 체크박스 상태 복원
			// data_IT_7505는 ERP 페이지 원본 JS에 존재하는 전역 변수
			execCodeOnPageContext(() => data_IT_7505)
				.map(_ => _.ZPPERNR)
				.forEach(_ => {
					const input = document.querySelector(`#member-helper-row table tr td input[value="${parseInt(_)}"]`);
					if (input)
						input.checked = true;
				});

			// 조 전체 선택 체크박스 상태 갱신
			document.querySelectorAll(`#member-helper-row table tr:first-child th:nth-child(n+2) input`)
				.forEach((e, i) => {
					e.checked = [...document.querySelectorAll(`#member-helper-row table tr:nth-child(n+2) td:nth-child(${i + 2}) input`)].every(_ => _.checked);
				});

			refresh();
		});
	};

	// -----------------------------------------------------------------------
	// [기능 3] WBS 검색 헬퍼
	// WBS 코드 입력란(#TEMP_ZWBS) 아래에 3개의 셀렉트박스를 삽입한다:
	//   1. "해당 날짜 프로그램" — 당일 편성표에서 코스트센터로 필터링
	//   2. "선택 프로그램 회차" — 선택한 프로그램의 모든 회차 목록
	//   3. "과거 기록 가져오기" — 동일 프로그램의 과거 실적을 복사
	// -----------------------------------------------------------------------
	const add_search_helper = (PATH, PARM, RSRC, COST) => {
		let target = undefined;
		let insert = undefined;

		// WBS 입력란이 있는 행을 찾아 올라감
		target = document.querySelector('#TEMP_ZWBS');
		while (!(target.tagName == "TR" && target.querySelector(':scope > td.etb_bg')))
			target = target.parentNode;

		// 3개 셀렉트박스를 가진 "부가기능" 행 삽입
		target.insertAdjacentHTML('afterend', `
			<tr>
				<td class="etb_head">부가기능</td>
				<td class="etb_bg" colspan="3">
					<select class="select" style="font-family: 돋움체; letter-spacing: normal;">
						<option disabled selected>해당 날짜 프로그램</option>
					</select>
					<select class="select" style="font-family: 돋움체; letter-spacing: normal;">
						<option disabled selected>선택 프로그램 회차</option>
					</select>
					<select class="select" style="font-family: 돋움체; letter-spacing: normal;">
						<option disabled selected>과거 기록 가져오기</option>
					</select>
				</td>
			</tr>
		`);

		// ===== 셀렉트 1: "해당 날짜 프로그램" =====
		// focus 시: 현재 날짜의 편성 프로그램 중 해당 코스트센터의 프로그램을 옵션으로 추가
		insert = target.nextElementSibling;
		insert.querySelector('select:nth-child(1)').addEventListener('focus', async e => {
			const thisDay = new Date(document.querySelector('#TEMP_ZUSDT').value);
			// list_wbs()로 당일 편성 조회 → 코스트센터(COST)로 필터링
			for (let _ of (await list_wbs(thisDay, thisDay)).filter(e => e.COST_CENTER == COST)) {
				const option = document.createElement('option');
				option.value = (_.WBS1 + '.' + _.WBS_WEEKLY_NO);
				option.innerText = `${_.BROADCAST_PLANNED_TIME} | ${_.PROGRAM_TITLE}${_.RERUN_CLASSIFICATION == '재방' ? '(재)' : ''}`;

				e.target.appendChild(option);
			}
			// 기타 프로그램 (편성표에 없지만 자주 사용되는 프로그램)
			e.target.insertAdjacentHTML('beforeend', `
				<optgroup label="기타 프로그램">
					<option value="T-015911.0000">더빙 | 지금 충북은</option>
					<option value="T-016036.0000">녹화 | 뉴스 7 날씨, 출연</option>
					<option value="T-016191.0000">녹화 | 무대를 빌려드립니다</option>
					<option value="T-016163.0000">참여 | 네트워크 공동기획</option>
				</optgroup>
			`);
		});
		// blur 시: 옵션 초기화 (다음 focus 시 최신 데이터 반영)
		insert.querySelector('select:nth-child(1)').addEventListener('blur', async e => {
			while (e.target.firstChild)
				e.target.removeChild(e.target.firstChild);

			e.target.insertAdjacentHTML('afterbegin', `
				<option disabled selected>해당 날짜 프로그램</option>
			`);
		});
		// change 시: 선택된 WBS 코드를 입력란에 자동 입력
		insert.querySelector('select:nth-child(1)').addEventListener('change', async e => {
			document.querySelector('#TEMP_ZWBS').value = e.target.value;
			// blur 이벤트를 트리거하여 ERP 원본 JS의 WBS 자동완성 로직 실행
			document.querySelector('#TEMP_ZWBS').dispatchEvent(new Event('blur'));

			e.target.blur();
		});

		// ===== 셀렉트 2: "선택 프로그램 회차" =====
		// 현재 WBS 코드의 프로그램에 속한 모든 회차를 나열한다.
		// 현재 주와 매칭되는 회차는 분홍색, 현재 선택된 회차는 초록색으로 하이라이트.
		insert = target.nextElementSibling;
		insert.querySelector('select:nth-child(2)').addEventListener('focus', async e => {
			const curr = document.querySelector('#TEMP_ZWBS').value;
			if (!curr || curr.split('.').length != 2)
				return;

			// 이미 같은 프로그램의 회차가 로드되어 있으면 재로드하지 않음
			if (e.target.value && (curr.split('.')[0] == e.target[0].value))
				return;

			// search_wbs()로 프로그램의 전체 회차 조회
			for (let _ of (await search_wbs(curr.split('.')[0])).ITAB) {
				// WBS 이름에서 날짜 코드를 추출하여 현재 주와 매칭
				const __match_date = WBSSTR => {
					const match = WBSSTR.match(/\d{6}$/);
					if (!match)
						return undefined;

					let CUR_DATE = new Date(document.querySelector('#TEMP_ZUSDT').value.replace(/\//, '-'));
					let WBS_DATE;

					// 주간 코드 매칭 (6자리: YYMMDD)
					WBS_DATE = new Date(
						`${new Date().getFullYear()}`.slice(0, 2) + `${match[0].slice(0, 2)}-${match[0].slice(2, 4)}-${match[0].slice(4, 6)}`
					);
					if (!isNaN(WBS_DATE))
						return __calc_week_difference(CUR_DATE, WBS_DATE);

					// 월간 코드 매칭 (6자리: YYYYMM)
					WBS_DATE = new Date(
						`${match[0].slice(0, 4)}-${match[0].slice(4, 6)}-01`
					);
					if (!isNaN(WBS_DATE))
						return __calc_month_difference(CUR_DATE, WBS_DATE);

					// 매칭 실패
					return undefined;
				};

				const option = document.createElement('option');
				option.value = _.POSID;
				option.innerText = `${_.POSID.split('.')[1] || '0000'} | ${_.POST1}`;

				// 현재 주에 해당하는 회차: 분홍색 배경
				if (__match_date(_.POST1) == 0)
					option.style.backgroundColor = 'rgba(240, 160, 240, 255)';
				// 현재 선택된 회차: 초록색 배경
				if (_.POSID == document.querySelector('#TEMP_ZWBS').value)
					option.style.backgroundColor = 'rgba( 30, 240, 175, 255)';

				e.target.appendChild(option);
			}
		});
		// blur 시: 옵션 초기화
		insert.querySelector('select:nth-child(2)').addEventListener('blur', async e => {
			while (e.target.firstChild)
				e.target.removeChild(e.target.firstChild);

			e.target.insertAdjacentHTML('afterbegin', `
				<option disabled selected>선택 프로그램 회차</option>
			`);
		});
		// change 시: 선택된 회차의 WBS 코드를 입력란에 반영
		insert.querySelector('select:nth-child(2)').addEventListener('change', async e => {
			document.querySelector('#TEMP_ZWBS').value = e.target.value;
			document.querySelector('#TEMP_ZWBS').dispatchEvent(new Event('blur'));

			e.target.blur();
		});

		// ===== 셀렉트 3: "과거 기록 가져오기" =====
		// 동일 프로그램(WBS)의 과거 실적을 보여주고, 선택하면 해당 실적을 현재 폼에 복사.
		// 21일(3주) 주기 근무 패턴에 해당하는 실적은 초록색으로 하이라이트.
		insert = target.nextElementSibling;
		insert.querySelector('select:nth-child(3)').addEventListener('focus', async e => {
			const TARGET_WBS = document.querySelector('#TEMP_ZWBS').value;
			if (!TARGET_WBS)
				return;

			// 현재 ERP 폼의 제작구분 옵션 목록을 매핑 (값 → 텍스트)
			const PRODUCE_TYPES = Object.assign({},
				...Array.from(document.querySelectorAll('#TEMP_ZPRODGU > option:not([value=""])')).map(_ => ({ [_.value]: _.innerText.split(" : ")[1] }))
			);

			let this_day = new Date(document.querySelector('#TEMP_ZUSDT').value.replace(/\//, '-'));
			let head_day = new Date();
			let tail_day = new Date(head_day.getTime() - 60 * 24 * 60 * 60 * 1000); // 최근 2달간 검색

			// history_erp()로 과거 실적 조회 → 동일 프로그램(WBS 앞부분)만 필터링
			for (let _ of (await history_erp(tail_day, head_day, RSRC)).IT14.filter(e => e.ZWBS.split('.')[0] == TARGET_WBS.split('.')[0])) {
				const wbs_date = new Date(`${_.ZUSDT.slice(0, 4)}-${_.ZUSDT.slice(4, 6)}-${_.ZUSDT.slice(6, 8)}`);
				// 현재 날짜와의 주 차이 계산
				const diff_val = __calc_week_difference(
					this_day, wbs_date
				);

				// 주 차이를 사람이 읽기 쉬운 형태로 변환
				let diff_str;
				if (diff_val == 0) diff_str = "해당주";
				else if (diff_val < 0) diff_str = `${-diff_val}주 전`
				else if (diff_val > 0) diff_str = `${diff_val}주 후`

				// 날짜를 한국어 형식으로 변환 (예: "2024.01.15.(월)")
				let date_str;
				date_str = wbs_date.toLocaleDateString('ko-kr', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
				date_str = date_str.replace(/\s/g, '');

				const option = document.createElement('option');
				option.value = _.ZWSEQ;
				option.innerText = `${date_str} (${diff_str}) | ${PRODUCE_TYPES[_.ZPRODGU]} | ${_.ZPNM} | ${_.ZENAMET}`;

				// 21일(3주) 주기에 해당하는 실적: 초록색 하이라이트
				// 이는 3개 조가 3주 주기로 순환 근무하기 때문에, 본인 조의 과거 실적을 찾기 쉽도록 함
				if (__calc_day_difference(this_day, wbs_date) % 21 == 0)
					option.style.backgroundColor = 'rgba( 30, 240, 175, 255)';

				e.target.appendChild(option);
			}
		});
		// blur 시: 옵션 초기화
		insert.querySelector('select:nth-child(3)').addEventListener('blur', async e => {
			while (e.target.firstChild)
				e.target.removeChild(e.target.firstChild);

			e.target.insertAdjacentHTML('afterbegin', `
				<option disabled selected>과거 기록 가져오기</option>
			`);
		});
		// change 시: 선택된 과거 실적의 데이터를 현재 폼에 복사
		insert.querySelector('select:nth-child(3)').addEventListener('change', async e => {
			// 선택된 실적의 전체 데이터를 로드
			const ERP = await load_erp(e.target.value);
			// WBS, 프로그램명, 방송일은 현재 폼의 값으로 덮어쓰기 (복사 대상이 아님)
			ERP.CS_7523.ZWBS = document.querySelector('#TEMP_ZWBS').value;
			ERP.CS_7523.ZPNM = document.querySelector('#ZPNM_TXT').value;
			ERP.CS_7523.ZBDATE = document.querySelector('#TEMP_ZBDATE').value.replace(/\//g, '');

			// 페이지 원본 함수 callBackAssignCopyData()로 폼에 데이터 반영
			// 근무자 이름도 UI에 표시
			execCodeOnPageContext(function (ERP) {
				callBackAssignCopyData(ERP);
				$('#ZENAMET_TXT').html(ERP.IT_7505.map(_ => _.ZPENAME).join(', '));
			}, ERP);

			e.target.blur();
		});
	};

	// -----------------------------------------------------------------------
	// [기능 4] 세부내용 템플릿 자동 입력
	// 제작구분(#TEMP_ZPRODGU) 드롭다운의 현재 선택값에 따라
	// 세부내용(#TEMP_ZWORKTX) 텍스트영역에 미리 정의된 템플릿을 자동 입력한다.
	// "세부내용 템플릿" 버튼 클릭 시 동작.
	// -----------------------------------------------------------------------
	const add_detail_template_helper = (PATH, PARM, RSRC, COST) => {
		// 제작구분 드롭다운 텍스트 → 템플릿 키 매핑
		// ERP 드롭다운의 optionText (예: "A2000001 : 생방")에서 추출한 값을 템플릿 키로 변환
		const 제작구분_템플릿_매핑 = {
			'생방':   RSRC === 'K003' ? '뉴스생방' : null,  // NS(뉴스서비스)는 뉴스생방 템플릿
			'송출':   '송출',
			'더빙':   '더빙',
			'녹화':   null,   // 녹화는 홀 종류에 따라 분기 필요 → 아래에서 처리
		};

		// 녹화의 경우 WBS 프로그램명으로 홀 종류를 추정하여 템플릿 선택
		const guess_녹화_템플릿 = () => {
			const pgmName = (document.querySelector('#ZPNM_TXT')?.value || '').toUpperCase();
			if (pgmName.includes('뉴스') || pgmName.includes('NEWS')) return '뉴스';
			if (pgmName.includes('공개') || pgmName.includes('열린')) return '공개';
			return '교양';  // 기본값: 교양홀
		};

		// 세부내용(#TEMP_ZWORKTX) textarea가 있는 행을 찾음
		let target = document.querySelector('#TEMP_ZWORKTX');
		if (!target) return;  // 세부내용 필드가 없으면 스킵

		// textarea 옆에 "세부내용 템플릿" 버튼 삽입
		target.insertAdjacentHTML('afterend', `
			<a href="javascript:" id="detail-template-btn" class="btn btn_white_ms" style="margin-left: 4px; vertical-align: top;">
				<span>세부내용 템플릿</span>
			</a>
		`);

		// 버튼 클릭 이벤트
		document.querySelector('#detail-template-btn').addEventListener('click', e => {
			const dropdown = document.querySelector('#TEMP_ZPRODGU');
			if (!dropdown || !dropdown.value) {
				alert('제작구분을 먼저 선택하세요.');
				return;
			}

			// 드롭다운의 선택된 옵션 텍스트에서 제작구분 명칭 추출
			// 형식: "A2000001 : 생방" → "생방"
			const selectedText = dropdown.options[dropdown.selectedIndex].text;
			const prodName = selectedText.includes(' : ') ? selectedText.split(' : ')[1].trim() : selectedText.trim();

			// 매핑에서 템플릿 키 결정
			let templateKey = 제작구분_템플릿_매핑[prodName];

			// 녹화인 경우 프로그램명으로 분기
			if (prodName === '녹화') {
				templateKey = guess_녹화_템플릿();
			}

			// 매핑되지 않은 제작구분
			if (!templateKey || !템플릿_세부내용[templateKey]) {
				// 직접 선택할 수 있도록 목록 표시
				const keys = Object.keys(템플릿_세부내용);
				const choice = prompt(
					`"${prodName}"에 대응하는 기본 템플릿이 없습니다.\n번호를 입력하여 수동 선택하세요:\n\n` +
					keys.map((k, i) => `${i + 1}. ${k}`).join('\n')
				);
				if (!choice) return;
				const idx = parseInt(choice) - 1;
				if (idx >= 0 && idx < keys.length) {
					templateKey = keys[idx];
				} else {
					alert('잘못된 번호입니다.');
					return;
				}
			}

			// 세부내용 텍스트영역에 템플릿 입력
			const textarea = document.querySelector('#TEMP_ZWORKTX');
			textarea.value = 템플릿_세부내용[templateKey];
			// ERP 원본 JS가 감지할 수 있도록 이벤트 발생
			textarea.dispatchEvent(new Event('change'));
			textarea.dispatchEvent(new Event('blur'));

			console.log(`[AutoReport] 세부내용 템플릿 적용: ${templateKey}`);
		});
	};

	// -----------------------------------------------------------------------
	// URL 파싱 및 페이지별 분기 실행
	// -----------------------------------------------------------------------

	// 현재 페이지의 파일명 추출 (예: "ins_res_reg_0200.htm")
	const PATH = location.pathname.split('/').slice(-1)[0];

	// URL 쿼리 파라미터 파싱 (예: ?ZUSDT=20240115&... → { ZUSDT: "20240115", ... })
	const PARM = JSON.parse(`{"${location.search.slice(1).replace(/&/g, '","').replace(/=/g, '":"')}"}`, (k, v) => k === "" ? v : decodeURIComponent(v));

	switch (PATH) {
		case "ins_res_list.htm":
			// 리소스 실적 목록 페이지 → 당일 WBS 목록을 콘솔에 출력 (디버그용)
			console.warn(await list_wbs(new Date(), new Date()));
			break;

		case "ins_res_reg_0200.htm": // TS (TV 서비스) 실적 등록
			{
				// RSRC='K001' (TS), COST='2700007' (TV 기술 코스트센터)
				fill_default_info(PATH, PARM, 'K001', '2700007');
				add_worker_helper(PATH, PARM, 'K001', '2700007');
				add_search_helper(PATH, PARM, 'K001', '2700007');
				add_detail_template_helper(PATH, PARM, 'K001', '2700007');
			}
			break;

		case "ins_res_reg_0320.htm": // NS (뉴스 서비스) 실적 등록
			{
				// RSRC='K003' (NS), COST='2700009' (뉴스 기술 코스트센터)
				fill_default_info(PATH, PARM, 'K003', '2700009');
				add_worker_helper(PATH, PARM, 'K003', '2700009');
				add_search_helper(PATH, PARM, 'K003', '2700009');
				add_detail_template_helper(PATH, PARM, 'K003', '2700009');
			}
			break;
	}



	// -----------------------------------------------------------------------
	// [기능 5] 저장 후 리다이렉트 방지
	// -----------------------------------------------------------------------
	// 2026-03-01: ERP 소스 분석 결과:
	//   저장 버튼 → checkSave() → callAJAX(VC) → callBackCheckSave()
	//   → save() → callAJAX(C1) → callBackSave() → goList() ← 리다이렉트!
	//
	// 해결: override_checksave2.js (MAIN world, document_start)에서
	//   callBackSave()를 Object.defineProperty 트랩으로 오버라이드하여
	//   goList() 호출을 제거. ERP의 저장 흐름은 그대로 유지.
	// -----------------------------------------------------------------------
});

// ============================================================================
// 엑셀 → ERP 일괄 입력
// ============================================================================

/**
 * ERP 실적 등록 API를 직접 호출한다.
 * UI(checkSave2)를 거치지 않고 ajax_common.htm 엔드포인트를 통해 직접 저장.
 * 이 방식은 저장 후 리다이렉트를 발생시키지 않는다.
 *
 * @param {object} data - 저장할 데이터 (엑셀 파싱 결과 1건)
 * @param {object} loginInfo - load_login_info() 결과
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function save_erp_record(data, loginInfo) {
	const apiUrl = `/kbs(${btoa('l=ko\u0026c=300')})/zweb_common/ajax_common.htm`;

	// 제작구분 코드 매핑 — 엑셀에서 "더   빙" 등 공백이 들어갈 수 있으므로 제거 후 비교
	const categoryClean = (data.category || '').replace(/\s/g, '');
	const prodguCode = EXCEL_TO_PRODGU[categoryClean] || EXCEL_TO_PRODGU[data.category] || 'A2000159';

	// 시간 포맷: "HH:MM" → "HHMM"
	const startTime = (data.start || '').replace(':', '');
	const endTime = (data.end || '').replace(':', '');

	// 방송/실적 날짜: "YYYYMMDD"
	const dateStr = data.date.replace(/-/g, '');

	// 근무시간 결정 (조근/야근 기준)
	let workStart, workEnd, workHours, workMinutes;
	if (data.shiftType === '조근') {
		workStart = '0600'; workEnd = '1400'; workHours = '8.00 '; workMinutes = '480 ';
	} else if (data.shiftType === '야근') {
		workStart = '1400'; workEnd = '2200'; workHours = '8.00 '; workMinutes = '480 ';
	} else {
		workStart = '0900'; workEnd = '1800'; workHours = '8.00 '; workMinutes = '480 ';
	}

	// 근무자 사번 목록 (IT_7505)
	const workerList = (data.workers || []).map((name, idx) => {
		const wid = WORKER_IDS[name];
		if (!wid) {
			console.warn(`[AutoReport] 근무자 "${name}" 사번 매핑 없음 — 건너뜀`);
			return null;
		}
		return {
			ZLIFNR: wid.ZLIFNR,
			ZPENAME: name,
			ZPSEQ: "",
			ZGROUPTX: "",
			MARK: "",
			MANDT: "300",
			ZPORGEH: wid.ZPORGEH,
			ZGROUP: "",
			ZPPERNR: wid.ZPPERNR,
			ZBEGDA: "00000000",
			ZENDDA: "00000000",
			ZPVDSK1: ERP_ZORGEH,
			ZJIKJONG: "",
			ZTEL1: "",
			ZTEL2: ""
		};
	}).filter(Boolean);

	// CS_7523: 폼 필드 전체
	const cs7523 = {
		SCREEN_NO: "0000",
		ZORGTX: "기술국(청주)",
		ZSUPERTX: "",
		ZENAME: "",
		ZENAMET: workerList.map(w => w.ZPENAME).join(', '),
		ZRESOGUT: data.zresogu === 'K003' ? 'N스튜디오' : 'TV스튜디오',
		ZJREST: "",
		ZUEQUT: "",
		PSPNR: "00000000",
		ZPRODGUT: "",
		ZPRDFMTX: "",
		ZOVERTIME_SAVED: "",
		ZBDATE_C: "",
		ZWORKTX: resolve_detail_template(data.category, data.pgmName, data.zresogu) || data.notes || "",
		ZWBS_INPUT: "",
		MANDT: "300",
		ZWSEQ: "",
		ZASEQ: "",
		ZRESOGU: data.zresogu || "K001",
		ZJRES: "0007270010",      // 청주 TV주조 (기본값)
		ZUEQU: "",
		ZORGEH: ERP_ZORGEH,
		ZVDSK1: "00000000",
		ZPERNR: "00000000",
		ZDEL: "",
		ZNOSHOW: "",
		ZCONFIRMED: "",
		ZPCODE: "",
		ZPID: "",
		ZWBS: data.wbs || "T-016191.9999",
		ZPNM: "",
		ZSPMON: dateStr.slice(0, 6),
		ZKOSTL: "",
		ZUSDT: dateStr,
		ZUSTM: workStart,
		ZUEDT: "00000000",
		ZUETM: workEnd,
		ZUTH: workHours,
		ZUTM: workMinutes,
		ZCSEQ: "",
		ZBDATE: dateStr,
		ZSTIME: startTime,
		ZETIME: endTime,
		ZMINUTE: "0 ",
		ZPORGEH: "00000000",
		ZSUPER: "30883",           // 결재자 (기본값)
		ZSUPCHK: "",
		ZPRODGU: prodguCode,
		ZPRDFMT: "A4000002",       // HD(FILE) 기본값
		ZAUASGU: "",
		ZBTRPGU: "",
		ZAREA: "",
		ZSPOT: "",
		ZQUAN: "0 ",
		ZCAMERA: "0 ",
		ZVCR: "0 ",
		ZINTERCOM: "",
		ZPHONE: "",
		ZOVERTIME: "",
		ZBEGT: "000000",
		ZENDT: "000000",
		ZKTYPE: "",
		ZYUHYUNG: "",
		ZWORK_TYPE: "",
		ZDAEH: "",
		ZTOMOH: "",
		ZPERSON: "00000000",
		ZMONEY: "0000000",
		ZBSTEXT: resolve_detail_template(data.category, data.pgmName, data.zresogu),
		ZPMTMF: "000000",
		ZPMTMT: "000000",
		ZSTRTM: "000000",
		ZARRTM: "000000",
		ZWRKTMF: "000000",
		ZWRKTMT: "000000",
		ZRELYTMF: "000000",
		ZRELYTMT: "000000",
		ZRETNTM: "000000",
		ZRETNTMT: "000000",
		ZAMTMF: "000000",
		ZAMTMT: "000000",
		ZSETUPF: "0000",
		ZSETUPT: "0000",
		ZSTEPMT: "",
		ZLIGHTF: "0000",
		ZLIGHTT: "0000",
		ZREHTMF: "0000",
		ZREHTMT: "0000",
		ZPRODTMF: "0000",
		ZPRODTMT: "0000",
		ZDISTANCE: "0.00 ",
		ZOILING: "0.00 ",
		ZSOBDC: "",
		ZSOCITY: "",
		ZRT: "",
		ZKEY: "00000000",
		ZHAPDONG: "",
		ZCANCELM: "",
		ZSOURCE: "",
		ZPD: "",
		ZSECTIONF: "",
		ZSECTIONT: "",
		ZSUBSC: "",
		ZDEPTX: "",
		ZTMCNT: "0.0 ",
		ZTAPE: "",
		ZRECTM: "000000",
		ZUSE: "SMART",
		ZLINES: "",
		ZDRIVE: "",
		ZFD_FIX_NUM: "0 ",
		ZFD_VAR_NUM: "0 ",
		ZINSTSN_O: "000000000",
		ZINSTSN_R: "000000000",
		ZVIDEOSERV: "",
		ZCREM: "",
		ZCRED: "00000000",
		ZCRET: "000000",
		ZCHGM: "",
		ZCHGD: "00000000",
		ZCHGT: "000000",
		zlines: ""
	};

	// IT_ZJRES: 자원 목록
	const itZjres = [{
		ZWSEQ: "",
		ZASEQ: "",
		ZJRES: "0007270010"  // 청주 TV주조
	}];

	// API 함수명 결정 (0200 / 0320 동일한 듯)
	const funcName = "ZWEB_PS820_0200";

	// ---- 1단계: 검증 (VC) ----
	const vcPayload = {
		FUNCTION_NAME: funcName,
		I_MODE: "VC",
		CS_7523: JSON.stringify(cs7523),
		IT_7505: JSON.stringify(workerList),
		IT_ZJRES: JSON.stringify(itZjres),
		I_LOGIN_ID: loginInfo.E_ID
	};

	console.log(`[AutoReport] 검증 요청 (VC): ${data.category} | ${data.pgmName} | ${data.start}~${data.end}`);

	const vcResponse = await fetch(apiUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `ajax_params=${encodeURIComponent(JSON.stringify(vcPayload))}`
	})
		.then(rsp => rsp.text())
		.then(txt => __hotfix_malform_json(txt))
		.then(str => JSON.parse(str));

	if (vcResponse.E_RCODE !== 'S') {
		return { success: false, message: `검증 실패: ${vcResponse.E_RMSG}` };
	}

	// ---- 2단계: 저장 (C1) ----
	const c1Payload = { ...vcPayload, I_MODE: "C1" };

	console.log(`[AutoReport] 저장 요청 (C1): ${data.category} | ${data.pgmName}`);

	const c1Response = await fetch(apiUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `ajax_params=${encodeURIComponent(JSON.stringify(c1Payload))}`
	})
		.then(rsp => rsp.text())
		.then(txt => __hotfix_malform_json(txt))
		.then(str => JSON.parse(str));

	if (c1Response.E_RCODE !== 'S') {
		return { success: false, message: `저장 실패: ${c1Response.E_RMSG}` };
	}

	return { success: true, message: c1Response.E_RMSG };
}

/**
 * ERP 실적 검증만 수행 (VC 모드). 저장(C1)은 하지 않는다.
 * 중복 체크 등 사전 검증에 사용.
 *
 * @param {object} data - 검증할 데이터 (엑셀 파싱 결과 1건)
 * @param {object} loginInfo - load_login_info() 결과
 * @returns {Promise<{status: string, message: string}>}
 */
async function save_erp_record_vc_only(data, loginInfo) {
	const apiUrl = `/kbs(${btoa('l=ko\u0026c=300')})/zweb_common/ajax_common.htm`;

	const categoryClean = (data.category || '').replace(/\s/g, '');
	const prodguCode = EXCEL_TO_PRODGU[categoryClean] || EXCEL_TO_PRODGU[data.category] || 'A2000159';
	const startTime = (data.start || '').replace(':', '');
	const endTime = (data.end || '').replace(':', '');
	const dateStr = data.date.replace(/-/g, '');

	let workStart, workEnd, workHours, workMinutes;
	if (data.shiftType === '조근') {
		workStart = '0600'; workEnd = '1400'; workHours = '8.00 '; workMinutes = '480 ';
	} else if (data.shiftType === '야근') {
		workStart = '1400'; workEnd = '2200'; workHours = '8.00 '; workMinutes = '480 ';
	} else {
		workStart = '0900'; workEnd = '1800'; workHours = '8.00 '; workMinutes = '480 ';
	}

	const workerList = (data.workers || []).map((name) => {
		const wid = WORKER_IDS[name];
		if (!wid) return null;
		return {
			ZLIFNR: wid.ZLIFNR, ZPENAME: name, ZPSEQ: "", ZGROUPTX: "",
			MARK: "", MANDT: "300", ZPORGEH: wid.ZPORGEH, ZGROUP: "",
			ZPPERNR: wid.ZPPERNR, ZBEGDA: "00000000", ZENDDA: "00000000",
			ZPVDSK1: ERP_ZORGEH, ZJIKJONG: "", ZTEL1: "", ZTEL2: ""
		};
	}).filter(Boolean);

	const cs7523 = {
		SCREEN_NO: "0000", ZORGTX: "기술국(청주)", ZSUPERTX: "", ZENAME: "",
		ZENAMET: workerList.map(w => w.ZPENAME).join(', '),
		ZRESOGUT: data.zresogu === 'K003' ? 'N스튜디오' : 'TV스튜디오',
		ZJREST: "", ZUEQUT: "", PSPNR: "00000000", ZPRODGUT: "", ZPRDFMTX: "",
		ZOVERTIME_SAVED: "", ZBDATE_C: "", ZWORKTX: resolve_detail_template(data.category, data.pgmName, data.zresogu) || data.notes || "",
		ZWBS_INPUT: "", MANDT: "300", ZWSEQ: "", ZASEQ: "",
		ZRESOGU: data.zresogu || "K001", ZJRES: "0007270010", ZUEQU: "",
		ZORGEH: ERP_ZORGEH, ZVDSK1: "00000000", ZPERNR: "00000000",
		ZDEL: "", ZNOSHOW: "", ZCONFIRMED: "", ZPCODE: "", ZPID: "",
		ZWBS: data.wbs || "T-016191.9999", ZPNM: "",
		ZSPMON: dateStr.slice(0, 6), ZKOSTL: "", ZUSDT: dateStr,
		ZUSTM: workStart, ZUEDT: "00000000", ZUETM: workEnd,
		ZUTH: workHours, ZUTM: workMinutes, ZCSEQ: "", ZBDATE: dateStr,
		ZSTIME: startTime, ZETIME: endTime, ZMINUTE: "0 ",
		ZPORGEH: "00000000", ZSUPER: "30883", ZSUPCHK: "",
		ZPRODGU: prodguCode, ZPRDFMT: "A4000002",
		ZAUASGU: "", ZBTRPGU: "", ZAREA: "", ZSPOT: "",
		ZQUAN: "0 ", ZCAMERA: "0 ", ZVCR: "0 ", ZINTERCOM: "",
		ZPHONE: "", ZOVERTIME: "", ZBEGT: "000000", ZENDT: "000000",
		ZKTYPE: "", ZYUHYUNG: "", ZWORK_TYPE: "", ZDAEH: "", ZTOMOH: "",
		ZPERSON: "00000000", ZMONEY: "0000000", ZBSTEXT: resolve_detail_template(data.category, data.pgmName, data.zresogu),
		ZPMTMF: "000000", ZPMTMT: "000000", ZSTRTM: "000000", ZARRTM: "000000",
		ZWRKTMF: "000000", ZWRKTMT: "000000", ZRELYTMF: "000000",
		ZRELYTMT: "000000", ZRETNTM: "000000", ZRETNTMT: "000000",
		ZAMTMF: "000000", ZAMTMT: "000000", ZSETUPF: "0000", ZSETUPT: "0000",
		ZSTEPMT: "", ZLIGHTF: "0000", ZLIGHTT: "0000",
		ZREHTMF: "0000", ZREHTMT: "0000", ZPRODTMF: "0000", ZPRODTMT: "0000",
		ZDISTANCE: "0.00 ", ZOILING: "0.00 ", ZSOBDC: "", ZSOBCITY: "",
		ZRT: "", ZKEY: "00000000", ZHAPDONG: "", ZCANCELM: "", ZSOURCE: "",
		ZPD: "", ZSECTIONF: "", ZSECTIONT: "", ZSUBSC: "", ZDEPTX: "",
		ZTMCNT: "0.0 ", ZTAPE: "", ZRECTM: "000000", ZUSE: "SMART",
		ZLINES: "", ZDRIVE: "", ZFD_FIX_NUM: "0 ", ZFD_VAR_NUM: "0 ",
		ZINSTSN_O: "000000000", ZINSTSN_R: "000000000", ZVIDEOSERV: "",
		ZCREM: "", ZCRED: "00000000", ZCRET: "000000",
		ZCHGM: "", ZCHGD: "00000000", ZCHGT: "000000", zlines: ""
	};

	const itZjres = [{ ZWSEQ: "", ZASEQ: "", ZJRES: "0007270010" }];
	const funcName = "ZWEB_PS820_0200";

	const vcPayload = {
		FUNCTION_NAME: funcName,
		I_MODE: "VC",
		CS_7523: JSON.stringify(cs7523),
		IT_7505: JSON.stringify(workerList),
		IT_ZJRES: JSON.stringify(itZjres),
		I_LOGIN_ID: loginInfo.E_ID
	};

	const vcResponse = await fetch(apiUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `ajax_params=${encodeURIComponent(JSON.stringify(vcPayload))}`
	})
		.then(rsp => rsp.text())
		.then(txt => __hotfix_malform_json(txt))
		.then(str => JSON.parse(str));

	if (vcResponse.E_RCODE === 'S') {
		return { status: 'ok', message: vcResponse.E_RMSG };
	} else if (vcResponse.E_RMSG && vcResponse.E_RMSG.includes('중복')) {
		return { status: 'duplicate', message: vcResponse.E_RMSG };
	} else {
		return { status: 'error', message: vcResponse.E_RMSG };
	}
}

// ============================================================================
// 일괄 입력 메시지 핸들러
// ============================================================================
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
	// 중복 체크만 수행 (VC 검증만)
	if (req.function === 'check_erp_duplicates') {
		const programs = req.data;
		console.log(`[AutoReport] 중복 체크 시작: ${programs.length}건`);

		(async () => {
			const loginInfo = await load_login_info();
			const results = [];

			for (let i = 0; i < programs.length; i++) {
				const pgm = programs[i];
				try {
					const result = await save_erp_record_vc_only(pgm, loginInfo);
					results.push({ index: i, ...result });
				} catch (err) {
					results.push({ index: i, status: 'error', message: err.message });
				}
				if (i < programs.length - 1) await new Promise(r => setTimeout(r, 200));
			}

			sendResponse({ success: true, results });
		})();

		return true;
	}

	// 건별 폼 입력 (폼에 데이터를 채우고 눈으로 확인)
	if (req.function === 'fill_erp_single') {
		const data = req.data;
		console.log('[AutoReport] 단건 폼 입력:', data);

		(async () => {
			try {
				// 저장 버튼 클릭 시 사용할 데이터 보관
				window.__autoreport_pending = data;

				// CS_7523 폼 데이터 구성 (save_erp_record과 동일한 매핑)
				const categoryClean = (data.category || '').replace(/\s/g, '');
				const prodguCode = EXCEL_TO_PRODGU[categoryClean] || EXCEL_TO_PRODGU[data.category] || 'A2000159';
				const startTime = (data.start || '').replace(':', '');
				const endTime = (data.end || '').replace(':', '');
				const dateStr = data.date.replace(/-/g, '');

				let workStart, workEnd;
				if (data.shiftType === '조근') { workStart = '0600'; workEnd = '1400'; }
				else if (data.shiftType === '야근') { workStart = '1400'; workEnd = '2200'; }
				else { workStart = '0900'; workEnd = '1800'; }

				// 근무자 사번 조회
				const memberIds = (data.workers || [])
					.map(name => {
						const w = WORKER_IDS[name];
						if (!w) console.warn(`[AutoReport] ⚠️ 근무자 "${name}" → WORKER_IDS에 없음`);
						return w;
					})
					.filter(Boolean)
					.map(w => w.ZPPERNR.replace(/^0+/, ''));

				let IT_7505 = [];
				if (memberIds.length > 0) {
					const memberResults = await load_member(memberIds);
					IT_7505 = memberResults
						.filter(_ => _ && _.ITAB && _.ITAB.length > 0)
						.map(_ => ({ "ZPPERNR": _.ITAB[0].PERNR, "ZPENAME": _.ITAB[0].ENAME }));
					console.log(`[AutoReport] 근무자 ${data.workers.length}명 요청 → ${IT_7505.length}명 조회 성공`);
				}

				// ERP 데이터 객체 구성 (callBackAssignCopyData 호환 형식)
				// 주의: ZPRODGU, ZPRDFMT, ZJRES는 0200/0320 페이지마다 코드가 다르므로
				// callBackAssignCopyData 이후 텍스트 매칭으로 별도 설정
				const detailText = resolve_detail_template(data.category, data.pgmName, data.zresogu) || data.notes || '';

				const erpData = {
					CS_7523: {
						ZWBS: data.wbs || '',
						ZPNM: data.pgmName || '',
						ZUSDT: dateStr,
						ZBDATE: dateStr,
						ZSTIME: startTime,
						ZETIME: endTime,
						ZUSTM: workStart,
						ZUETM: workEnd,
						ZSUPER: '30883',
						ZRESOGU: data.zresogu || 'K001',
						ZORGEH: ERP_ZORGEH,
						ZENAMET: IT_7505.map(w => w.ZPENAME).join(', ')
					},
					IT_7505: IT_7505,
					IT_ZJRES: []
				};

				// 페이지 컨텍스트의 callBackAssignCopyData()로 폼 필드 채움
				// ZWORKTX는 callBackAssignCopyData 외부에서 직접 설정
				execCodeOnPageContext(function (ERP, detailText) {
					callBackAssignCopyData(ERP);
					$('#ZENAMET_TXT').html(ERP.IT_7505.map(_ => _.ZPENAME).join(', '));
					if (detailText) { $('#TEMP_ZWORKTX').val(detailText); }
				}, erpData, detailText);

				// 근무일(#TEMP_ZUSDT)을 일지 날짜와 동일하게 직접 설정
				// callBackAssignCopyData가 YYYYMMDD로 설정하지만 필드는 YYYY/MM/DD 형식 필요
				const dateFormatted = `${dateStr.slice(0, 4)}/${dateStr.slice(4, 6)}/${dateStr.slice(6, 8)}`;
				document.querySelector('#TEMP_ZUSDT').value = dateFormatted;


				// ===== 제작구분/포맷/리소스를 직접 텍스트 매칭으로 설정 =====
				// callBackAssignCopyData는 코드값으로 설정하므로 0200/0320 코드 차이로 실패할 수 있음
				// → 엑셀의 category 필드로 드롭다운 텍스트를 직접 검색하여 설정

				// 1) 제작구분: 엑셀 카테고리명으로 매칭 (생방송→생방, 녹화→녹화, 송출→송출)
				const prodguKeyword = CATEGORY_TO_PRODGU_TEXT[categoryClean] || categoryClean;
				const prodguSelect = document.querySelector('#TEMP_ZPRODGU');
				if (prodguSelect) {
					const opt = findOptionByText(prodguSelect, prodguKeyword);
					if (opt) {
						prodguSelect.value = opt.value;
						console.log(`[AutoReport] ✅ 제작구분: ${opt.value} (${opt.text.trim()})`);
					} else {
						console.warn(`[AutoReport] ⚠️ 제작구분 "${prodguKeyword}" 옵션 없음`);
					}
				}

				// 2) 제작포맷: 프로그램명 키워드 우선, 없으면 카테고리 기본값
				const pgmUpper = (data.pgmName || '').toUpperCase();
				let prdfmtKeyword = CATEGORY_TO_PRDFMT_TEXT[categoryClean] || 'HD';
				// 프로그램명에 특정 키워드가 있으면 포맷 오버라이드
				if (pgmUpper.includes('날씨')) prdfmtKeyword = '날씨';
				// category.json에 세부 포맷 지정이 있으면 그것을 우선 사용
				try {
					const catMap = await loadCategoryMap();
					const wbsPgm = (data.wbs || '').split('.')[0];
					const catEntry = wbsPgm ? catMap[wbsPgm] : null;
					if (catEntry && typeof catEntry === 'object' && catEntry.prdfmt) {
						prdfmtKeyword = catEntry.prdfmt;
					}
				} catch (e) { /* category.json 로드 실패해도 기본값으로 진행 */ }

				const prdfmtSelect = document.querySelector('#TEMP_ZPRDFMT');
				if (prdfmtSelect) {
					let opt = findOptionByText(prdfmtSelect, prdfmtKeyword);
					if (!opt && prdfmtKeyword === '뉴스') opt = findOptionByText(prdfmtSelect, 'HD');
					if (opt) {
						prdfmtSelect.value = opt.value;
						console.log(`[AutoReport] ✅ 제작포맷: ${opt.value} (${opt.text.trim()})`);
					}
				}

				// 3) 제작리소스: 뉴스 관련이면 "뉴스" 키워드, 아니면 첫 번째 옵션
				const zjresSelect = document.querySelector('#zjres_list select');
				if (zjresSelect) {
					const zjresOpts = Array.from(zjresSelect.options).filter(o => o.value);
					const isNewsRelated = ['생방', '생방송'].includes(categoryClean) || prdfmtKeyword === '뉴스' || prdfmtKeyword === '날씨';
					let zjresOpt = isNewsRelated ? zjresOpts.find(o => o.text.includes('뉴스')) : null;
					if (!zjresOpt && zjresOpts.length > 0) zjresOpt = zjresOpts[0];
					if (zjresOpt) {
						zjresSelect.value = zjresOpt.value;
						console.log(`[AutoReport] ✅ 제작리소스: ${zjresOpt.value} (${zjresOpt.text})`);
					}
				}

				console.log('[AutoReport] ✅ 폼 입력 완료 — 저장 버튼을 누르면 API로 저장됩니다 (리다이렉트 없음)');
				sendResponse({ success: true, message: '폼 입력 완료' });
			} catch (err) {
				console.error('[AutoReport] ❌ 폼 입력 오류:', err);
				sendResponse({ success: false, message: err.message });
			}
		})();

		return true;
	}

	if (req.function !== 'batch_erp_input') return false;

	const programs = req.data;
	console.log(`[AutoReport] ERP 일괄 입력 시작: ${programs.length}건`);
	console.table(programs);

	// 비동기 처리
	(async () => {
		const loginInfo = await load_login_info();
		const results = [];
		let successCount = 0;
		let failCount = 0;
		let skipCount = 0;

		for (let i = 0; i < programs.length; i++) {
			const pgm = programs[i];
			console.log(`[AutoReport] [${i + 1}/${programs.length}] 처리 중: ${pgm.category} | ${pgm.pgmName} | ${pgm.start}~${pgm.end}`);

			try {
				const result = await save_erp_record(pgm, loginInfo);
				
				if (result.success) {
					successCount++;
					console.log(`[AutoReport] ✅ [${i + 1}] 저장 성공: ${result.message}`);
					results.push({ ...pgm, ...result, status: 'saved' });
				} else if (result.message && result.message.includes('중복')) {
					skipCount++;
					console.log(`[AutoReport] ⏭️ [${i + 1}] 이미 입력됨 (건너뜀)`);
					results.push({ ...pgm, ...result, status: 'duplicate' });
				} else {
					failCount++;
					console.error(`[AutoReport] ❌ [${i + 1}] 저장 실패: ${result.message}`);
					results.push({ ...pgm, ...result, status: 'failed' });
				}

				// 건 사이에 500ms 대기 (서버 부하 방지)
				if (i < programs.length - 1) {
					await new Promise(r => setTimeout(r, 500));
				}
			} catch (err) {
				failCount++;
				console.error(`[AutoReport] ❌ [${i + 1}] 오류:`, err);
				results.push({ ...pgm, success: false, message: err.message, status: 'error' });
			}
		}

		console.log(`[AutoReport] 일괄 입력 완료: 성공 ${successCount}건, 중복 ${skipCount}건, 실패 ${failCount}건`);

		sendResponse({
			success: failCount === 0,
			total: programs.length,
			successCount,
			skipCount,
			failCount,
			results
		});
	})();

	return true; // 비동기 응답을 위해 true 반환
});

