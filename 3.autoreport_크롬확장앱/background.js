// ============================================================================
// background.js — Service Worker (백그라운드 스크립트)
// ============================================================================
// Chrome Extension Manifest V3의 Background Service Worker.
// popup.js나 contentscript.js에서 chrome.runtime.sendMessage()로 보낸 요청을
// tvdss.js의 함수로 중계(릴레이)하는 역할을 한다.
//
// 왜 Background에서 호출하는가?
//   - Manifest V3에서 Content Script는 CORS 제한이 있어 외부 도메인(tvdss.kbs.co.kr)에
//     직접 fetch()를 할 수 없다.
//   - Background Service Worker는 host_permissions에 명시된 도메인에 자유롭게 접근 가능.
//   - 따라서 Content Script/Popup → Background → 외부 API 순으로 요청을 중계한다.
// ============================================================================

import {get_schedule, get_scroll} from './tvdss.js';

// ---------------------------------------------------------------------------
// 확장 프로그램 설치/업데이트 시 실행되는 이벤트 (현재 비어있음)
// 필요 시 초기 데이터 설정, 알림 등록 등에 활용 가능
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
})

// ---------------------------------------------------------------------------
// 확장 아이콘 클릭 시 플로팅 창으로 popup.html 열기
// default_popup을 제거했으므로 onClicked 이벤트가 발생한다.
// 이미 열려있는 창이 있으면 포커스, 없으면 새 창 생성.
// ---------------------------------------------------------------------------
let popupWindowId = null;

chrome.action.onClicked.addListener(async () => {
	if (popupWindowId !== null) {
		try {
			const win = await chrome.windows.get(popupWindowId);
			if (win) {
				chrome.windows.update(popupWindowId, { focused: true });
				return;
			}
		} catch (e) {
			popupWindowId = null;
		}
	}

	const win = await chrome.windows.create({
		url: chrome.runtime.getURL('popup.html'),
		type: 'popup',
		width: 800,
		height: 700
	});
	popupWindowId = win.id;
});

chrome.windows.onRemoved.addListener((windowId) => {
	if (windowId === popupWindowId) {
		popupWindowId = null;
	}
});

// ---------------------------------------------------------------------------
// 포트 연결 이벤트 (현재 비어있음)
// 장기 연결(long-lived connection)이 필요한 경우에 활용
// ---------------------------------------------------------------------------
chrome.runtime.onConnect.addListener(port => {
})

// ---------------------------------------------------------------------------
// 메시지 수신 핸들러
// popup.js 또는 contentscript.js에서 보낸 메시지를 처리한다.
//
// 메시지 형식: { function: "함수명", param: [파라미터들] }
// 응답: rsp(결과) — 비동기 응답을 위해 return true 필수
//
// 참조: stackoverflow.com/questions/53024819
//   chrome.runtime.sendMessage의 rsp 콜백은 동기 함수만 지원하므로,
//   비동기 작업(await)을 하려면 IIFE(즉시실행 비동기 함수)로 감싸고
//   return true를 반환하여 응답 채널을 열어둬야 한다.
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((req, ctx, rsp) => {
	switch(req.function){
		case "get_schedule": {
			// TVDSS 편성확인 스케줄 조회
			(async () => {
				const ret = await get_schedule(11, 70, new Date('2023-01-16'));

				console.log("----------");
				console.log(new Date().toLocaleDateString());
				console.log(req);		// 요청 내용
				console.log(ctx);		// 발신자 컨텍스트 (탭 정보 등)
				console.log(ret);		// API 응답 결과
				console.log("----------");
				rsp(ret);				// 요청자에게 응답 반환
			})();
			break;
		}
		case "get_scroll": {
			// TVDSS 스크롤 송출 결과 조회
			(async () => {
				const ret = await get_scroll(...req.param);

				console.log("----------");
				console.log(new Date().toLocaleDateString());
				console.log(req);
				console.log(ctx);
				console.log(ret);
				console.log("----------");
				rsp(ret);
			})();
			break;
		}
		default:
			break;
	}

	// 비동기 응답을 위해 반드시 true를 반환 (응답 채널 유지)
	return true;
})