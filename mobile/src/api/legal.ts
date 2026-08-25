import { supabase } from '@/lib/supabase';

export type LegalKind = 'terms' | 'privacy' | 'organizer_agreement' | 'cookies';

export interface LegalDocument {
  id: string;
  kind: LegalKind;
  version: string;
  locale: string;
  title: string;
  body: string;
  published_at: string | null;
}

export interface LegalAcceptance {
  id: string;
  document_id: string;
  user_id: string;
  organization_id: string | null;
  accepted_at: string;
  countersigned_at: string | null;
}

/** The version that is live right now. Null before anything is published. */
export async function getLegalDocument(kind: LegalKind): Promise<LegalDocument | null> {
  const { data, error } = await supabase.rpc('current_legal_document', {
    p_kind: kind,
    p_locale: 'sk',
  });
  if (error) throw error;
  return (data as LegalDocument) ?? null;
}

/**
 * Records agreement to one exact version.
 *
 * Accepting again is not an error and does not move the timestamp: what matters
 * is when it was first agreed, and the database keeps that.
 */
export async function acceptLegalDocument(
  documentId: string,
  organizationId?: string | null,
): Promise<LegalAcceptance> {
  const { data, error } = await supabase.rpc('accept_legal_document', {
    p_document_id: documentId,
    p_organization_id: organizationId ?? null,
  });
  if (error) throw error;
  return data as LegalAcceptance;
}
