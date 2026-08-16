// ============================================================================
// config.example.js — AutoReport 환경 설정 템플릿
// ============================================================================
// 본 파일은 오픈소스/수업용 템플릿입니다.
// 실제 사용 시 본 파일을 복사하여 'config.js'로 이름을 변경한 후
// 사내 전담 관리자나 강사가 제공한 실제 인증 키 정보를 입력하세요.
//
// ⚠️ 주의: 실제 키가 입력된 'config.js'는 절대로 GitHub 등에 커밋하지 마세요! (.gitignore 등록됨)
// ============================================================================

export const CONFIG = {
	// -----------------------------------------------------------------------
	// 1. Google Sheets API 연동 설정 (약칭 및 근무표 조회용)
	// -----------------------------------------------------------------------
	GOOGLE_SHEETS: {
		// 대상 Google Spreadsheet 고유 ID
		SHEET_ID: "YOUR_GOOGLE_SPREADSHEET_ID",

		// Google Cloud API Key (필요시)
		API_KEY: "YOUR_GOOGLE_API_KEY",

		// Google Cloud 서비스 계정 (Service Account) 이메일
		SERVICE_ACC: "your-service-account@your-project-id.iam.gserviceaccount.com",

		// 서비스 계정 비공개 키 ID (kid)
		PRIVATE_KID: "YOUR_PRIVATE_KEY_ID",

		// 서비스 계정 RSA Private Key (PEM 형식)
		PRIVATE_PEM: `-----BEGIN PRIVATE KEY-----
YOUR_PRIVATE_KEY_HERE
-----END PRIVATE KEY-----`
	},

	// -----------------------------------------------------------------------
	// 2. TVDSS (편성확인시스템) 연동 설정
	// -----------------------------------------------------------------------
	TVDSS: {
		// TVDSS 공용 로그인 계정
		USERNAME: "YOUR_TVDSS_USERNAME",
		// TVDSS 공용 로그인 비밀번호
		PASSWORD: "YOUR_TVDSS_PASSWORD"
	},

	// -----------------------------------------------------------------------
	// 3. ERP 기본 조직 코드
	// -----------------------------------------------------------------------
	ERP: {
		ZORGEH: "50021098" // 소속 부서 조직 코드 (기본값: 청주 기술국)
	}
};
