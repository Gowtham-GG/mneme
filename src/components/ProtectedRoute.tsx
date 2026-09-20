import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth()
  const loc = useLocation()
  if (loading) return <div className="flex h-full items-center justify-center text-sm text-faint">Opening Mneme…</div>
  if (!session) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />
  return <>{children}</>
}
