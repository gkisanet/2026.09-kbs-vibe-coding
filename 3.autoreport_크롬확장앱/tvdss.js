// ============================================================================
// tvdss.js — TVDSS(편성확인 시스템) API 클라이언트
// ============================================================================
// KBS TVDSS(tvdss.kbs.co.kr)에 접속하여 편성 운행 데이터를 조회하는 모듈.
// - 일별 편성 스케줄 (프로그램, 스팟)
// - 스크롤 송출 결과
// - 로컬 정적 데이터 (약칭, 분류, 근무시간대)
//
// 모든 API 호출에는 RETRY 로직(최대 10회)이 적용되어 있으며,
// 세션 만료로 리다이렉트 되면 자동으로 재로그인을 시도한다.
// ============================================================================

import { CONFIG } from "./config.js";

// ---------------------------------------------------------------------------
// TVDSS 로그인 자격 증명 (config.js 연동)
// ---------------------------------------------------------------------------
const USERNAME = CONFIG.TVDSS?.USERNAME || "";
const PASSWORD = CONFIG.TVDSS?.PASSWORD || "";


// ---------------------------------------------------------------------------
// [내부] 자동 로그인
// TVDSS 세션이 만료되면(리다이렉트 발생) 이 함수로 재로그인한다.
// 로그인 계정은 전체 편성표 조회용 공용 계정.
// ---------------------------------------------------------------------------
async function do_login(username = USERNAME, password = PASSWORD){
	await fetch('http://tvdss.kbs.co.kr/uat/uia/actionLogin.do', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
		},
		body: `empCode=${username}` + `&` + `password=${password}`
	})
	.then(rsp => console.log(rsp));
}

// ---------------------------------------------------------------------------
// [내부] 지역국 목록 조회
// TVDSS에 등록된 지역국 코드 목록을 가져온다.
// (현재 직접 사용되지 않으나, 디버깅 또는 확장 용도로 존재)
// ---------------------------------------------------------------------------
async function get_local(){	
	let RETRY = 10;
	
	while(RETRY --> 0){
		const rsp = await fetch('http://tvdss.kbs.co.kr/ajax/comm/local/list.do', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
			}
		});

		if(rsp.redirected)
			do_login();			// 세션 만료 → 재로그인 후 재시도
		else
			return (await rsp.json()).result;
	}

	return [];
}

// ---------------------------------------------------------------------------
// [공개] 일별 편성확인 스케줄 조회
// 지정된 채널·지역·날짜의 편성 운행 스케줄을 가져온다.
//
// @param channel_code - 채널 코드 (기본값 11 = KBS 1TV)
// @param local_code   - 지역국 코드 (기본값 70 = 청주)
// @param date         - 조회 날짜 (Date 객체)
// @returns 편성 스케줄 배열 (local_yn == "Y"인 항목만 필터링)
//
// 반환 항목의 주요 필드:
//   pgm_cd/pgm_id: 프로그램 코드
//   pgm_nm: 프로그램명
//   unhg_ymd: 운행 일자 (YYYYMMDD)
//   unhg_time: 운행 시각 (HHMMSSff)
//   unhg_run: 운행 시간 (HHMMSS)
//   event_gb: 이벤트 구분 (P=프로그램, 그 외=스팟)
//   jejak_typ1: 제작유형 (Y=생방)
//   rebroad_gb: 재방 구분 (01=본방, 그 외=재방)
//   local_yn: 지역 프로그램 여부 (Y/N)
// ---------------------------------------------------------------------------
export async function get_schedule(channel_code = 11, local_code = 70, date){
	let RETRY = 10;
	
	while(RETRY --> 0){
		const rsp = await fetch('http://tvdss.kbs.co.kr/ajax/day/sclcnfm/list.do', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
			},
			body: 
				`chan_gb=${channel_code}&local_cd=${local_code}&` + 
				`unhg_ymd=${date.toLocaleDateString('ko-kr', {year:'numeric', month:'2-digit', day:'2-digit'}).replace(/[\s\.]/g, '')}` +
				`&` + 
				`day_gb=0`
		});

		if(rsp.redirected)
			do_login();
		else
			return (await rsp.json()).result.filter(e => e.local_yn == "Y");
	}

	return [];
}

// ---------------------------------------------------------------------------
// [공개] 스크롤 송출 결과 조회
// 지정된 기간의 스크롤 자막 송출 내역을 조회한다.
//
// @param channel_code - 채널 코드
// @param local_code   - 지역국 코드
// @param date_1       - 검색 시작일 (Date 객체)
// @param date_2       - 검색 종료일 (Date 객체)
// @returns 스크롤 송출 결과 배열
//
// 반환 항목의 주요 필드:
//   scrollCode: 스크롤 코드
//   subject: 스크롤 제목
//   unhgYmd: 운행 일자
//   unhgTime: 운행 시작 시각
//   unhgEndTime: 운행 종료 시각
// ---------------------------------------------------------------------------
export async function get_scroll(channel_code = 11, local_code = 70, date_1, date_2){
	let RETRY = 10;
	
	while(RETRY --> 0){
		const rsp = await fetch('http://tvdss.kbs.co.kr/ajax/mtr/scroll/result.do', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
			},
			body: 
			`channelCode=${channel_code}&localCode=${local_code}&scrollGubun=-1&searchWord=&` + 
			`searchFrDt=${date_1.toLocaleDateString('ko-kr', {year:'numeric', month:'2-digit', day:'2-digit'}).replace(/\s/g, '').slice(0, -1)}` +
			`&` +
			`searchToDt=${date_2.toLocaleDateString('ko-kr', {year:'numeric', month:'2-digit', day:'2-digit'}).replace(/\s/g, '').slice(0, -1)}`
		});

		if(rsp.redirected)
			do_login();
		else
			return (await rsp.json()).result;
	}

	return [];
}

// ---------------------------------------------------------------------------
// [공개] 로컬 정적 데이터 조회
// 확장 프로그램에 내장된 JSON 파일에서 매핑 데이터를 가져온다.
// 이 데이터는 TVDSS API 응답의 ID를 사람이 읽기 쉬운 텍스트로 변환하는 데 사용된다.
// ---------------------------------------------------------------------------

// 프로그램/스팟 ID → 일지 표시용 약칭 (예: "T2003-0143" → "NEWS")
export const get_alias		= async () => await fetch('./data/alias.json',		{method: 'GET'}).then(rsp => rsp.json());

// 프로그램 ID → 분류 (예: "T2003-0143" → "생방")
export const get_category	= async () => await fetch('./data/category.json',	{method: 'GET'}).then(rsp => rsp.json());

// 근무 시간대 구분 (예: { "조근": "06:00-14:00", "야근": "14:00-22:00" })
export const get_group		= async () => await fetch('./data/group.json',		{method: 'GET'}).then(rsp => rsp.json());