export const MAX_EXPORT_BYTES = 128 * 1024 * 1024 + 512 * 1024;
export const MAX_EXPORT_PIXELS = 32_000_000;
export interface ExportSettings { directory: string; defaultDirectory: string }
export interface SavedPng { path: string; bytes: number; width: number; height: number }
export interface ImageExportResult { saved?: SavedPng; saveError?: string; copied: boolean; copyError?: string }
