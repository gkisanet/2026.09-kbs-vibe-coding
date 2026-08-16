// ============================================================================
// popup.js — 현업일지(TV) 팝업 뷰어 로직
// ============================================================================
// 확장 아이콘 클릭 시 표시되는 팝업 페이지의 메인 스크립트.
// TVDSS 편성확인 시스템에서 당일 스케줄을 가져와
// 조근(오전)/야근(오후)/일근 별로 현업일지를 자동 생성한다.
//
// 데이터 소스:
//   - tvdss.js → TVDSS API (편성 스케줄, 스크롤 송출)
//   - sheet.js → Google Sheets (프로그램 약칭)
//   - data/group.json → 근무 시간대 구분
// ============================================================================

import {get_schedule, get_scroll, get_alias, get_group, get_category} from "./tvdss.js"
import {get_alias as get_sheet_alias, del_alias as del_sheet_alias} from "./sheet.js"

// ---------------------------------------------------------------------------
// 상수: 채널 및 지역국 코드
// ---------------------------------------------------------------------------
const CHANNEL_1TV	= 11;		// KBS 1TV 채널 코드
const LOCAL_CJ		= 70;		// 청주(CJ) 지역국 코드

// ============================================================================
// TVDSS 데이터 로드 및 전처리
// ============================================================================
// TVDSS에서 편성 스케줄을 가져와 프로그램·스팟·스크롤 3가지로 분류 및 가공한다.
//
// @param CHANNEL - 채널 코드
// @param LOCAL   - 지역국 코드
// @param DATE    - 조회 날짜
// @returns [프로그램 배열, 스팟 배열, 스크롤 그룹 배열]
// ============================================================================
async function load_tvdss(CHANNEL, LOCAL, DATE){
	// Google Sheets에서 프로그램 약칭 매핑 가져오기
	// (로컬 alias.json 대신 Sheets의 최신 데이터 사용)
	const category  = await get_category();
	const alias		= Object.fromEntries(
		(await get_sheet_alias()).values.map(_ => [_[0], _[3]])
	);

	// ----- 프로그램(P) 전처리 -----
	// event_gb == "P"인 항목만 필터링하여 프로그램 목록 생성
	const pgm_ret = [];
	for(let _ of (await get_schedule(CHANNEL, LOCAL, DATE)).filter(e => e.local_yn == "Y" && e.event_gb == "P")){
		const ID = _.pgm_cd || _.pgm_id;		// 프로그램 코드 (없으면 프로그램 ID)
		const NAME = _.pgm_nm;					// 프로그램 원본 이름
		// 방송 시작 시각 파싱 (YYYYMMDD + HHMMSSff → Date 객체)
		const HEAD = new Date(
			`${_.unhg_ymd.substr(0,4)}-${_.unhg_ymd.substr(4,2)}-${_.unhg_ymd.substr(6,4)}` +
			`T` +
			`${_.unhg_time.substr(0,2)}:${_.unhg_time.substr(2,2)}:${_.unhg_time.substr(4,2)}.${_.unhg_time.substr(6,2)}+0900`
		);
		// 방송 종료 시각 = 시작 + 운행시간(HHMMSS를 초로 환산)
		const TAIL = new Date(
			HEAD.getTime() +
			(parseInt(_.unhg_run.substr(0,2)) * 3600 + parseInt(_.unhg_run.substr(2,2)) * 60 + parseInt(_.unhg_run.substr(4,2))) * 1000
		);
		
		// 약칭이 없는 프로그램은 콘솔에 경고 (운영자가 Sheets에 추가해야 함)
		if(!alias[ID])
			console.log(`${NAME}(${ID})에 대한 약칭이 없습니다`);

		if(!category[ID])
			console.log(`${NAME}(${ID})에 대한 분류가 없습니다`);

		pgm_ret.push({
			id: ID,
			alias: (alias[ID] || _.pgm_nm) + (_.rebroad_gb != "01" ? "(재)" : ""),	// 약칭 + 재방 표시
			category: (_.jejak_typ1 == 'Y' ? '생방' : '송출'),						// 생방/송출 구분
			name: NAME,
			head: HEAD,				// 시작 시각
			tail: TAIL,				// 종료 시각
			live: _.jejak_typ1 == 'Y',
			record: _.jejak_typ == '02', // ''=화면조정/Sign On, '00'=?, '01'=생방, '02'=녹화, '03'=기타
			str1: 	// "HH:MM-HH:MM" 형식의 시간 문자열
				`${HEAD.toLocaleTimeString("ko-kr", {hour12:false, hour:"2-digit", minute:"2-digit"})}` +
				`-` +
				`${TAIL.toLocaleTimeString("ko-kr", {hour12:false, hour:"2-digit", minute:"2-digit"})}`,
			str2: 	// "NN분" 형식의 방송 시간
				`${Math.floor(TAIL.getTime() / 60000) - Math.floor(HEAD.getTime() / 60000)}분`
		})
	}
	// 시작 시각 순 정렬
	pgm_ret.sort((_1, _2) => (_1.head < _2.head));

	// ----- 스팟(비프로그램) 전처리 -----
	// event_gb != "P"인 항목 → 동일 약칭끼리 그룹핑하여 횟수 집계
	const spt_ret = [];
	for(let _ of (await get_schedule(CHANNEL, LOCAL, DATE)).filter(e => e.local_yn == "Y" && e.event_gb != "P")){
		const ID = _.spot_id;
		const NAME = _.pgm_nm;
		const HEAD = new Date(
			`${_.unhg_ymd.substr(0,4)}-${_.unhg_ymd.substr(4,2)}-${_.unhg_ymd.substr(6,4)}` +
			`T` +
			`${_.unhg_time.substr(0,2)}:${_.unhg_time.substr(2,2)}:${_.unhg_time.substr(4,2)}.${_.unhg_time.substr(6,2)}+0900`
		);
		const TAIL = new Date(
			HEAD.getTime() +
			(parseInt(_.unhg_run.substr(0,2)) * 3600 + parseInt(_.unhg_run.substr(2,2)) * 60 + parseInt(_.unhg_run.substr(4,2))) * 1000
		);
		
		if(!alias[ID])
			console.log(`${NAME}(${ID})에 대한 약칭이 없습니다`);		
		
		// 동일 약칭의 스팟이 이미 있으면 시간만 추가, 없으면 새 항목 생성
		const elem = spt_ret.find(e => e.alias == (alias[ID] || NAME));
		if(!elem)
			spt_ret.push({
				id: ID,
				alias: alias[ID] || NAME,
				name: NAME,
				list: [HEAD]				// 송출 시각 목록
			});
		else
			elem.list.push(HEAD);	
	}
	// 첫 송출 시각 순 정렬
	spt_ret.sort((_1, _2) => (_1.list[0] < _2.list[0]));

	// ----- 스크롤 전처리 -----
	// 스크롤 자막 송출 내역을 가져와 시간순 정렬 후, 5분 간격으로 그룹핑
	const scr_ret = [];
	for(let _ of await get_scroll(CHANNEL, LOCAL, DATE, DATE)){
		const ID = _.scrollCode;
		const NAME = _.subject;
		const HEAD = new Date(
			`${_.unhgYmd.substr(0,4)}-${_.unhgYmd.substr(4,2)}-${_.unhgYmd.substr(6,4)}` + 
			`T` + 
			`${_.unhgTime.substr(0,2)}:${_.unhgTime.substr(2,2)}:${_.unhgTime.substr(4,2)}+0900`
		);
		const TAIL = new Date(
			`${_.unhgYmd.substr(0,4)}-${_.unhgYmd.substr(4,2)}-${_.unhgYmd.substr(6,4)}` + 
			`T` + 
			`${_.unhgEndTime.substr(0,2)}:${_.unhgEndTime.substr(2,2)}:${_.unhgEndTime.substr(4,2)}+0900`
		);
		
		if(!alias[ID])
			console.log(`${NAME}(${ID})에 대한 약칭이 없습니다`);		
		
		scr_ret.push({
			id: ID,
			alias: alias[ID] || NAME,
			name: NAME,
			head: HEAD,
			tail: TAIL
		});
	}
	// 시간순 정렬
	scr_ret.sort((_1, _2) => (_1.head - _2.head));

	// 5분(300,000ms) 간격으로 스크롤을 그룹핑 (동시 송출 묶음)
	const scr_grp = [];
	for(const [idx, val] of scr_ret.entries()){
		if((idx == 0) || (scr_ret[idx - 0].head - scr_ret[idx - 1].head > 300000))
			scr_grp.push([val]);		// 새 그룹 시작
		else
			scr_grp[scr_grp.length - 1].push(val);		// 기존 그룹에 추가
	}

	// [프로그램, 스팟, 스크롤그룹] 반환
	return [pgm_ret, spt_ret, scr_grp];
}

// ============================================================================
// UI 테이블 초기화
// ============================================================================
// 지정된 근무 그룹(am/pm/mm)의 근무자 테이블과 스케줄 테이블을
// 빈 행으로 초기화한다.
//
// @param GROUP        - 'am'(조근), 'pm'(야근), 'mm'(일근)
// @param WORKER_NUM   - 근무자 행 수
// @param SCHEDULE_NUM - 스케줄 행 수 (근무자보다 작으면 근무자 수로 맞춤)
// ============================================================================
async function make_default_UI(GROUP, WORKER_NUM, SCHEDULE_NUM){

	// 스케줄 테이블은 항상 근무자 테이블보다 크거나 같아야 함
	if(WORKER_NUM > SCHEDULE_NUM)
		SCHEDULE_NUM = WORKER_NUM;

	let PREFIX = GROUP;

	// ----- 근무자 테이블 작성 -----
	{
		const target = document.querySelector(`#${PREFIX}-worker-table`);

		// 기존 행 제거 후 새로 생성
		target.querySelectorAll(`tbody tr`).forEach(e => e.remove());		
		for(let _ = 0; _ < SCHEDULE_NUM; _++) {
			const tr = document.createElement("tr");
			if(_ < WORKER_NUM + 1){
				const td = document.createElement("td");				
				{
					const span = document.createElement("span");
					span.innerHTML = "&nbsp;";
					td.appendChild(span);
				}					
				tr.appendChild(td);
			}
			target.querySelector(`tbody`).appendChild(tr);
		}

		// 근무자 행이 스케줄 행보다 적으면, 마지막 근무자 셀을 rowspan으로 확장
		if(WORKER_NUM < SCHEDULE_NUM)
			target.querySelector(`tbody tr:nth-child(${WORKER_NUM + 1}) td`).rowSpan = (SCHEDULE_NUM - WORKER_NUM);
	}

	// ----- 스케줄 테이블 작성 -----
	{
		const target = document.querySelector(`#${PREFIX}-schedule-table`);

		target.querySelectorAll(`tbody tr`).forEach(e => e.remove());		
		for(let _ = 0; _ < SCHEDULE_NUM; _++) {
			const tr = document.createElement("tr");
			// 4개 컬럼: 구분, PGM명, 부터-까지, 시간
			for(let __ = 0; __ < 4; __++) {
				const td = document.createElement("td");
				{
					const span = document.createElement("span");
					span.innerHTML = "&nbsp;";
					td.appendChild(span);
				}			
				tr.appendChild(td);
			}
			target.querySelector(`tbody`).appendChild(tr);
		}
	}

	// 우측 특기사항 초기화
	document.querySelector(`#${PREFIX}-desc-R`).innerHTML = '';

	// 좌하 특기사항 초기화
	document.querySelector(`#${PREFIX}-desc-L tbody tr td div`).innerHTML = '&nbsp;';
}

// ============================================================================
// 리포트 빌드 (메인 렌더링 함수)
// ============================================================================
// TVDSS 데이터를 가져와 조근·야근·일근별로 테이블에 렌더링한다.
//
// @param DATE - 리포트 날짜 (Date 객체)
// ============================================================================
async function build_report(DATE){

	// UI 초기화: 조근(4행), 야근(12행), 일근(4행)
	await make_default_UI('am', 4, 4);
	await make_default_UI('pm', 4, 12);
	await make_default_UI('mm', 4, 4);

	// 상단 날짜 표시 갱신
	document.querySelector('#title-date > span').innerHTML = `${DATE.toLocaleDateString('ko-kr', {year:'numeric', month:'2-digit', day:'2-digit', weekday: 'long'})} 날씨`;

	// TVDSS에서 편성 운행표 가져오기 (프로그램, 스팟, 스크롤)
	const [program, spot, scroll] = await load_tvdss(CHANNEL_1TV, LOCAL_CJ, DATE);

	// group.json에서 근무 시간대 정의 가져오기 (조근/야근)
	const group     = await get_group();

	// ----- 시간대별 리포트 렌더링 -----
	for(const [k, v] of Object.entries(group)){
		// 시간대 범위 파싱 (예: "06:00-14:00" → t1~t2)
		const t1 = new Date(DATE.toLocaleDateString() + v.split("-")[0]);
		const t2 = new Date(DATE.toLocaleDateString() + v.split("-")[1]);

		// --- 스케줄(프로그램) ---
		// 해당 시간대에 속하는 프로그램을 필터링하여 테이블에 채움
		const pgm_ret = [];
		for(const _ of program)
			if(_.head >= t1 && _.head < t2)
				pgm_ret.push([_.category, _.alias, _.str1, _.str2]);
		
		for(const [idx, pgm] of pgm_ret.entries()){
			// 근무 유형에 따라 대상 테이블 선택
			let table = undefined;
			if(k == "조근") table = document.querySelector('#am-schedule-table');
			if(k == "야근") table = document.querySelector('#pm-schedule-table');
			if(k == "일근") table = document.querySelector('#mm-schedule-table');

			// 4개 컬럼에 데이터 채우기: 구분 | PGM명 | 시간 범위 | 방송시간
			table.querySelector(`tbody tr:nth-child(${idx + 1}) td:nth-of-type(1)`).innerHTML = `<span>${pgm[0]}</span>`;
			table.querySelector(`tbody tr:nth-child(${idx + 1}) td:nth-of-type(2)`).innerHTML = `<span>${pgm[1]}</span>`;
			table.querySelector(`tbody tr:nth-child(${idx + 1}) td:nth-of-type(3)`).innerHTML = `<span>${pgm[2]}</span>`;
			table.querySelector(`tbody tr:nth-child(${idx + 1}) td:nth-of-type(4)`).innerHTML = `<span>${pgm[3]}</span>`;
		}

		// --- 스팟 ---
		// 해당 시간대의 스팟을 필터링, 약칭별로 송출 시각 나열 + 총 건수 집계
		let spt_len = 0;
		let spt_str = "";
		for(const _ of spot){
			const __ = Object.assign({}, _);		// 원본 데이터 보존을 위해 복사
			__.list = __.list.filter(e => e >= t1 && e < t2);
			if(__.list.length == 0)
				continue;
			spt_len += __.list.length;
			spt_str += `  - ${__.alias}(${__.list.map(e => e.toLocaleTimeString("ko-kr", {hour12:false, hour:"2-digit", minute:"2-digit"}))})\n`;
		}

		// 스팟이 있으면 우측 특기사항 영역에 추가
		if(spt_str) {
			spt_str += `  - 총 횟수 : ${spt_len}건\n`;
			
			let desc1 = undefined;
			if(k == "조근") desc1 = document.querySelector('#am-desc-R');
			if(k == "야근") desc1 = document.querySelector('#pm-desc-R');
			if(k == "일근") desc1 = document.querySelector('#mm-desc-R');

			desc1.innerHTML += `<pre> 0 1TV 스팟 송출\n${spt_str}</pre>`;
		}

		// --- 스크롤 ---
		// 해당 시간대의 스크롤 그룹을 필터링, "대표약칭 등 N건(시각)" 형태로 표시
		let scr_str = "";
		for(const [idx, scr] of scroll.entries())
			if(scr[0].head >= t1 && scr[0].head < t2)
				scr_str += `  - ${scr[0].alias} 등 ${scr.length}건(${scr[0].head.toLocaleTimeString("ko-kr", {hour12:false, hour:"2-digit", minute:"2-digit"})})\n`

		// 스크롤이 있으면 우측 특기사항 영역에 추가
		if(scr_str) {
			let desc1 = undefined;
			if(k == "조근") desc1 = document.querySelector('#am-desc-R');
			if(k == "야근") desc1 = document.querySelector('#pm-desc-R');
			if(k == "일근") desc1 = document.querySelector('#mm-desc-R');

			desc1.innerHTML += `<pre> 0 1TV 스크롤 송출\n${scr_str}</pre>`;
		}

		// 디버그: 콘솔에 근무 시간대별 데이터 출력
		console.info(`---------- ${k} ----------`);
		console.table(pgm_ret);
		console.log(spt_str);
		console.log(scr_str);
	}
}

// ============================================================================
// 이벤트 핸들러
// ============================================================================

// 페이지 로드 시 → 오늘 날짜 리포트 자동 빌드
document.addEventListener('DOMContentLoaded', async function(){
	await build_report(new Date());
});

// 날짜 선택기 변경 시 → 해당 날짜 리포트 빌드
document.querySelector('#title-menu-date').addEventListener('change', async function(){
	if(!this.value){
		// 빈 값이면 오늘 날짜로 초기화 (타임존 보정)
		this.valueAsNumber = (date=>date.setMinutes(date.getMinutes() - date.getTimezoneOffset()))(new Date());
		this.dispatchEvent(new Event('change'));
		return false;
	}
	await build_report(this.valueAsDate);
})

// "←" 버튼: 전날로 이동
document.querySelector('#title-menu-yesterday').addEventListener('click', async function(){
	const elem = document.querySelector('#title-menu-date');
	if(!elem.value)
		elem.valueAsNumber = (date=>date.setMinutes(date.getMinutes() - date.getTimezoneOffset()))(new Date());
	elem.stepDown();
	elem.dispatchEvent(new Event('change'));
})

// "→" 버튼: 다음날로 이동
document.querySelector('#title-menu-tomorrow').addEventListener('click', async function(){
	const elem = document.querySelector('#title-menu-date');
	if(!elem.value)
		elem.valueAsNumber = (date=>date.setMinutes(date.getMinutes() - date.getTimezoneOffset()))(new Date());
	elem.stepUp();
	elem.dispatchEvent(new Event('change'));
})

// ============================================================================
// 탭 전환 로직
// ============================================================================
document.querySelectorAll('.tab-bar button').forEach(btn => {
	btn.addEventListener('click', () => {
		// 모든 탭 버튼/콘텐츠 비활성화
		document.querySelectorAll('.tab-bar button').forEach(b => b.classList.remove('active'));
		document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
		// 선택한 탭 활성화
		btn.classList.add('active');
		document.getElementById(btn.dataset.tab).classList.add('active');
	});
});

// ============================================================================
// 엑셀 파일 업로드 & 파싱 로직
// ============================================================================

// 현재 파싱된 워크북 데이터를 전역에 보관
let parsedWorkbook = null;

const uploadArea = document.getElementById('upload-area');
const fileInput = document.getElementById('excel-file');
const fileStatus = document.getElementById('file-status');
const sheetSelector = document.getElementById('sheet-selector');
const sheetSelect = document.getElementById('sheet-select');
const excelPreview = document.getElementById('excel-preview');
const btnErpInput = document.getElementById('btn-erp-input');

// 클릭으로 파일 선택
uploadArea.addEventListener('click', () => fileInput.click());

// 드래그 오버 시 시각적 피드백
uploadArea.addEventListener('dragover', e => {
	e.preventDefault();
	uploadArea.classList.add('dragover');
});
uploadArea.addEventListener('dragleave', () => {
	uploadArea.classList.remove('dragover');
});

// 드롭 시 파일 처리
uploadArea.addEventListener('drop', e => {
	e.preventDefault();
	uploadArea.classList.remove('dragover');
	if (e.dataTransfer.files.length > 0) {
		handleExcelFile(e.dataTransfer.files[0]);
	}
});

// input[type=file] 변경 시
fileInput.addEventListener('change', e => {
	if (e.target.files.length > 0) {
		handleExcelFile(e.target.files[0]);
	}
});

/**
 * 엑셀 파일을 읽어 파싱한다.
 * @param {File} file - 선택된 .xlsx 파일
 */
async function handleExcelFile(file) {
	fileStatus.textContent = `📄 로딩 중: ${file.name} (${(file.size / 1024).toFixed(1)}KB)...`;

	const reader = new FileReader();
	reader.onload = async function(e) {
		try {
			// excel_parser.js의 parseExcelFile() 호출 (async: 한셀 fallback 시 ZIP 직접 파싱)
			parsedWorkbook = await parseExcelFile(e.target.result);

			fileStatus.textContent = `✅ ${file.name} — ${parsedWorkbook.sheetNames.length}개 워크시트 로드 완료`;

			// 워크시트 셀렉터 표시
			populateSheetSelector(parsedWorkbook.sheetNames);

			// 첫 번째 시트 자동 미리보기
			renderExcelPreview(parsedWorkbook.sheetNames[0]);

			// chrome.storage.local에 파싱 결과 저장 (팝업 닫혀도 유지)
			chrome.storage.local.set({
				excelData: {
					fileName: file.name,
					sheetNames: parsedWorkbook.sheetNames,
					sheets: parsedWorkbook.sheets,
					savedAt: Date.now()
				}
			});
		} catch (err) {
			fileStatus.textContent = `❌ 파싱 실패: ${err.message}`;
			console.error(err);
		}
	};
	reader.readAsArrayBuffer(file);
}

/**
 * 워크시트 셀렉터에 옵션을 채운다.
 */
function populateSheetSelector(sheetNames) {
	sheetSelect.innerHTML = '';
	for (const name of sheetNames) {
		const option = document.createElement('option');
		option.value = name;
		option.textContent = name;
		sheetSelect.appendChild(option);
	}
	sheetSelector.style.display = 'block';

	// ◀▶ 네비게이션 버튼 추가 (이미 있으면 건너뜀)
	if (!document.getElementById('btn-sheet-prev')) {
		const btnStyle = 'padding:4px 10px;cursor:pointer;font-size:14px;border:1px solid #ccc;border-radius:3px;background:#f5f5f5';
		const prevBtn = document.createElement('button');
		prevBtn.id = 'btn-sheet-prev';
		prevBtn.textContent = '◀';
		prevBtn.title = '이전 날짜';
		prevBtn.setAttribute('style', btnStyle);
		prevBtn.addEventListener('click', () => navigateSheet(-1));

		const nextBtn = document.createElement('button');
		nextBtn.id = 'btn-sheet-next';
		nextBtn.textContent = '▶';
		nextBtn.title = '다음 날짜';
		nextBtn.setAttribute('style', btnStyle);
		nextBtn.addEventListener('click', () => navigateSheet(1));

		sheetSelect.parentNode.insertBefore(prevBtn, sheetSelect);
		sheetSelect.parentNode.insertBefore(nextBtn, sheetSelect.nextSibling);
	}
}

function navigateSheet(direction) {
	const idx = sheetSelect.selectedIndex + direction;
	if (idx < 0 || idx >= sheetSelect.options.length) return;
	sheetSelect.selectedIndex = idx;
	renderExcelPreview(sheetSelect.value);
}

/**
 * 팝업 열릴 때 chrome.storage.local에서 이전 파싱 데이터 복원
 */
(function restoreSavedExcelData() {
	chrome.storage.local.get('excelData', (result) => {
		if (!result.excelData) return;

		const saved = result.excelData;
		// 24시간 이상 된 데이터는 무시
		if (Date.now() - saved.savedAt > 24 * 60 * 60 * 1000) return;

		parsedWorkbook = {
			sheetNames: saved.sheetNames,
			sheets: saved.sheets
		};

		fileStatus.textContent = `📂 이전 파일 복원: ${saved.fileName}`;
		populateSheetSelector(saved.sheetNames);
		renderExcelPreview(saved.sheetNames[0]);
	});
})();

// 워크시트 선택 변경 시 미리보기 갱신
sheetSelect.addEventListener('change', () => {
	renderExcelPreview(sheetSelect.value);
});

/**
 * 파싱된 워크시트 데이터를 미리보기 테이블로 렌더링한다.
 * @param {string} sheetName - 표시할 워크시트 이름
 */
function renderExcelPreview(sheetName) {
	const parsed = parsedWorkbook.sheets[sheetName];
	if (!parsed || !parsed.shifts || parsed.shifts.length === 0) {
		// 파싱 실패 시 원시 데이터를 표시하여 디버깅 지원
		let html = '<p style="padding:8px;color:#c00;font-weight:bold">⚠️ 근무 섹션(조근/야근)을 찾지 못했습니다. 아래 원시 데이터를 확인하세요.</p>';
		html += '<p style="padding:0 8px;font-size:9pt;color:#666">콘솔(F12)에 상세 로그가 출력됩니다.</p>';
		
		if (parsed && parsed.raw && parsed.raw.length > 0) {
			html += '<table style="font-size:9pt">';
			html += '<tr><th>행</th><th>A</th><th>B</th><th>C</th><th>D</th><th>E</th><th>F</th><th>G</th><th>H</th><th>I</th></tr>';
			for (let r = 0; r < Math.min(parsed.raw.length, 50); r++) {
				const row = parsed.raw[r] || [];
				const hasContent = row.some(c => c !== '');
				if (!hasContent) continue;
				html += `<tr><td style="background:#eee;font-weight:bold">${r+1}</td>`;
				for (let c = 0; c < 9; c++) {
					const val = row[c] !== undefined && row[c] !== '' ? String(row[c]) : '';
					const bg = val.replace(/\s/g, '').match(/조근|야근|일근/) ? 'background:#ffeb3b' : '';
					html += `<td style="${bg}">${val}</td>`;
				}
				html += '</tr>';
			}
			html += '</table>';
		}
		
		excelPreview.innerHTML = html;
		btnErpInput.disabled = true;
		return;
	}

	// 프로그램별 개별 입력을 위한 데이터 배열
	const allProgramData = [];

	let html = `<table>`;
	html += `<tr><th colspan="7" style="font-size:12pt">📅 ${parsed.date.iso || sheetName} ${parsed.date.weekday}</th></tr>`;
	html += `<tr><th>근무유형</th><th>근무자</th><th>구분</th><th>PGM명</th><th>시간</th><th>시간(분)</th><th>ERP</th></tr>`;

	for (const shift of parsed.shifts) {
		// 일근은 프로그램 데이터가 아닌 특기사항만 있으므로 별도 표시
		if (shift.type === '일근') {
			if (shift.notes.length > 0) {
				html += `<tr class="shift-header"><td colspan="7">━━ 일근 특기사항 ━━</td></tr>`;
				html += `<tr><td colspan="7" style="font-size:9pt;color:#555">${shift.notes.join('<br>')}</td></tr>`;
			}
			continue;
		}

		html += `<tr class="shift-header"><td colspan="7">━━ ${shift.type} ━━ (근무자: ${shift.workers.join(', ') || '없음'})</td></tr>`;

		// 프로그램이 없는 경우
		if (shift.programs.length === 0) {
			html += `<tr><td colspan="7" style="color:#999;text-align:center">프로그램 없음</td></tr>`;
		}

		// 프로그램 행 — 뉴스(K003)는 빨간계열, 일반(K001)은 파란계열
		for (const pgm of shift.programs) {
			const pgmUpper = (pgm.pgmName || '').toUpperCase();
			const isNews = pgmUpper.includes('NEWS') || pgmUpper.includes('뉴스');
			const rowBg = isNews ? 'background:#ffebee' : 'background:#e3f2fd';
			const badge = isNews ? '<span style="color:#c62828;font-weight:bold">N</span>' : '<span style="color:#1565c0;font-weight:bold">TV</span>';
			const resogu = isNews ? 'K003' : 'K001';

			// 프로그램 데이터를 배열에 저장 (버튼 클릭 시 참조)
			const pgmIdx = allProgramData.length;
			allProgramData.push({
				date: parsed.date.iso,
				shiftType: shift.type,
				workers: shift.workers,
				zresogu: resogu,
				...pgm
			});

			html += `<tr style="${rowBg}">`;
			html += `<td>${badge} ${shift.type}</td>`;
			html += `<td>${pgm.worker || ''}</td>`;
			html += `<td>${pgm.category}</td>`;
			html += `<td>${pgm.pgmName}</td>`;
			html += `<td>${pgm.start}~${pgm.end}</td>`;
			html += `<td style="text-align:right">${pgm.duration}분</td>`;
			html += `<td><button class="btn-pgm-fill" data-pgm-idx="${pgmIdx}" style="padding:1px 6px;cursor:pointer;background:#43a047;color:#fff;border:none;border-radius:3px;font-size:9pt">입력</button></td>`;
			html += `</tr>`;
		}

		// 스팟/스크롤 요약
		html += `<tr class="summary-row"><td colspan="7">`;
		html += `스팟 ${shift.spotCount}건 | 스크롤 ${shift.scrollCount}건`;
		if (shift.notes.length > 0) {
			html += ` | ${shift.notes.join(', ')}`;
		}
		html += `</td></tr>`;
	}

	html += `</table>`;
	excelPreview.innerHTML = html;

	// 기존 일괄 버튼 숨기기
	btnErpInput.style.display = 'none';

	// 프로그램별 개별 입력 버튼 이벤트 연결
	document.querySelectorAll('.btn-pgm-fill').forEach(btn => {
		btn.addEventListener('click', async () => {
			const idx = parseInt(btn.dataset.pgmIdx);
			const pgmData = allProgramData[idx];

			// 플로팅 창 모드에서는 currentWindow가 popup 자체이므로,
			// 모든 윈도우에서 ERP 탭을 찾아야 한다.
			// 등록 페이지(ins_res_reg_*)를 우선 선택, 없으면 아무 ERP 탭
			const erpTabs = await chrome.tabs.query({ url: '*://erp.kbs.co.kr/*' });
			const tab = erpTabs.find(t => t.url && t.url.includes('ins_res_reg_')) || erpTabs[0];
			if (!tab) {
				alert('ERP 페이지(erp.kbs.co.kr)가 열려 있어야 합니다.');
				return;
			}

			btn.disabled = true;
			btn.textContent = '⏳';

			chrome.tabs.sendMessage(tab.id, {
				function: 'fill_erp_single',
				data: pgmData
			}, (response) => {
				if (chrome.runtime.lastError) {
					alert('확장 프로그램 연결이 끊어졌습니다.\n열려있는 ERP 페이지를 새로고침(F5)한 뒤 다시 시도해주세요.\n\n(상세: ' + chrome.runtime.lastError.message + ')');
					btn.textContent = '입력';
					btn.style.backgroundColor = '#43a047';
					btn.disabled = false;
					return;
				}

				if (response && response.success) {
					btn.textContent = '✅';
					btn.style.backgroundColor = '#388e3c';
				} else {
					btn.textContent = '❌';
					btn.style.backgroundColor = '#d32f2f';
					btn.title = response ? response.message : '응답 없음';
				}
				btn.disabled = false;
			});
		});
	});
}

/**
 * shift별 ERP 입력 실행
 */
async function sendShiftToErp(btn) {
	const sheetName = sheetSelect.value;
	const parsed = parsedWorkbook.sheets[sheetName];
	if (!parsed) return;

	const shiftType = btn.dataset.shift;
	const resogu = btn.dataset.resogu; // 'K001' or 'K003'
	const resoguLabel = resogu === 'K003' ? 'N스튜디오' : 'TV스튜디오';
	const shift = parsed.shifts.find(s => s.type === shiftType);
	if (!shift || shift.programs.length === 0) return;

	// 해당 리소스 구분에 맞는 프로그램만 필터링
	const programs = shift.programs
		.filter(pgm => {
			const pgmUpper = (pgm.pgmName || '').toUpperCase();
			const isNews = pgmUpper.includes('NEWS') || pgmUpper.includes('뉴스');
			return resogu === 'K003' ? isNews : !isNews;
		})
		.map(pgm => ({
			date: parsed.date.iso,
			shiftType: shift.type,
			workers: shift.workers,
			zresogu: resogu,
			...pgm
		}));

	if (programs.length === 0) return;

	const confirmed = confirm(
		`[${shiftType}/${resoguLabel}] ${programs.length}건 실적을 ERP에 입력합니다.\n` +
		`근무자: ${shift.workers.join(', ')}\n\n` +
		`ERP의 리소스구분이 "${resoguLabel}"인지 확인하세요.\n계속하시겠습니까?`
	);
	if (!confirmed) return;

	btn.disabled = true;
	btn.textContent = `⏳ 입력 중...`;

	try {
		// 등록 페이지(ins_res_reg_*)를 우선 선택, 없으면 아무 ERP 탭
		const erpTabs = await chrome.tabs.query({ url: '*://erp.kbs.co.kr/*' });
		const tab = erpTabs.find(t => t.url && t.url.includes('ins_res_reg_')) || erpTabs[0];
		if (!tab) {
			alert('ERP 페이지(erp.kbs.co.kr)가 열려 있어야 합니다.');
			btn.disabled = false;
			btn.textContent = `🚀 ${shiftType} ERP 입력 (${programs.length}건)`;
			return;
		}

		// 건별 입력 모드: 첫 번째 건만 폼에 채움 (눈으로 확인 후 저장)
		const firstProgram = programs[0];
		chrome.tabs.sendMessage(tab.id, {
			function: 'fill_erp_single',
			data: firstProgram
		}, (response) => {
			if (chrome.runtime.lastError) {
				alert('확장 프로그램 연결이 끊어졌습니다.\n열려있는 ERP 페이지를 새로고침(F5)한 뒤 다시 시도해주세요.\n\n(상세: ' + chrome.runtime.lastError.message + ')');
				btn.textContent = `🚀 ${shiftType} ERP 입력 (${programs.length}건)`;
				btn.style.backgroundColor = '';
				btn.disabled = false;
				return;
			}

			if (response && response.success) {
				btn.textContent = `✅ ${shiftType} 폼 입력 완료 (1/${programs.length}건)`;
				btn.style.backgroundColor = '#4CAF50';
			} else if (response) {
				btn.textContent = `❌ ${response.message}`;
				btn.style.backgroundColor = '#f44336';
			} else {
				btn.textContent = `❌ 응답 없음`;
				btn.style.backgroundColor = '#f44336';
			}
			btn.disabled = false;
		});
	} catch (err) {
		btn.textContent = `❌ ${err.message}`;
		btn.disabled = false;
	}
}