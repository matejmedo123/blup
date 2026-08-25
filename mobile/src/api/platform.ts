import { supabase } from '@/lib/supabase';

/**
 * Who runs this deployment.
 *
 * Read from `platform_settings`, which is world-readable, so the footer can say
 * it on every page. Everything is nullable on purpose: the columns start empty
 * and the footer prints only what an operator has actually filled in — an
 * invented company in a footer is worse than no footer.
 */
export interface OperatorInfo {
  name: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  registrationNo: string | null;
  vatNo: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
}

export async function getOperatorInfo(): Promise<OperatorInfo> {
  const { data, error } = await supabase
    .from('platform_settings')
    .select(
      'operator_name, operator_address, operator_city, operator_country, ' +
      'operator_reg_no, operator_vat_no, operator_email, operator_phone, operator_website',
    )
    .maybeSingle();

  if (error) throw error;

  const row = (data ?? {}) as Record<string, string | null>;
  return {
    name: row.operator_name ?? null,
    address: row.operator_address ?? null,
    city: row.operator_city ?? null,
    country: row.operator_country ?? null,
    registrationNo: row.operator_reg_no ?? null,
    vatNo: row.operator_vat_no ?? null,
    email: row.operator_email ?? null,
    phone: row.operator_phone ?? null,
    website: row.operator_website ?? null,
  };
}
