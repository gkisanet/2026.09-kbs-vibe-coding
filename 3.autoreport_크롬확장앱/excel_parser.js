// ============================================================================
// excel_parser.js — 업무실적일지 엑셀 파서
// ============================================================================
// SheetJS(xlsx) 라이브러리를 사용하여 업무실적일지 .xlsx 파일을 파싱한다.
// 날짜별 워크시트에서 조근/야근/일근 섹션의 근무자, 프로그램, 시간 데이터를 추출.
//
// 시트 이름 형식: "20260227(금)" (YYYYMMDD + 요일)
//
// ⚠️ sheet_to_json은 병합 셀이 많은 시트에서 빈 배열을 반환하므로,
//    sheet['A1'] 형식의 직접 셀 참조 방식을 사용한다.
// ============================================================================

/**
 * 엑셀 파일을 ArrayBuffer로 읽어 파싱한다.
 * 한셀(Hancel) 등 비표준 xlsx 파일인 경우 ZIP 직접 파싱 fallback을 사용한다.
 */
async function parseExcelFile(buffer) {
	const bytes = new Uint8Array(buffer);

	// 파일 형식 진단 (매직 바이트)
	const magic = Array.from(bytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ');
	const isZip = (bytes[0] === 0x50 && bytes[1] === 0x4B);      // PK.. = .xlsx/.xlsb
	const isOLE = (bytes[0] === 0xD0 && bytes[1] === 0xCF);      // ÐÏ.. = .xls (BIFF)
	const formatInfo = isZip ? 'ZIP (xlsx/xlsb/xlsm)' : isOLE ? 'OLE2 (xls BIFF)' : `알 수 없음 (${magic})`;
	
	console.log(`[AutoReport] 파일 형식: ${formatInfo}, 크기: ${bytes.length} bytes`);

	// ========================================================================
	// 여러 읽기 전략 시도
	// ========================================================================
	// Why: 한셀(한글과컴퓨터 Hancel)로 저장된 .xlsx 파일은
	//   1) 비표준 XML 네임스페이스 사용
	//   2) Content_Types.xml에 비표준 ContentType 기재
	//   3) 시트 관계(rels)가 표준과 다른 경로 구조
	// 등의 이유로 SheetJS가 시트 데이터를 읽지 못할 수 있다.
	// 따라서 관대한 옵션(WTF 무시, cellStyles 비활성, bookSheets 등)으로
	// 여러 번 시도하고, 그래도 실패하면 ZIP 내부를 직접 탐색한다.
	// ========================================================================
	const strategies = [
		// 1단계: 기본 옵션
		{ desc: 'array',                opts: { type: 'array' } },
		{ desc: 'array+dense',          opts: { type: 'array', dense: true } },
		// 2단계: 관대한 옵션 (한셀 대응)
		//   - cellStyles: false → 비표준 스타일 XML 파싱 건너뛰기
		//   - cellFormula: false → 비표준 수식 무시
		//   - WTF: false → 알 수 없는 레코드 무시
		//   - codepage: 949 → 한글 코드페이지 (한셀이 EUC-KR 기반일 수 있음)
		{ desc: 'array+lenient',        opts: { type: 'array', cellStyles: false, cellFormula: false, WTF: false } },
		{ desc: 'array+cp949',          opts: { type: 'array', cellStyles: false, cellFormula: false, WTF: false, codepage: 949 } },
		// 3단계: binary 모드 (다른 바이트 해석 경로)
		{ desc: 'binary',               opts: { type: 'binary' } },
		{ desc: 'binary+lenient',       opts: { type: 'binary', cellStyles: false, cellFormula: false, WTF: false } },
	];

	let workbook = null;
	let sheetKeys = [];

	for (const { desc, opts } of strategies) {
		try {
			let input = buffer;
			if (opts.type === 'binary') {
				// ArrayBuffer → binary string 변환
				input = '';
				for (let i = 0; i < bytes.length; i++) {
					input += String.fromCharCode(bytes[i]);
				}
			}

			const wb = XLSX.read(input, opts);
			const keys = Object.keys(wb.Sheets || {});
			console.log(`[AutoReport] 전략 "${desc}": SheetNames=${wb.SheetNames.length}, Sheets키=${keys.length}`);

			if (keys.length > 0) {
				// 시트 데이터가 실제로 존재하는지 2차 검증
				// (한셀 파일에서 키는 있지만 셀 데이터가 모두 빈 경우 대비)
				const hasData = keys.some(k => {
					const s = wb.Sheets[k];
					if (!s) return false;
					return s['!ref'] || Object.keys(s).some(ck => ck[0] !== '!');
				});

				if (hasData) {
					workbook = wb;
					sheetKeys = keys;
					console.log(`[AutoReport] 전략 "${desc}" 성공! (데이터 확인됨)`);
					break;
				} else {
					console.warn(`[AutoReport] 전략 "${desc}": 키는 있지만 셀 데이터 없음, 다음 전략 시도`);
				}
			}

			// SheetNames만 있고 Sheets가 비어있으면 다음 전략 시도
			if (!workbook) workbook = wb;
		} catch (e) {
			console.warn(`[AutoReport] 전략 "${desc}" 실패:`, e.message);
		}
	}

	// ========================================================================
	// ZIP 직접 탐색 Fallback (한셀 비표준 구조 대응)
	// ========================================================================
	// Why: 한셀은 xl/worksheets/ 경로나 [Content_Types].xml 내의 
	//      ContentType 값이 MS 표준과 달라서 SheetJS가 워크시트를 
	//      매핑하지 못할 수 있다. 이 경우 ZIP을 직접 열어서
	//      워크시트 XML 파일을 수동으로 찾아 SheetJS에 주입한다.
	// ========================================================================
	if (isZip && workbook && sheetKeys.length === 0 && workbook.SheetNames.length > 0) {
		console.log('[AutoReport] 시트 데이터 없음 → ZIP 직접 탐색 fallback 시작');
		try {
			workbook = await repairHancelWorkbook(buffer, workbook);
			sheetKeys = Object.keys(workbook.Sheets || {});
			if (sheetKeys.length > 0) {
				console.log(`[AutoReport] ZIP fallback 성공! Sheets키=${sheetKeys.length}`);
			}
		} catch (e) {
			console.warn('[AutoReport] ZIP fallback 실패:', e.message);
		}
	}

	if (!workbook) {
		throw new Error('엑셀 파일을 읽을 수 없습니다.');
	}

	// 여전히 Sheets가 비어있으면 진단 정보 표시
	if (sheetKeys.length === 0 && workbook.SheetNames.length > 0) {
		alert(
			`⚠️ 시트 데이터를 읽을 수 없습니다.\n\n` +
			`파일 형식: ${formatInfo}\n` +
			`시트 이름 ${workbook.SheetNames.length}개는 발견됨\n\n` +
			`이 파일은 한셀(한글과컴퓨터) 등 비표준 프로그램으로\n` +
			`저장된 것으로 보입니다.\n\n` +
			`해결 방법:\n` +
			`1. Microsoft Excel에서 파일 열기\n` +
			`2. 다른 이름으로 저장\n` +
			`   → "Excel 통합 문서(*.xlsx)"로 저장\n` +
			`3. 새로 저장된 파일을 업로드\n\n` +
			`또는 한셀에서 "다른 이름으로 저장" →\n` +
			`"Microsoft Excel 문서(*.xlsx)" 형식으로 저장 후 업로드`
		);
	}

	return {
		sheetNames: workbook.SheetNames,
		sheets: workbook.SheetNames.reduce((acc, name) => {
			// 키 매칭: 정확 → trim → 유사 검색
			let sheet = workbook.Sheets[name];
			if (!sheet) sheet = workbook.Sheets[name.trim()];
			if (!sheet) {
				const matchKey = sheetKeys.find(k =>
					k.trim() === name.trim() || k.replace(/\s/g, '') === name.replace(/\s/g, '')
				);
				if (matchKey) sheet = workbook.Sheets[matchKey];
			}

			if (sheet) {
				acc[name] = parseWorksheet(sheet, name);
			} else {
				acc[name] = { date: extractDateFromSheetName(name), shifts: [], raw: [] };
			}
			return acc;
		}, {})
	};
}

/**
 * 한셀 비표준 xlsx 파일의 ZIP 내부를 직접 파싱하여 워크시트를 복구한다.
 * 
 * [비유] 도서관의 카탈로그(SheetNames)는 있는데 사서(SheetJS)가 책(Sheets)을
 * 찾지 못할 때, 직접 서고(ZIP)에 들어가 책(worksheet XML)을 꺼내오는 것과 같다.
 *
 * [Why 이 방식을 선택했는가]
 * SheetJS는 [Content_Types].xml의 ContentType 값으로 워크시트를 식별하는데,
 * 한셀은 이 값이 MS 표준과 달라서 SheetJS가 워크시트를 무시한다.
 * SheetJS 옵션을 아무리 바꿔도 이 content-type 필터링은 우회할 수 없다.
 * → 따라서 ZIP을 직접 열어서 워크시트 XML을 수동으로 추출·파싱한다.
 *
 * [원리] 3단계 복구 프로세스:
 * 1. ZIP 중앙 디렉터리 파싱 → 파일 목록 획득 (압축 해제 불필요)
 * 2. workbook.xml + workbook.xml.rels → 시트이름 ↔ 파일경로 매핑
 * 3. 각 워크시트 XML 추출 → 수동 셀 파싱 → workbook.Sheets에 주입
 *
 * @param {ArrayBuffer} buffer - 원본 파일 버퍼
 * @param {Object} workbook - SheetNames만 있는 불완전한 워크북
 * @returns {Promise<Object>} 복구된 워크북
 */
async function repairHancelWorkbook(buffer, workbook) {
	try {
		// ================================================================
		// Step 1: ZIP 중앙 디렉터리 파싱 → 모든 파일 경로 목록 획득
		// ================================================================
		const entries = parseZipCentralDirectory(buffer);
		console.log('[AutoReport] ZIP 파일 목록:', 
			entries.map(e => `${e.filename} (${e.compressedSize}→${e.uncompressedSize}bytes)`));

		// ================================================================
		// Step 2: workbook.xml에서 시트이름 ↔ rId 매핑 추출
		// ================================================================
		const wbEntry = entries.find(e => /^xl\/workbook\.xml$/i.test(e.filename));
		let sheetRidMap = {}; // { "20260407(화)": "rId1", ... }
		if (wbEntry) {
			const wbXml = await readZipEntryAsText(buffer, wbEntry);
			// <sheet name="20260407(화)" sheetId="1" r:id="rId1"/>
			// 속성 순서가 다를 수 있으므로 두 가지 패턴 시도
			const regex1 = /name="([^"]+)"[^>]*(?:r:id|relationships:id)="([^"]+)"/gi;
			const regex2 = /(?:r:id|relationships:id)="([^"]+)"[^>]*name="([^"]+)"/gi;
			let m;
			while ((m = regex1.exec(wbXml)) !== null) sheetRidMap[m[1]] = m[2];
			if (Object.keys(sheetRidMap).length === 0) {
				while ((m = regex2.exec(wbXml)) !== null) sheetRidMap[m[2]] = m[1];
			}
			console.log('[AutoReport] 시트이름→rId 매핑:', sheetRidMap);
		}

		// ================================================================
		// Step 3: workbook.xml.rels에서 rId → 파일경로 매핑 추출
		// ================================================================
		const relsEntry = entries.find(e => /^xl\/_rels\/workbook.*\.rels$/i.test(e.filename));
		let ridPathMap = {}; // { "rId1": "xl/worksheets/sheet1.xml", ... }
		if (relsEntry) {
			const relsXml = await readZipEntryAsText(buffer, relsEntry);
			console.log('[AutoReport] workbook.xml.rels 내용:', relsXml.substring(0, 500));
			// <Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="..."/>
			const relRegex = /<Relationship[^>]+>/gi;
			let rm;
			while ((rm = relRegex.exec(relsXml)) !== null) {
				const tag = rm[0];
				const id = (tag.match(/Id="([^"]+)"/i) || [])[1];
				const target = (tag.match(/Target="([^"]+)"/i) || [])[1];
				if (id && target) {
					// 상대경로 → 절대경로 변환 ("worksheets/sheet1.xml" → "xl/worksheets/sheet1.xml")
					ridPathMap[id] = target.startsWith('/') ? target.substring(1) : 'xl/' + target;
				}
			}
			console.log('[AutoReport] rId→파일경로 매핑:', ridPathMap);
		}

		// ================================================================
		// Step 4: 시트이름 → ZIP 파일경로 최종 매핑
		// ================================================================
		let sheetFileMap = {}; // { "20260407(화)": "xl/worksheets/sheet1.xml", ... }
		
		// 방법 A: workbook.xml + rels를 통한 정확한 매핑
		for (const [name, rid] of Object.entries(sheetRidMap)) {
			if (ridPathMap[rid]) {
				sheetFileMap[name] = ridPathMap[rid];
			}
		}

		// 방법 B: 매핑 실패 시 → 파일명 순서로 SheetNames에 대응
		if (Object.keys(sheetFileMap).length === 0) {
			console.log('[AutoReport] rels 매핑 없음 → 파일명 순서로 매핑 시도');
			const wsEntries = entries
				.filter(e => /worksheets\/sheet\d+\.xml/i.test(e.filename))
				.sort((a, b) => {
					const numA = parseInt(a.filename.match(/sheet(\d+)/i)?.[1] || '0');
					const numB = parseInt(b.filename.match(/sheet(\d+)/i)?.[1] || '0');
					return numA - numB;
				});
			for (let i = 0; i < wsEntries.length && i < workbook.SheetNames.length; i++) {
				sheetFileMap[workbook.SheetNames[i]] = wsEntries[i].filename;
			}
		}

		// 방법 C: 그래도 없으면 → sheet*.xml 패턴으로 광범위 탐색
		if (Object.keys(sheetFileMap).length === 0) {
			console.log('[AutoReport] 기본 경로에도 없음 → 광범위 탐색');
			const wsEntries = entries
				.filter(e => /sheet.*\.xml$/i.test(e.filename) && !/workbook/i.test(e.filename))
				.sort((a, b) => a.filename.localeCompare(b.filename));
			for (let i = 0; i < wsEntries.length && i < workbook.SheetNames.length; i++) {
				sheetFileMap[workbook.SheetNames[i]] = wsEntries[i].filename;
			}
		}

		console.log('[AutoReport] 최종 시트→파일 매핑:', sheetFileMap);

		if (Object.keys(sheetFileMap).length === 0) {
			console.warn('[AutoReport] ZIP 내에서 워크시트 파일을 찾을 수 없음');
			return workbook;
		}

		// ================================================================
		// Step 5: 공유 문자열(Shared Strings) 로드
		// ================================================================
		// Why: xlsx에서 문자열은 sharedStrings.xml에 모아두고,
		//      각 셀은 인덱스로 참조한다. (중복 제거로 파일 크기 절약)
		let sharedStrings = [];
		const sstEntry = entries.find(e => /xl\/sharedstrings\.xml$/i.test(e.filename));
		if (sstEntry) {
			const sstXml = await readZipEntryAsText(buffer, sstEntry);
			console.log(`[AutoReport] sharedStrings.xml 샘플 (처음 300자):`, sstXml.substring(0, 300));
			sharedStrings = parseSharedStringsXml(sstXml);
			console.log(`[AutoReport] 공유 문자열 ${sharedStrings.length}개 로드`);
		} else {
			console.log('[AutoReport] sharedStrings.xml 없음 — 한셀은 인라인 문자열을 사용할 수 있음');
		}

		// ================================================================
		// Step 6: 각 워크시트 XML 추출 → 셀 데이터 파싱 → Sheets에 주입
		// ================================================================
		workbook.Sheets = {};
		for (const sheetName of workbook.SheetNames) {
			const filePath = sheetFileMap[sheetName];
			if (!filePath) {
				console.warn(`[AutoReport] 시트 "${sheetName}"에 대한 파일 없음, 건너뜀`);
				continue;
			}

			const entry = entries.find(e => e.filename === filePath);
			if (!entry) {
				console.warn(`[AutoReport] ZIP에서 "${filePath}" 파일 못 찾음`);
				continue;
			}

			try {
				const wsXml = await readZipEntryAsText(buffer, entry);
				// 첫 번째 시트만 XML 샘플을 출력하여 한셀의 XML 구조를 진단
				if (sheetName === workbook.SheetNames[0]) {
					console.log(`[AutoReport] 워크시트 XML 샘플 ("${sheetName}", 처음 500자):`, wsXml.substring(0, 500));
					console.log(`[AutoReport] 워크시트 XML 길이: ${wsXml.length}자`);
				}
				const sheet = parseWorksheetXml(wsXml, sharedStrings);
				workbook.Sheets[sheetName] = sheet;
				console.log(`[AutoReport] ✅ 시트 "${sheetName}" 복구 완료 (ref=${sheet['!ref'] || 'empty'}, 셀=${Object.keys(sheet).filter(k=>k[0]!=='!').length}개)`);
			} catch (e) {
				console.warn(`[AutoReport] ❌ 시트 "${sheetName}" 파싱 실패:`, e.message);
			}
		}

		return workbook;
	} catch (e) {
		console.error('[AutoReport] ZIP 수동 파싱 전체 실패:', e);
		return workbook;
	}
}

// ============================================================================
// ZIP 파일 유틸리티 (브라우저 환경용)
// ============================================================================
// Why 별도 ZIP 파서를 작성하는가:
// SheetJS는 자체 ZIP 파서를 내장하지만 외부에 노출하지 않는다.
// 한셀 파일은 SheetJS의 content-type 기반 필터링을 통과하지 못하므로,
// ZIP 구조를 직접 읽어서 파일을 추출해야 한다.
//
// ZIP 파일 구조 요약:
// ┌─────────────────────────────┐
// │ Local File Header 1         │ ← 각 파일의 헤더 + 압축 데이터
// │ [파일 데이터 1]              │
// │ Local File Header 2         │
// │ [파일 데이터 2]              │
// │ ...                         │
// ├─────────────────────────────┤
// │ Central Directory Entry 1   │ ← 파일 목록 (파일명, 크기, 위치)
// │ Central Directory Entry 2   │
// │ ...                         │
// ├─────────────────────────────┤
// │ End of Central Directory    │ ← CD 위치/크기 정보
// └─────────────────────────────┘
// ============================================================================

/**
 * ZIP 중앙 디렉터리를 파싱하여 파일 목록을 반환한다.
 * (압축 해제 없이 파일명/크기/위치만 읽으므로 매우 빠르다)
 */
function parseZipCentralDirectory(buffer) {
	const view = new DataView(buffer);
	const bytes = new Uint8Array(buffer);
	const decoder = new TextDecoder('utf-8');

	// 1단계: End of Central Directory Record (EOCD) 찾기
	// EOCD 시그니처 = 0x06054b50, 파일 끝에서부터 역방향 탐색
	let eocdOffset = -1;
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65535); i--) {
		if (view.getUint32(i, true) === 0x06054b50) {
			eocdOffset = i;
			break;
		}
	}
	if (eocdOffset === -1) throw new Error('ZIP EOCD 시그니처를 찾을 수 없음');

	// EOCD에서 중앙 디렉터리(CD)의 위치와 엔트리 수 읽기
	const cdEntryCount = view.getUint16(eocdOffset + 10, true);
	const cdOffset = view.getUint32(eocdOffset + 16, true);

	// 2단계: 각 Central Directory Entry 파싱
	const entries = [];
	let offset = cdOffset;

	for (let i = 0; i < cdEntryCount; i++) {
		if (view.getUint32(offset, true) !== 0x02014b50) break; // CD 시그니처 확인

		const flags = view.getUint16(offset + 8, true);
		const compression = view.getUint16(offset + 10, true);
		const compressedSize = view.getUint32(offset + 20, true);
		const uncompressedSize = view.getUint32(offset + 24, true);
		const filenameLength = view.getUint16(offset + 28, true);
		const extraLength = view.getUint16(offset + 30, true);
		const commentLength = view.getUint16(offset + 32, true);
		const localHeaderOffset = view.getUint32(offset + 42, true);

		// bit 11 = UTF-8 인코딩 플래그
		const isUtf8 = (flags & 0x800) !== 0;
		const filenameBytes = bytes.slice(offset + 46, offset + 46 + filenameLength);
		const filename = isUtf8
			? decoder.decode(filenameBytes)
			: decoder.decode(filenameBytes); // 대부분 ASCII이므로 UTF-8로도 동작

		entries.push({
			filename,
			compression,   // 0=Stored(무압축), 8=Deflate
			compressedSize,
			uncompressedSize,
			localHeaderOffset
		});

		offset += 46 + filenameLength + extraLength + commentLength;
	}

	return entries;
}

/**
 * ZIP 엔트리의 실제 파일 데이터를 읽고 압축을 해제한다.
 * Deflate 압축 해제에 브라우저 내장 DecompressionStream API를 사용한다.
 * (Chrome 80+, Edge 80+ 지원)
 */
async function readZipEntry(buffer, entry) {
	const view = new DataView(buffer);
	const bytes = new Uint8Array(buffer);
	const offset = entry.localHeaderOffset;

	// Local File Header에서 실제 데이터 시작 위치 계산
	// Local File Header: 30바이트 고정 + 파일명 길이 + 추가 필드 길이
	const localFilenameLen = view.getUint16(offset + 26, true);
	const localExtraLen = view.getUint16(offset + 28, true);
	const dataOffset = offset + 30 + localFilenameLen + localExtraLen;

	const compressedData = bytes.slice(dataOffset, dataOffset + entry.compressedSize);

	if (entry.compression === 0) {
		// Stored (무압축) → 그대로 반환
		return compressedData;
	} else if (entry.compression === 8) {
		// Deflate → DecompressionStream으로 해제
		const blob = new Blob([compressedData]);
		const ds = new DecompressionStream('deflate-raw');
		const decompressedStream = blob.stream().pipeThrough(ds);
		const result = await new Response(decompressedStream).arrayBuffer();
		return new Uint8Array(result);
	}

	throw new Error(`지원하지 않는 압축 방식: ${entry.compression}`);
}

/**
 * ZIP 엔트리를 텍스트(UTF-8)로 읽는다.
 */
async function readZipEntryAsText(buffer, entry) {
	const data = await readZipEntry(buffer, entry);
	return new TextDecoder('utf-8').decode(data);
}

// ============================================================================
// 워크시트 XML 수동 파서
// ============================================================================
// Why 수동 파서를 작성하는가:
// SheetJS를 우회하여 ZIP에서 직접 추출한 XML을 파싱해야 한다.
// DOMParser를 쓸 수도 있지만, 정규식 기반이 더 가볍고
// 네임스페이스 문제에 강건하다(한셀의 비표준 네임스페이스 대응).
// ============================================================================

/**
 * 워크시트 XML을 파싱하여 SheetJS 호환 시트 객체를 생성한다.
 * 
 * 워크시트 XML 구조:
 * <worksheet>
 *   <sheetData>
 *     <row r="1">
 *       <c r="A1" t="s"><v>0</v></c>      ← t="s": 공유문자열 인덱스
 *       <c r="B1"><v>42</v></c>            ← 숫자 (t 속성 없음)
 *       <c r="C1" t="inlineStr"><is><t>텍스트</t></is></c> ← 인라인 문자열
 *     </row>
 *   </sheetData>
 *   <mergeCells>
 *     <mergeCell ref="A1:B2"/>
 *   </mergeCells>
 * </worksheet>
 */
function parseWorksheetXml(xml, sharedStrings) {
	const sheet = {};
	const merges = [];

	// ==================================================================
	// 네임스페이스 접두사 대응 (NS = Namespace prefix)
	// ==================================================================
	// Why: 한셀은 MS Excel과 다른 네임스페이스 접두사를 사용할 수 있다.
	// 예: <x:row>, <x:c>, <x:v> 또는 <ss:Row>, <ss:Cell> 등
	//     대부분의 xlsx는 접두사 없이 <row>, <c>, <v>를 사용하지만,
	//     한셀은 <hcell:row> 같은 자체 접두사를 쓸 수 있다.
	// (?:\w+:)? = 선택적 네임스페이스 접두사 (예: "x:", "hcell:")
	// ==================================================================
	const NS = '(?:\\w+:)?';  // 정규식에서 재사용할 NS 접두사 패턴

	// 1단계: <sheetData> 내의 행(row)과 셀(c) 파싱
	// 행 단위로 추출 후 각 행 내의 셀을 파싱
	const rowRegex = new RegExp(`<${NS}row\\b[^>]*>([\\s\\S]*?)<\\/${NS}row>`, 'gi');
	let rowMatch;

	while ((rowMatch = rowRegex.exec(xml)) !== null) {
		const rowContent = rowMatch[0];

		// 개별 셀 추출: <c r="A1" t="s"><v>0</v></c> 또는 <c r="A1"/>
		const cellRegex = new RegExp(`<${NS}c\\s+([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${NS}c>)`, 'gi');
		let cellMatch;

		while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
			const attrs = cellMatch[1];
			const content = cellMatch[2] || '';

			// 셀 주소 (예: "A1", "B2")
			const refMatch = attrs.match(/r="([^"]+)"/i);
			if (!refMatch) continue;
			const ref = refMatch[1];

			// 셀 타입: s=공유문자열, b=부울, e=에러, str/inlineStr=인라인문자열
			const typeMatch = attrs.match(/\bt="([^"]+)"/i);
			const cellType = typeMatch ? typeMatch[1] : '';

			// 값 추출: <v>...</v> 또는 <is><t>...</t></is>
			// 네임스페이스 접두사 대응: <x:v>, <x:is>, <x:t> 등
			const vRegex = new RegExp(`<${NS}v[^>]*>([\\s\\S]*?)<\\/${NS}v>`, 'i');
			const isRegex = new RegExp(`<${NS}is[^>]*>[\\s\\S]*?<${NS}t[^>]*>([\\s\\S]*?)<\\/${NS}t>`, 'i');
			const valueMatch = content.match(vRegex);
			const inlineMatch = content.match(isRegex);

			const cell = {};

			if (cellType === 's' && valueMatch) {
				// 공유 문자열 → 인덱스로 실제 문자열 참조
				const idx = parseInt(valueMatch[1]);
				cell.t = 's';
				cell.v = (idx >= 0 && idx < sharedStrings.length) ? sharedStrings[idx] : '';
			} else if (cellType === 'inlineStr' || cellType === 'str') {
				// 인라인 문자열
				cell.t = 's';
				cell.v = inlineMatch ? decodeXmlEntities(inlineMatch[1]) : (valueMatch ? decodeXmlEntities(valueMatch[1]) : '');
			} else if (cellType === 'b') {
				// 부울
				cell.t = 'b';
				cell.v = valueMatch ? valueMatch[1] === '1' : false;
			} else if (cellType === 'e') {
				// 에러
				cell.t = 'e';
				cell.v = valueMatch ? valueMatch[1] : '#VALUE!';
			} else if (valueMatch) {
				// 숫자 (기본)
				const num = parseFloat(valueMatch[1]);
				if (!isNaN(num)) {
					cell.t = 'n';
					cell.v = num;
				} else {
					cell.t = 's';
					cell.v = decodeXmlEntities(valueMatch[1]);
				}
			} else if (inlineMatch) {
				// <v> 없이 <is><t>만 있는 경우
				cell.t = 's';
				cell.v = decodeXmlEntities(inlineMatch[1]);
			} else {
				continue; // 값이 없는 셀은 건너뜀
			}

			sheet[ref] = cell;
		}
	}

	// 2단계: 시트 범위(!ref) 계산
	const cellKeys = Object.keys(sheet).filter(k => k[0] !== '!');
	if (cellKeys.length > 0) {
		let minR = Infinity, maxR = 0, minC = Infinity, maxC = 0;
		for (const key of cellKeys) {
			const parsed = XLSX.utils.decode_cell(key);
			minR = Math.min(minR, parsed.r);
			maxR = Math.max(maxR, parsed.r);
			minC = Math.min(minC, parsed.c);
			maxC = Math.max(maxC, parsed.c);
		}
		sheet['!ref'] = XLSX.utils.encode_range({ s: { r: minR, c: minC }, e: { r: maxR, c: maxC } });
	}

	// 3단계: 병합 셀 정보 파싱 (네임스페이스 대응)
	const mergeCellRegex = new RegExp(`<${NS}mergeCell\\s+ref="([^"]+)"\\s*\\/?>`, 'gi');
	let mergeMatch;
	while ((mergeMatch = mergeCellRegex.exec(xml)) !== null) {
		merges.push(XLSX.utils.decode_range(mergeMatch[1]));
	}
	if (merges.length > 0) sheet['!merges'] = merges;

	return sheet;
}

/**
 * sharedStrings.xml을 파싱하여 문자열 배열을 반환한다.
 * 
 * 구조: <sst><si><t>문자열1</t></si><si><r><t>서식</t></r><r><t>문자</t></r></si></sst>
 * - <si> = 하나의 문자열 항목
 * - <t>  = 텍스트 (단순 문자열)
 * - <r>  = Rich Text Run (서식이 다른 부분들 → 텍스트만 이어붙임)
 */
function parseSharedStringsXml(xml) {
	const strings = [];
	// 네임스페이스 접두사 대응: <x:si>, <x:t> 등
	const NS = '(?:\\w+:)?';
	const siRegex = new RegExp(`<${NS}si\\b[^>]*>([\\s\\S]*?)<\\/${NS}si>`, 'gi');
	let siMatch;

	while ((siMatch = siRegex.exec(xml)) !== null) {
		const content = siMatch[1];
		let fullText = '';

		// <t> 태그에서 텍스트 추출 (여러 개의 <r><t>...</t></r>이 있을 수 있음)
		const tRegex = new RegExp(`<${NS}t[^>]*>([\\s\\S]*?)<\\/${NS}t>`, 'gi');
		let tMatch;
		while ((tMatch = tRegex.exec(content)) !== null) {
			fullText += tMatch[1];
		}

		strings.push(decodeXmlEntities(fullText));
	}

	return strings;
}

/**
 * XML 엔티티(&amp; 등)를 원래 문자로 디코딩한다.
 */
function decodeXmlEntities(text) {
	return text
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

/**
 * 시트에서 특정 셀의 값을 읽는다.
 * @param {Object} sheet - XLSX 시트 객체
 * @param {number} row - 행 번호 (1-indexed, 엑셀과 동일)
 * @param {number} col - 열 번호 (0-indexed, 0=A, 1=B, ...)
 * @returns {string|number} 셀 값 (없으면 빈 문자열)
 */
function cellVal(sheet, row, col) {
	const addr = XLSX.utils.encode_cell({ r: row - 1, c: col }); // row는 0-indexed로 변환
	const cell = sheet[addr];
	if (!cell) return '';
	// v = 원시값, w = 포맷된 문자열
	return cell.v !== undefined ? cell.v : (cell.w || '');
}

/**
 * 시트의 사용 범위 내의 모든 셀을 2D 배열로 변환한다.
 * sheet_to_json 대신 직접 셀을 읽는다.
 */
function sheetToArray(sheet) {
	if (!sheet || !sheet['!ref']) return [];

	const range = XLSX.utils.decode_range(sheet['!ref']);
	const data = [];

	for (let r = range.s.r; r <= range.e.r; r++) {
		const row = [];
		for (let c = range.s.c; c <= range.e.c; c++) {
			const addr = XLSX.utils.encode_cell({ r, c });
			const cell = sheet[addr];
			row.push(cell ? (cell.v !== undefined ? cell.v : (cell.w || '')) : '');
		}
		data.push(row);
	}

	return data;
}

/**
 * 단일 워크시트를 파싱하여 구조화된 일지 데이터로 변환한다.
 */
function parseWorksheet(sheet, sheetName) {
	// 직접 셀 참조로 2D 배열 생성 (병합 셀 문제 우회)
	const data = sheetToArray(sheet);

	console.log(`[AutoReport] 시트 "${sheetName}" 파싱: ${data.length}행, ref=${sheet['!ref'] || 'none'}`);

	if (!data || data.length === 0) {
		return { date: extractDateFromSheetName(sheetName), shifts: [], raw: data };
	}

	// [디버그] 첫 50행 내용 콘솔 출력
	for (let r = 0; r < Math.min(data.length, 50); r++) {
		const row = data[r] || [];
		const cells = row.slice(0, 10).map((c, i) =>
			`${String.fromCharCode(65 + i)}=${JSON.stringify(c)}`
		).join(' | ');
		const hasContent = row.some(c => c !== '' && c !== undefined);
		if (hasContent) {
			console.log(`  행${r + 1}: ${cells}`);
		}
	}

	// 날짜: 시트 이름에서 추출 + 시트 내부 데이터에서도 시도
	const dateInfo = extractDateFromSheetName(sheetName) || extractDateFromData(data);
	console.log(`[AutoReport] 날짜: ${JSON.stringify(dateInfo)}`);

	// 근무 섹션 탐색 및 파싱
	const shiftPositions = findShiftPositions(data);
	console.log(`[AutoReport] 근무 섹션 ${shiftPositions.length}개:`, shiftPositions);

	const shifts = [];
	for (const pos of shiftPositions) {
		const shift = parseShiftSection(data, pos, shiftPositions);
		if (shift) shifts.push(shift);
	}

	return {
		date: dateInfo,
		sheetName: sheetName,
		shifts: shifts,
		raw: data
	};
}

// ============================================================================
// 날짜 추출
// ============================================================================

/**
 * 시트 이름에서 날짜 추출
 * 형식: "20260227(금)" → { iso: "2026-02-27", weekday: "금요일" }
 */
function extractDateFromSheetName(name) {
	const match = String(name).match(/(\d{4})(\d{2})(\d{2})\(?(월|화|수|목|금|토|일)?\)?/);
	if (match) {
		return {
			iso: `${match[1]}-${match[2]}-${match[3]}`,
			year: parseInt(match[1]),
			month: parseInt(match[2]),
			day: parseInt(match[3]),
			weekday: match[4] ? match[4] + '요일' : ''
		};
	}
	// 시트 이름 자체를 iso로 사용
	return { iso: name, year: 0, month: 0, day: 0, weekday: '' };
}

/**
 * 데이터 행에서 날짜 추출 (폴백)
 */
function extractDateFromData(data) {
	for (let row = 0; row < Math.min(data.length, 10); row++) {
		if (!data[row]) continue;
		const rowStr = data[row].map(c => String(c || '')).join(' ');
		const match = rowStr.match(/(\d{4})\s*년?\s*(\d{1,2})\s*월?\s*(\d{1,2})\s*일/);
		if (match) {
			const [, year, month, day] = match;
			const wd = rowStr.match(/(월|화|수|목|금|토|일)요일/);
			return {
				iso: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
				year: parseInt(year), month: parseInt(month), day: parseInt(day),
				weekday: wd ? wd[0] : ''
			};
		}
	}
	return { iso: '', year: 0, month: 0, day: 0, weekday: '' };
}

// ============================================================================
// 근무 섹션 위치 탐색
// ============================================================================
function findShiftPositions(data) {
	const positions = [];
	const shiftNames = ['조근', '야근', '일근'];

	for (let row = 0; row < data.length; row++) {
		if (!data[row]) continue;
		for (let col = 0; col < Math.min(data[row].length, 5); col++) {
			const raw = String(data[row][col] || '');
			const cell = raw.replace(/\s/g, '');

			if (!cell) continue;

			// 정확 매칭
			if (shiftNames.includes(cell)) {
				positions.push({ type: cell, row, col });
				break;
			}

			// 부분 매칭
			for (const name of shiftNames) {
				if (cell.includes(name)) {
					positions.push({ type: name, row, col });
					break;
				}
			}
		}
	}

	// 중복 제거
	const unique = [];
	const seen = new Set();
	for (const pos of positions) {
		const key = `${pos.type}-${pos.row}`;
		if (!seen.has(key)) {
			seen.add(key);
			unique.push(pos);
		}
	}
	return unique;
}

// ============================================================================
// 근무 섹션 파싱
// ============================================================================
function parseShiftSection(data, pos, allPositions) {
	const result = {
		type: pos.type,
		workers: [],
		programs: [],
		spotCount: 0,
		scrollCount: 0,
		notes: []
	};

	if (pos.type === '일근') {
		return parseIlgeunSection(data, pos);
	}

	// 데이터 시작 행을 동적으로 찾기
	let dataStartRow = pos.row + 1;
	console.log(`[AutoReport] ${pos.type} 헤더 위치: row=${pos.row}, col=${pos.col}`);
	for (let r = pos.row + 1; r < Math.min(pos.row + 5, data.length); r++) {
		if (!data[r]) continue;
		const c = pos.col;
		const firstCell = String(data[r][c] || '').replace(/\s/g, '');
		const rowStr = data[r].map(v => String(v || '')).join(' ');
		console.log(`[AutoReport]   row=${r}, col[${c}]="${firstCell}", rowStr="${rowStr.substring(0, 60)}..."`);
		// 한글 이름(2~4자)이 나타나면 데이터 시작
		if (/^[가-힣]{2,4}$/.test(firstCell)) {
			dataStartRow = r;
			console.log(`[AutoReport]   → 데이터 시작 행: ${r} (firstCell="${firstCell}")`);
			break;
		}
	}
	console.log(`[AutoReport] ${pos.type} dataStartRow=${dataStartRow}`);

	let sectionEnd = data.length;
	for (const other of allPositions) {
		if (other.row > pos.row) {
			sectionEnd = other.row;
			break;
		}
	}

	for (let row = dataStartRow; row < sectionEnd; row++) {
		if (!data[row]) continue;
		const rowData = data[row];
		const rowStr = rowData.map(c => String(c || '')).join(' ');

		// 스팟/스크롤 건수 — A열(첫 번째 컬럼)만 검사
		// J열(시스템 점검 사항) 메모에 "스크롤 송출" 등이 포함될 수 있으므로 전체 rowStr 매칭 금지
		const firstColStr = String(rowData[pos.col] || '');
		if (firstColStr.match(/스팟\s*송출/)) {
			const spotNum = rowStr.match(/[:：]?\s*(\d+)/);
			if (spotNum) result.spotCount = parseInt(spotNum[1]);
			continue;
		}

		if (firstColStr.match(/스크롤\s*송출/)) {
			const scrollNum = rowStr.match(/[:：]?\s*(\d+)/);
			if (scrollNum) result.scrollCount = parseInt(scrollNum[1]);
			continue;
		}

		// 데이터 행 파싱 — pos.col 기준 상대 오프셋
		const c = pos.col;
		const workerName = cleanCell(rowData[c + 0]);
		const category = cleanCell(rowData[c + 1]);
		const pgmName = cleanCell(rowData[c + 2]);
		const startH = parseNum(rowData[c + 3]);
		const startM = parseNum(rowData[c + 4]);
		// c+5 = "~" (스킵)
		const endH = parseNum(rowData[c + 6]);
		const endM = parseNum(rowData[c + 7]);
		const duration = parseNum(rowData[c + 8]);

		if (workerName && /^[가-힣]{2,4}$/.test(workerName)) {
			if (!result.workers.includes(workerName)) {
				result.workers.push(workerName);
			}
		}

		// 우암산/ON-AIR/MONITOR 키워드 행은 프로그램이 아닌 notes로 처리
		if (rowStr.match(/우암산|ON-AIR|MONITOR/i)) {
			result.notes.push(rowStr.trim());
			continue;
		}

		// 프로그램 행 유효성 검증 — 순수 숫자(스팟/스크롤 건수)인 행 제외
		const catClean = (category || '').replace(/\s/g, '');
		const pgmClean = (pgmName || '').replace(/\s/g, '');
		const isValidProgram = (catClean && !/^\d+$/.test(catClean)) || (pgmClean && !/^\d+$/.test(pgmClean));

		if (isValidProgram) {
			result.programs.push({
				worker: workerName || '',
				category: category,
				pgmName: pgmName,
				start: formatTime(startH, startM),
				end: formatTime(endH, endM),
				duration: duration || 0,
				startH, startM, endH, endM
			});
		}
	}

	return result;
}

// 일근 섹션 (별도 구조)
// 일근 아래에는 "특이사항"과 "일일통계" 테이블이 있다.
// 특이사항만 추출하고 통계 테이블 헤더는 무시한다.
function parseIlgeunSection(data, pos) {
	const result = {
		type: '일근',
		workers: [],
		programs: [],
		spotCount: 0,
		scrollCount: 0,
		notes: []
	};

	// 통계 테이블 헤더로 판단되는 키워드 (이런 텍스트가 포함된 행은 스킵)
	const statsKeywords = [
		'뉴스홀', '교양홀', '공개홀', '본사참여', '스팟', '스크롤',
		'녹화', '특집', '일일통계', '기타', '고정'
	];

	for (let row = pos.row + 1; row < Math.min(pos.row + 10, data.length); row++) {
		if (!data[row]) continue;
		const rowStr = data[row].map(c => String(c || '')).join(' ').trim();
		if (!rowStr || rowStr.length <= 1) continue;

		// 숫자/대시만 있는 행 스킵
		const cleaned = rowStr.replace(/\s/g, '');
		if (/^\d+$/.test(cleaned) || /^-+$/.test(cleaned)) continue;

		// 통계 테이블 헤더 스킵 — 공백 제거 후 비교 (엑셀에서 "스 팟" 등 공백 포함)
		const isStatsRow = statsKeywords.some(kw => cleaned.includes(kw));
		if (isStatsRow) continue;

		// 의미 있는 특기사항만 추가 (예: "0 한창희, 정지영, 이승주 휴가")
		result.notes.push(rowStr);
	}

	return result;
}

// ============================================================================
// 유틸리티
// ============================================================================
function cleanCell(val) {
	if (val === undefined || val === null) return '';
	return String(val).trim();
}

function parseNum(val) {
	if (val === undefined || val === null || val === '') return 0;
	const num = parseInt(String(val).trim());
	return isNaN(num) ? 0 : num;
}

function formatTime(h, m) {
	if (!h && !m) return '';
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function formatParsedData(parsed) {
	let output = `📅 ${parsed.date.iso} ${parsed.date.weekday}\n\n`;
	for (const shift of parsed.shifts) {
		output += `━━ ${shift.type} ━━\n`;
		output += `근무자: ${shift.workers.join(', ')}\n`;
		for (const pgm of shift.programs) {
			output += `  ${pgm.worker || '　　　'} | ${pgm.category} | ${pgm.pgmName} | ${pgm.start}~${pgm.end} | ${pgm.duration}분\n`;
		}
		output += `스팟: ${shift.spotCount}건, 스크롤: ${shift.scrollCount}건\n\n`;
	}
	return output;
}
