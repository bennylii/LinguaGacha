import type { zh_cn_function_settings_page } from "../zh-CN/function-settings-page";
import type { LocaleMessageSchema } from "../../types";
export const ko_kr_function_settings_page = {
  title: "기능 설정",
  fields: {
    source_language: {
      description: "입력 텍스트 언어를 설정합니다",
    },
    target_language: {
      description: "출력 텍스트 언어를 설정합니다",
    },
    preceding_lines_threshold: {
      title: "참고할 앞선 문맥의 항목 수",
      description:
        "각 작업에 참고용으로 포함할 앞선 문맥의 텍스트 항목 수를 설정합니다. 토큰 사용량이 증가합니다. 기본적으로 비활성화됩니다.",
    },
    following_lines_threshold: {
      title: "참고할 뒤따르는 문맥의 항목 수",
      description:
        "각 작업에 참고용으로 포함할 뒤따르는 문맥의 텍스트 항목 수를 설정합니다. 토큰 사용량이 증가합니다. 기본적으로 비활성화됩니다.",
    },
    request_timeout: {
      title: "요청 제한 시간",
      description:
        "모델 응답을 기다리는 최대 시간(초)입니다. 시간 내에 응답이 없으면 작업을 실패로 처리합니다",
    },
    project_save_mode: {
      title: "프로젝트 파일 저장 위치",
      description: "새 프로젝트를 만들 때 프로젝트 파일을 저장할 위치를 설정합니다",
      options: {
        manual: "매번 직접 선택",
        fixed: "지정 폴더",
        source: "원본 파일과 같은 폴더",
      },
    },
    translation_save_mode: {
      title: "번역 파일 저장 위치",
      description: "번역문을 생성할 때 번역 파일을 저장할 위치를 설정합니다",
      options: {
        manual: "매번 직접 선택",
        fixed: "지정 폴더",
        project: "프로젝트 파일과 같은 폴더",
      },
    },
    output_folder_open_on_finish: {
      title: "번역문 파일 생성 후 출력 폴더 열기",
      description: "번역문 파일이 생성되면 출력 폴더를 자동으로 엽니다",
    },
    network_proxy_mode: {
      title: "네트워크 프록시",
      description:
        "모델 요청과 웹 검색에 프록시를 사용하는 방식을 설정합니다. 변경 사항은 이후 요청에 바로 적용됩니다",
      options: {
        system: "시스템 프록시 사용",
        proxy: "프록시 직접 지정",
        direct: "직접 연결",
      },
    },
    network_proxy_address: {
      title: "프록시 주소",
      description:
        "프록시를 직접 지정할 때 사용하는 주소입니다. 호스트:포트 형식이며 예: 127.0.0.1:6789",
    },
    agent_term_lookup_enabled: {
      title: "Agent 용어 검색",
      description:
        "Agent가 Wikipedia, Wiktionary, Jotoba 및 로컬 JMdict 상용어 패키지를 조회할 수 있게 합니다. 공개 출처만 접근하며 프로젝트를 읽거나 수정하지 않습니다. 기본적으로 사용합니다",
    },
    agent_auto_resume_enabled: {
      title: "Agent 자동 재시도",
      description:
        "모델 또는 전송의 일시적 장애(429, 503, 연결 끊김, 시간 초과 등) 시 같은 라운드를 자동으로 재시도합니다. 기본적으로 사용합니다" +
        "\n" +
        "400, 401, 403, 할당량, 결제, 인증 오류는 재시도하지 않습니다. 재시도마다 새로운 모델 요청을 보냅니다",
    },
    agent_auto_resume_initial_delay: {
      title: "첫 재시도 간격(초)",
      description: "첫 자동 재시도 전 대기 시간입니다. 이후 매번 2배로 늘어나며 기본값은 5초입니다",
    },
    agent_auto_resume_max_delay: {
      title: "최대 재시도 간격(초)",
      description:
        "지수 백오프의 대기 상한입니다. 도달하면 해당 간격으로 계속 재시도하며 기본값은 300초입니다" +
        "\n" +
        "첫 재시도 간격보다 작으면 첫 재시도 간격으로 실행합니다",
    },
    agent_auto_resume_max_attempts: {
      title: "최대 재시도 횟수",
      description: "연속 자동 재시도 횟수 상한입니다. 0이면 무제한이며 기본값은 0입니다",
    },
    agent_auto_continue_enabled: {
      title: "Agent 자동 계속",
      description:
        "한 라운드가 정상 종료된 뒤 백엔드가 별도 판정 스레드로 작업이 실제로 끝났는지 확인하고, 끝나지 않았으면 자동으로 계속을 보냅니다. 기본적으로 사용하지 않습니다" +
        "\n" +
        "판정마다 모델 요청이 한 번 더 발생합니다. 판정에 실패하거나 결론을 해석할 수 없으면 완료로 처리하며 자동 계속하지 않습니다",
    },
    agent_auto_continue_max_continues: {
      title: "최대 자동 계속 횟수",
      description:
        "한 라운드 안에서 연속 자동 계속하는 횟수 상한입니다. 0이면 무제한이며 기본값은 10입니다",
    },
  },
  feedback: {
    preceding_lines_threshold_invalid:
      "참고할 앞선 문맥의 항목 수는 0에서 9999999 사이의 정수여야 합니다 …",
    following_lines_threshold_invalid:
      "참고할 뒤따르는 문맥의 항목 수는 0에서 9999999 사이의 정수여야 합니다 …",
    request_timeout_invalid: "요청 제한 시간에 유효한 범위의 숫자를 입력해 주세요 …",
    pick_directory_failed: "폴더를 선택하지 못했습니다. 지정 저장 폴더를 다시 선택해 주세요 …",
    network_proxy_address_invalid: "프록시 주소는 호스트:포트 형식으로 입력해 주세요 …",
    agent_auto_resume_initial_delay_invalid:
      "첫 재시도 간격은 1에서 3600 사이의 정수 초여야 합니다 …",
    agent_auto_resume_max_delay_invalid:
      "최대 재시도 간격은 1에서 86400 사이의 정수 초여야 합니다 …",
    agent_auto_resume_max_attempts_invalid:
      "최대 재시도 횟수는 0에서 1000 사이의 정수여야 합니다 …",
    agent_auto_continue_max_continues_invalid:
      "최대 자동 계속 횟수는 0에서 1000 사이의 정수여야 합니다 …",
  },
} satisfies LocaleMessageSchema<typeof zh_cn_function_settings_page>;
