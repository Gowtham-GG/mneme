import { supabase } from '@/lib/supabase'
import { toError } from './errors'

/** Public ID of the journal page for local day `day` ('YYYY-MM-DD'), created on first open. */
export async function openJournal(day: string): Promise<string> {
  const { data, error } = await supabase.rpc('open_journal', { p_day: day })
  if (error) throw toError(error)
  return data as string
}
