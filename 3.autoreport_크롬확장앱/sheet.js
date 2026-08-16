// ============================================================================
// sheet.js — Google Sheets API v4 클라이언트
// ============================================================================
// Google Sheets를 간이 데이터베이스로 활용하기 위한 모듈.
// JWT(RS256) 서비스 계정 인증을 통해 별도 OAuth 팝업 없이 API에 접근한다.
//
// 주요 용도:
//   - 'Alias' 시트: 프로그램/스팟 ID → 약칭 매핑 (popup.js에서 사용)
//   - 월별 시트 (예: '26-02'): 근무자, 스케줄 데이터
// ============================================================================

import { CONFIG } from "./config.js";

// ---------------------------------------------------------------------------
// Google Sheets 설정값 (config.js 연동)
// ---------------------------------------------------------------------------
const SHEET_ID    = CONFIG.GOOGLE_SHEETS?.SHEET_ID || "";
const API_KEY     = CONFIG.GOOGLE_SHEETS?.API_KEY || "";
const SERVICE_ACC = CONFIG.GOOGLE_SHEETS?.SERVICE_ACC || "";
const PRIVATE_PEM = CONFIG.GOOGLE_SHEETS?.PRIVATE_PEM || "";

// ============================================================================
// JWT 토큰 서명 (RS256)
// ============================================================================
// Google API는 OAuth 2.0 외에 JWT Bearer 토큰 인증도 지원한다.
// 서비스 계정의 비공개 키로 JWT를 직접 서명하여 Bearer 토큰으로 사용.
//
// 흐름:
//   1. Header(alg, typ, kid) + Payload(iss, sub, aud, iat, exp) 작성
//   2. Web Crypto API(SubtleCrypto)로 RSA-SHA256 서명
//   3. Header.Payload.Signature를 Base64로 인코딩하여 JWT 문자열 생성
//
// 참조:
//   - stateful.com/blog/key-generation-webcrypto
//   - developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/importKey
//   - developers.google.com/identity/protocols/oauth2/service-account#jwt-auth
// ============================================================================
const sign_JWT = async (HEADER, PAYLOAD, PRIVATE_PEM) => {
	// PEM 형식의 비공개 키를 Web Crypto API용 CryptoKey 객체로 변환
	const CRYPTO_KEY = await crypto.subtle.importKey(
		"pkcs8",
		Uint8Array.from(
			atob(PRIVATE_PEM.replace(/^-.+-$/gm, '').replace(/\n/gm, '')), c => c.charCodeAt(0)
		),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		true,
		["sign"]
	);

	// Header와 Payload를 Base64로 인코딩
	const HEADER_b64 = btoa(JSON.stringify(HEADER));
	const PAYLOAD_b64 = btoa(JSON.stringify(PAYLOAD));

	// "Header_b64.Payload_b64" 문자열에 대해 RSA-SHA256 서명
	const SIGNATURE =  await crypto.subtle.sign(
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'},
		CRYPTO_KEY,
		Uint8Array.from(
			`${HEADER_b64}.${PAYLOAD_b64}`, c => c.charCodeAt(0)
		)
	);
	const SIGNATURE_b64 = btoa(String.fromCharCode(...new Uint8Array(SIGNATURE)));

	// 최종 JWT: Header.Payload.Signature (Base64 인코딩)
	return `${HEADER_b64}.${PAYLOAD_b64}.${SIGNATURE_b64}`;
};

// ---------------------------------------------------------------------------
// Google Sheets API 접근용 JWT Bearer 토큰 생성
// 토큰 유효기간: 생성 시점부터 1시간
//
// 참조:
//   - developers.google.com/identity/protocols/oauth2/service-account?hl=ko#jwt-auth
//   - stackoverflow.com/questions/70333985
// ---------------------------------------------------------------------------
const build_gapi_token = async () => {
	const HEADER = {
		alg: 'RS256',		// 서명 알고리즘
		typ: 'JWT',			// 토큰 타입
		kid: PRIVATE_KID	// 비공개 키 ID
	};
	
	const PAYLOAD = {
		iss: SERVICE_ACC,		// 발급자 (서비스 계정 이메일)
		sub: SERVICE_ACC,		// 대상 (동일)
		aud: "https://sheets.googleapis.com/",	// 대상 API
		iat: parseInt(new Date().getTime() / 1000),			// 발급 시각 (epoch초)
		exp: parseInt(new Date().getTime() / 1000) + 3600	// 만료 시각 (+1시간)
	};

	return await sign_JWT(HEADER, PAYLOAD, PRIVATE_PEM);
};

// ============================================================================
// Google Sheets API v4 CRUD 함수들
// ============================================================================
// 모든 함수가 build_gapi_token()으로 생성한 JWT Bearer 토큰을 사용.

// ---------------------------------------------------------------------------
// [시트 조작] 행 삭제 (spreadsheets.batchUpdate)
// GID: 시트의 고유 ID (탭별 ID)
// HEAD~TAIL 범위의 행을 삭제한다 (0-indexed, [HEAD, TAIL) 반개구간)
// ---------------------------------------------------------------------------
const delete_sheet_row = async (GID, HEAD, TAIL) => {
	return await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${await build_gapi_token()}`
		},
		body: JSON.stringify({
			requests: [
				{
					deleteDimension: {
						range: {
							sheetId		: GID,
							dimension	: "ROWS",
							startIndex	: HEAD,
							endIndex	: TAIL
						}
					}
				}
			]
		})
	})
	.then(rsp => rsp.json());
}

// ---------------------------------------------------------------------------
// [시트 읽기] 셀 값 조회 (spreadsheets.values.get)
// TAB: 시트 탭 이름, RANGE: A1 표기법 범위 (예: "A2:D")
// ---------------------------------------------------------------------------
const get_sheet_value = async (TAB, RANGE) => {
	return await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${TAB}!${RANGE}`, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${await build_gapi_token()}`
		}
	})
	.then(rsp => rsp.json());
}

// ---------------------------------------------------------------------------
// [시트 쓰기] 셀 값 수정 (spreadsheets.values.update)
// 기존 값을 덮어쓴다. valueInputOption=RAW → 입력값을 그대로 저장 (수식 해석 안 함)
// ---------------------------------------------------------------------------
const update_sheet_value = async (TAB, RANGE, VALUES) => {
	return await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${TAB}!${RANGE}?valueInputOption=RAW`, {
		method: "PUT",
		headers: {
			Authorization: `Bearer ${await build_gapi_token()}`
		},
		body: JSON.stringify({
			range			: `${TAB}!${RANGE}`,
			majorDimension	: 'ROWS',
			values			: VALUES
		})
	})
	.then(rsp => rsp.json());
}

// ---------------------------------------------------------------------------
// [시트 쓰기] 행 추가 (spreadsheets.values.append)
// 지정 범위의 마지막 행 다음에 새 데이터를 추가한다.
// ---------------------------------------------------------------------------
const append_sheet_value = async (TAB, RANGE, VALUES) => {
	return await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${TAB}!${RANGE}:append?valueInputOption=RAW`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${await build_gapi_token()}`
		},
		body: JSON.stringify({
			range			: `${TAB}!${RANGE}`,
			majorDimension	: 'ROWS',
			values			: VALUES
		})
	})
	.then(rsp => rsp.json());
}

// ---------------------------------------------------------------------------
// [시트 쓰기] 범위 초기화 (spreadsheets.values.clear)
// 지정 범위의 모든 셀 값을 지운다 (서식은 유지).
// ---------------------------------------------------------------------------
const clear_sheet_value = async (TAB, RANGE) => {
	return await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${TAB}!${RANGE}:clear`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${await build_gapi_token()}`
		}
	})
	.then(rsp => rsp.json());
}

// ============================================================================
// 공개 API (Export 함수들)
// ============================================================================

// ---------------------------------------------------------------------------
// 'Alias' 시트에서 프로그램 약칭 매핑 조회 (A2:D 범위)
// 반환: { values: [[코드, ?, ?, 약칭], ...] }
// popup.js에서 TVDSS 프로그램 ID를 일지 표시용 약칭으로 변환할 때 사용
// ---------------------------------------------------------------------------
export async function get_alias(){
	return await get_sheet_value('Alias', 'A2:D');
}

// ---------------------------------------------------------------------------
// 'Alias' 시트의 특정 행 삭제
// INDEX: 0-based 행 인덱스 (헤더 행 제외), 실제 삭제는 INDEX+1~INDEX+2
// ---------------------------------------------------------------------------
export async function del_alias(INDEX){
	return await delete_sheet_row(0, INDEX + 1, INDEX + 2);
}

// ---------------------------------------------------------------------------
// 월별 시트에서 근무자 조회
// DATE로부터 시트 탭 이름을 생성 (예: "26-02")
// B9:D 범위에서 근무자 데이터를 읽는다.
// ---------------------------------------------------------------------------
export async function get_member(DATE){
	return await get_sheet_value(
		`${('0' + DATE.getUTCFullYear()).slice(-2)}-${('0' + (DATE.getMonth() + 1)).slice(-2)}`,
		'B9:D'
	);
}

// ---------------------------------------------------------------------------
// 월별 시트에서 스케줄 조회
// DATE로부터 시트 탭 이름을 생성 (예: "26-02")
// F9:AJ 범위에서 스케줄 데이터를 읽는다.
// ---------------------------------------------------------------------------
export async function get_schedule(DATE){
	return await get_sheet_value(
		`${('0' + DATE.getUTCFullYear()).slice(-2)}-${('0' + (DATE.getMonth() + 1)).slice(-2)}`,
		'F9:AJ'
	);
}
