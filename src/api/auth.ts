import { supabase } from '@/lib/supabase'

export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
  return data
}

export async function signUp(email: string, password: string) {
  const { data, error } = await supabase.auth.signUp({
    email, password,
    // Send the confirmation link back to THIS app, not the project's default Site URL (Argus).
    options: { emailRedirectTo: window.location.origin },
  })
  if (error) throw error
  return data
}

export async function signOut() {
  const { error } = await supabase.auth.signOut()
  if (error) throw error
}

export async function resetPasswordForEmail(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin })
  if (error) throw error
}
