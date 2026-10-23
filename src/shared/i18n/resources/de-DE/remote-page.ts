import { zh_cn_remote_page } from "../zh-CN/remote-page";
import type { LocaleMessageSchema } from "../../types";

export const de_de_remote_page = {
  title: "Remote",
  subtitle:
    "Website-Zugangsdaten verwalten, Romanquelle synchronisieren und Projektübersetzungen übertragen",
  load_failed: "Remote-Status konnte nicht gelesen werden …",
  auth: {
    title: "Website-Verbindung",
    description:
      "n.novelia.cc-Zugangsdaten über die ntr-toolbox-Brücke oder manuell einfügen; nur die Token-Endung wird angezeigt.",
    origin: "Website-Adresse",
    token: "Website-Token oder Cookie",
    token_placeholder: "Token, Cookie-Zeichenkette oder auth-JSON aus localStorage einfügen",
    import: "Zugangsdaten importieren",
    imported: "Zugangsdaten gespeichert",
    import_failed: "Import der Zugangsdaten fehlgeschlagen …",
    clear: "Diese Website löschen",
    clear_all: "Alle löschen",
    clear_failed: "Löschen der Zugangsdaten fehlgeschlagen …",
    empty: "Noch keine Website-Zugangsdaten gespeichert.",
    token_tail: "Endung {TAIL}",
    source: {
      bridge: "Brücke",
      manual: "Manuell",
    },
    bridge: {
      running: "Brücke lauscht",
      stopped: "Brücke gestoppt",
      stopped_hint:
        "Brücke aktivieren, um auf 127.0.0.1:7331–7341 Token-Pushes von ntr-toolbox zu empfangen.",
      enable: "Brücke aktivieren",
      disable: "Brücke deaktivieren",
      failed: "Umschalten der Brücke fehlgeschlagen …",
    },
  },
  source: {
    title: "Romanquelle",
    description:
      "Eine vollständige Synchronisierung lädt den Websitetext neu und behält passende Projektübersetzungen anhand des Inhalts.",
    unbound: "Dieses Projekt ist an keine Roman-URL gebunden. Wähle beim Erstellen „Roman-URL“.",
    novel: "Werk",
    url: "URL",
    asset: "Projektdatei",
    chapters: "Kapitel",
    last_synced: "Zuletzt synchronisiert",
    snapshot: "Synchronisierungs-Snapshot",
    snapshot_present: "Verfügbar",
    snapshot_missing: "Fehlt (geringere Ausrichtungsgenauigkeit)",
    preview: "Synchronisierung prüfen",
    preview_failed: "Synchronisierungsvorschau fehlgeschlagen …",
    stale_asset:
      "Der Projekttext weicht vom letzten Snapshot ab; die Synchronisierung richtet sich am aktuellen Text aus und meldet die Abweichung.",
    no_snapshot: "Kein früherer Snapshot; der aktuelle Projekttext dient als Grundlage.",
    stats: {
      added: "Hinzugefügt",
      modified: "Geändert",
      removed: "Entfernt",
      inherited: "Übernommen",
      would_lose: "Gefährdete Übersetzungen",
    },
    alignment_required:
      "Zu viel Text wurde geändert; der automatische Modus ist deaktiviert. Wähle „Nur anhängen“ oder „Manuell prüfen“.",
    preamble: "Vorspann",
    chapter_status: {
      unchanged: "Unverändert",
      modified: "Geändert",
      added: "Hinzugefügt",
      removed: "Entfernt",
      ambiguous: "Zu prüfen",
    },
    mode: {
      label: "Synchronisierungsmodus",
      add_only: "Nur anhängen",
      auto: "Automatisch",
      manual: "Manuell prüfen",
      add_only_hint:
        "Neue Kapitel am Ende anhängen; Änderungen an bestehenden Kapiteln werden übersprungen.",
      auto_hint:
        "Alte Übersetzungen nach Ähnlichkeit behalten; über dem Verlustschwellwert ist ein anderer Modus erforderlich.",
      manual_hint: "Zeilen pro Kapitel prüfen und jede Zeile behalten oder neu übersetzen.",
    },
    apply: "Synchronisierung anwenden",
    applied: "Synchronisierung abgeschlossen; {SKIPPED} geänderte Kapitel übersprungen.",
    apply_failed: "Anwenden der Synchronisierung fehlgeschlagen …",
    keep: "Behalten",
    retranslate: "Neu übersetzen",
  },
  workspace: {
    title: "Übertragung in den Arbeitsbereich",
    description:
      "Bestehende Übersetzungen zuerst; fehlende Zeilen werden mit dem aktuellen Modell übersetzt und anschließend jedes Kapitel vollständig übertragen.",
    start_missing: "Fehlende ergänzen und übertragen",
    start_all: "Alles neu übersetzen und übertragen",
    cancel: "Stoppen",
    start_failed: "Start der Arbeitsbereich-Übertragung fehlgeschlagen …",
    status_label: "Status",
    uploaded: "Übertragen",
    skipped: "Übersprungen",
    failed: "Fehlgeschlagen",
    existing: "{COUNT} vorhanden",
    translated: "{COUNT} übersetzt",
    status: {
      idle: "Bereit",
      running: "Wird übertragen",
      completed: "Abgeschlossen",
      failed: "Fehlgeschlagen",
      cancelled: "Gestoppt",
    },
    chapter_state: {
      pending: "Ausstehend",
      working: "In Arbeit",
      uploaded: "Übertragen",
      skipped: "Übersprungen",
      failed: "Fehlgeschlagen",
    },
  },
} satisfies LocaleMessageSchema<typeof zh_cn_remote_page>;
