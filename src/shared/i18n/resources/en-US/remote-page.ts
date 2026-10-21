import { zh_cn_remote_page } from "../zh-CN/remote-page";
import type { LocaleMessageSchema } from "../../types";

export const en_us_remote_page = {
  title: "Remote",
  subtitle: "Manage site credentials, sync the novel source, and submit project translations",
  load_failed: "Failed to read remote status …",
  auth: {
    title: "Site connection",
    description:
      "Sync n.novelia.cc credentials through the ntr-toolbox bridge or paste them manually; only the token tail is shown.",
    origin: "Site origin",
    token: "Site token or cookie",
    token_placeholder: "Paste a token, cookie string, or the localStorage auth JSON",
    import: "Import credential",
    imported: "Credential saved",
    import_failed: "Failed to import credential …",
    clear: "Clear this site",
    clear_all: "Clear all",
    clear_failed: "Failed to clear credentials …",
    empty: "No site credential saved yet.",
    token_tail: "tail {TAIL}",
    source: {
      bridge: "bridge",
      manual: "manual",
    },
    bridge: {
      running: "Bridge listening",
      stopped: "Bridge stopped",
      stopped_hint:
        "Enable the bridge to listen on 127.0.0.1:7331–7341 for ntr-toolbox token pushes.",
      enable: "Enable bridge",
      disable: "Disable bridge",
      failed: "Failed to toggle the bridge …",
    },
  },
  source: {
    title: "Novel source",
    description:
      "A full sync re-downloads the site text and keeps matching project translations by content.",
    unbound: "This project is not bound to a novel URL. Choose “Novel URL” when creating it.",
    novel: "Novel",
    url: "URL",
    asset: "Project file",
    chapters: "Chapters",
    last_synced: "Last synced",
    snapshot: "Sync snapshot",
    snapshot_present: "Available",
    snapshot_missing: "Missing (lower alignment precision)",
    preview: "Preview sync",
    preview_failed: "Failed to read the sync preview …",
    stale_asset:
      "The project source differs from the last sync snapshot; this sync aligns against the current text and reports the difference.",
    no_snapshot: "No previous snapshot; the current project text is used as the base.",
    stats: {
      added: "Added",
      modified: "Modified",
      removed: "Removed",
      inherited: "Inherited",
      would_lose: "Translations at risk",
    },
    alignment_required:
      "Too much text changed, so automatic mode is disabled; choose “Append only” or “Manual review”.",
    preamble: "Front matter",
    chapter_status: {
      unchanged: "Unchanged",
      modified: "Modified",
      added: "Added",
      removed: "Removed",
      ambiguous: "Needs review",
    },
    mode: {
      label: "Sync mode",
      add_only: "Append only",
      auto: "Automatic",
      manual: "Manual review",
      add_only_hint:
        "Append new chapters to the end; upstream changes to existing chapters are skipped.",
      auto_hint:
        "Keep old translations by similarity; above the loss threshold another mode is required.",
      manual_hint: "Review rows per chapter and keep or retranslate each line.",
    },
    apply: "Apply sync",
    applied: "Sync complete; skipped {SKIPPED} modified chapters.",
    apply_failed: "Failed to apply the sync …",
    keep: "Keep",
    retranslate: "Retranslate",
  },
  workspace: {
    title: "Workspace submission",
    description:
      "Existing translations come first; missing lines are translated with the current model, then each chapter is uploaded whole.",
    start_missing: "Fill missing and submit",
    start_all: "Retranslate all and submit",
    cancel: "Stop",
    start_failed: "Failed to start workspace submission …",
    status_label: "Status",
    uploaded: "Uploaded",
    skipped: "Skipped",
    failed: "Failed",
    existing: "{COUNT} existing",
    translated: "{COUNT} translated",
    status: {
      idle: "Idle",
      running: "Submitting",
      completed: "Completed",
      failed: "Failed",
      cancelled: "Stopped",
    },
    chapter_state: {
      pending: "Pending",
      working: "Working",
      uploaded: "Uploaded",
      skipped: "Skipped",
      failed: "Failed",
    },
  },
} satisfies LocaleMessageSchema<typeof zh_cn_remote_page>;
