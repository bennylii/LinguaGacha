import { zh_cn_function_settings_page } from "../zh-CN/function-settings-page";
import type { LocaleMessageSchema } from "../../types";

export const de_de_function_settings_page = {
  title: "Funktionseinstellungen",
  fields: {
    source_language: {
      description: "Legt die Sprache des Eingabetexts fest",
    },
    target_language: {
      description: "Legt die Sprache des Ausgabetexts fest",
    },
    preceding_lines_threshold: {
      title: "Anzahl vorhergehender Kontexteinträge",
      description:
        "Legt fest, wie viele vorhergehende Texteinträge jede Aufgabe als Kontext enthält. Dies erhöht den Tokenverbrauch. Standardmäßig deaktiviert.",
    },
    following_lines_threshold: {
      title: "Anzahl nachfolgender Kontexteinträge",
      description:
        "Legt fest, wie viele nachfolgende Texteinträge jede Aufgabe als Kontext enthält. Dies erhöht den Tokenverbrauch. Standardmäßig deaktiviert.",
    },
    request_timeout: {
      title: "Anfrage-Timeout",
      description:
        "Maximale Antwortzeit in Sekunden. Ohne Antwort innerhalb dieser Frist gilt die Aufgabe als fehlgeschlagen.",
    },
    project_save_mode: {
      title: "Projekt-Speicherort",
      description:
        "Legt den Speicherort für Projektdateien beim Erstellen eines neuen Projekts fest",
      options: {
        manual: "Jedes Mal auswählen",
        fixed: "Fester Ordner",
        source: "Neben den Quelldateien",
      },
    },
    translation_save_mode: {
      title: "Speicherort der Übersetzung",
      description:
        "Legt den Speicherort für Übersetzungsdateien beim Erstellen der Übersetzung fest",
      options: {
        manual: "Jedes Mal auswählen",
        fixed: "Fester Ordner",
        project: "Neben der Projektdatei",
      },
    },
    output_folder_open_on_finish: {
      title: "Ausgabeordner öffnen, wenn die Übersetzungsdatei erstellt wurde",
      description:
        "Wenn aktiviert, wird der Ausgabeordner geöffnet, nachdem die übersetzte Datei erfolgreich erstellt wurde",
    },
    network_proxy_mode: {
      title: "Netzwerkproxy",
      description:
        "Legt fest, wie Modellanfragen und Websuche einen Proxy verwenden. Änderungen gelten sofort für spätere Anfragen",
      options: {
        system: "Systemproxy verwenden",
        proxy: "Eigener Proxy",
        direct: "Direkte Verbindung",
      },
    },
    network_proxy_address: {
      title: "Proxyadresse",
      description: "Adresse für den eigenen Proxy im Format Host:Port, zum Beispiel 127.0.0.1:6789",
    },
    agent_term_lookup_enabled: {
      title: "Agent-Begriffssuche",
      description:
        "Agent darf Wikipedia, Wiktionary, Jotoba und ein lokales JMdict-Paket gebräuchlicher Wörter abfragen. Nur öffentliche Quellen; Projektdateien werden weder gelesen noch geändert. Standardmäßig aktiviert",
    },
    agent_auto_resume_enabled: {
      title: "Automatischer Neuversuch für Agent",
      description:
        "Denselben Durchlauf bei vorübergehenden Modell- oder Transportfehlern (429, 503, Verbindungsabbrüche, Zeitüberschreitungen) automatisch wiederholen, standardmäßig aktiviert" +
        "\n" +
        "400, 401, 403, Kontingent-, Abrechnungs- und Authentifizierungsfehler werden nie wiederholt; jeder Neuversuch startet eine neue Modellanfrage",
    },
    agent_auto_resume_initial_delay: {
      title: "Erste Wartezeit vor Neuversuch (Sekunden)",
      description:
        "Wartezeit vor dem ersten automatischen Neuversuch; jede weitere verdoppelt sich, Standard 5 Sekunden",
    },
    agent_auto_resume_max_delay: {
      title: "Maximale Wartezeit vor Neuversuch (Sekunden)",
      description:
        "Obergrenze für das exponentielle Backoff; danach wird in diesem Abstand weiter versucht, Standard 300 Sekunden" +
        "\n" +
        "Ist der Wert kleiner als die erste Wartezeit, gilt die erste Wartezeit",
    },
    agent_auto_resume_max_attempts: {
      title: "Maximale Anzahl Neuversuche",
      description:
        "Obergrenze für aufeinanderfolgende automatische Neuversuche; 0 bedeutet unbegrenzt, Standard 0",
    },
    agent_auto_continue_enabled: {
      title: "Automatisches Fortsetzen für Agent",
      description:
        "Nach dem erfolgreichen Abschluss eines Durchlaufs öffnet das Backend einen eigenen Prüf-Thread, um zu prüfen, ob die Aufgabe wirklich erledigt ist, und setzt sie sonst automatisch fort; standardmäßig deaktiviert" +
        "\n" +
        "Jede Prüfung kostet eine zusätzliche Modellanfrage; eine fehlgeschlagene Prüfung oder ein unlesbares Ergebnis zählt als erledigt, es wird also nichts automatisch fortgesetzt",
    },
    agent_auto_continue_max_continues: {
      title: "Maximale Anzahl automatischer Fortsetzungen",
      description:
        "Obergrenze für aufeinanderfolgende automatische Fortsetzungen in einem Durchlauf; 0 bedeutet unbegrenzt, Standard 10",
    },
  },
  feedback: {
    preceding_lines_threshold_invalid:
      "Die Anzahl vorhergehender Kontexteinträge muss eine ganze Zahl von 0 bis 9999999 sein …",
    following_lines_threshold_invalid:
      "Die Anzahl nachfolgender Kontexteinträge muss eine ganze Zahl von 0 bis 9999999 sein …",
    request_timeout_invalid:
      "Das Anfrage-Timeout muss eine Zahl innerhalb des gültigen Bereichs sein …",
    pick_directory_failed:
      "Ordnerauswahl fehlgeschlagen. Bitte wählen Sie das feste Speicherverzeichnis erneut aus …",
    network_proxy_address_invalid: "Die Proxyadresse muss im Format Host:Port angegeben werden …",
    agent_auto_resume_initial_delay_invalid:
      "Die erste Wartezeit muss eine ganze Zahl von 1 bis 3600 Sekunden sein …",
    agent_auto_resume_max_delay_invalid:
      "Die maximale Wartezeit muss eine ganze Zahl von 1 bis 86400 Sekunden sein …",
    agent_auto_resume_max_attempts_invalid:
      "Die maximale Anzahl Neuversuche muss eine ganze Zahl von 0 bis 1000 sein …",
    agent_auto_continue_max_continues_invalid:
      "Die maximale Anzahl automatischer Fortsetzungen muss eine ganze Zahl von 0 bis 1000 sein …",
  },
} satisfies LocaleMessageSchema<typeof zh_cn_function_settings_page>;
