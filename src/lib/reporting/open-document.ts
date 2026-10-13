import type { ReportResult } from './contracts.generated';

/** Library navigation hands documents to their normal editors; it never runs them. */
export const OPEN_LIBRARY_DOCUMENT = 'cupola:open-library-document';
export interface LibraryDocumentRequest {
  record: ReportResult;
  libraryUrl: string;
  authScope?: string;
  localScope?: string;
  pinned: boolean;
  recoveryOnly?: boolean;
}
export interface LibraryDocumentNavigation extends LibraryDocumentRequest { token: number }
export function openLibraryDocument(request: LibraryDocumentRequest) {
  window.dispatchEvent(new CustomEvent(OPEN_LIBRARY_DOCUMENT, { detail: request }));
}
