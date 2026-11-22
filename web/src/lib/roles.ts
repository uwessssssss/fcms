/**
 * Who sees the whole company rather than one station. ONE list, matching the
 * API's (BooksService / StatementService: DIRECTOR, HEAD_OFFICE, AUDITOR,
 * SYSTEM_ADMIN). It was copied in seven places here, all without AUDITOR, so
 * an auditor was treated as station staff while the API gave them every site.
 * Accepts the API's form (HEAD_OFFICE) and the session's (head-office).
 */
export const COMPANY_WIDE_ROLES = ['DIRECTOR', 'HEAD_OFFICE', 'AUDITOR', 'SYSTEM_ADMIN'] as const;

export function isCompanyWide(role: string | null | undefined): boolean {
  if (!role) return false;
  const r = role.toUpperCase().replace(/-/g, '_');
  return (COMPANY_WIDE_ROLES as readonly string[]).includes(r);
}
