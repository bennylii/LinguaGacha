import type { zh_cn_expert_settings_page } from "../zh-CN/expert-settings-page";
import type { LocaleMessageSchema } from "../../types";
export const ko_kr_expert_settings_page = {
  title: "전문가 설정",
  fields: {
    agent_auto_resume_enabled: {
      title: "Agent 자동 재시도",
      description:
        "모델 또는 전송의 일시적인 오류(429, 503, 연결 끊김, 시간 초과 등)에서 같은 라운드를 자동으로 재시도합니다. 기본적으로 사용합니다" +
        "\n" +
        "400, 401, 403, 할당량, 결제, 인증 오류는 재시도하지 않습니다. 재시도할 때마다 새 모델 요청을 보냅니다",
    },
    agent_auto_resume_initial_delay: {
      title: "첫 재시도 간격(초)",
      description:
        "첫 자동 재시도 전 대기 시간입니다. 이후에는 2배씩 늘어납니다. 기본값은 5초입니다",
    },
    agent_auto_resume_max_delay: {
      title: "최대 재시도 간격(초)",
      description:
        "지수 백오프 대기 시간의 상한입니다. 도달하면 이 간격으로 계속 재시도합니다. 기본값은 300초입니다" +
        "\n" +
        "첫 재시도 간격보다 작으면 첫 재시도 간격을 사용합니다",
    },
    agent_auto_resume_max_attempts: {
      title: "최대 재시도 횟수",
      description: "연속 자동 재시도의 상한입니다. 0은 무제한을 뜻합니다. 기본값은 0입니다",
    },
    preceding_lines_threshold: {
      title: "참고할 앞선 문맥의 최대 줄 수",
      description:
        "각 번역 작업에 포함할 수 있는 앞선 문맥의 최대 줄 수입니다. 기본적으로 사용하지 않습니다",
    },
    clean_ruby: {
      title: "원문의 후리가나 제거",
      description:
        "루비 주석의 독음을 제거하고 본문만 남깁니다. 기본적으로 사용하지 않습니다" +
        "\n" +
        "모델은 루비 주석을 제대로 이해하지 못하는 경우가 많아 제거하면 번역 품질을 높일 수 있습니다. 지원 형식의 예시:" +
        "\n" +
        "• <ruby>漢字<rt>かんじ</rt></ruby>" +
        "\n" +
        "• (漢字/かんじ) [漢字/かんじ] |漢字[かんじ]" +
        "\n" +
        "• \\r[漢字,かんじ] \\rb[漢字,かんじ] [r_かんじ][ch_漢字] [ch_漢字]" +
        "\n" +
        '• [ruby text=かんじ] [ruby text = かんじ] [ruby text="かんじ"] [ruby text = "かんじ"]',
    },
    deduplication_in_bilingual: {
      title: "대역 파일에서 원문과 번역문이 같으면 한 번만 출력",
      description:
        "자막과 전자책에서 원문과 번역문이 같으면 한 번만 출력합니다. 기본적으로 사용합니다",
    },
    write_translated_name_fields_to_file: {
      title: "이름 필드의 번역문을 출력 파일에 쓰기",
      description:
        "일부 <emphasis>GalGame</emphasis>의 이름 필드는 이미지·음성 파일과 연결됩니다. 이름 번역 시 오류가 나면 끄세요. 기본값은 사용입니다." +
        "\n" +
        "지원 형식:" +
        "\n" +
        "• RenPy에서 내보낸 게임 텍스트(.rpy)" +
        "\n" +
        "• VNTextPatch 또는 SExtractor에서 내보낸 name 필드가 있는 게임 텍스트(.json)",
    },
  },
  feedback: {
    agent_auto_resume_initial_delay_invalid:
      "첫 재시도 간격은 1에서 3600 사이의 정수 초로 입력해 주세요 …",
    agent_auto_resume_max_delay_invalid:
      "최대 재시도 간격은 1에서 86400 사이의 정수 초로 입력해 주세요 …",
    agent_auto_resume_max_attempts_invalid:
      "최대 재시도 횟수는 0에서 1000 사이의 정수로 입력해 주세요 …",
    preceding_lines_threshold_invalid:
      "앞선 문맥의 최대 줄 수에 유효한 범위의 숫자를 입력해 주세요 …",
  },
} satisfies LocaleMessageSchema<typeof zh_cn_expert_settings_page>;
